import { describe, expect, test } from 'bun:test'
import { BandwidthConfig } from '../lib/config'
import { TransferMonitor } from '../modules/transfers/transfer-monitor'
import { TransfersService } from '../modules/transfers/transfers.service'

function manualMonitor() {
  let running = 0
  const monitor = new TransferMonitor({
    setInterval: () => {
      running++
      return running as any
    },
    clearInterval: () => {
      running--
    },
  })
  return { monitor, isTicking: () => running > 0 }
}

describe('TransferMonitor', () => {
  test('derives speed from the last ticks and an ETA from the remaining bytes', () => {
    const { monitor } = manualMonitor()
    const transfer = monitor.start({ direction: 'download', peer: 'Nicklas', filename: 'a.mkv', totalBytes: 10_000, offsetBytes: 1000 })
    for (const bytes of [1000, 2000, 3000]) {
      transfer.add(bytes)
      monitor.tick()
    }
    expect(monitor.list()).toMatchObject([{ transferredBytes: 7000, bytesPerSecond: 2000, etaSeconds: 2 }])
  })

  test('averages over the last five ticks only', () => {
    const { monitor } = manualMonitor()
    const transfer = monitor.start({ direction: 'upload', peer: 'p', filename: 'f' })
    transfer.add(100_000)
    monitor.tick()
    for (let i = 0; i < 5; i++) {
      transfer.add(10)
      monitor.tick()
    }
    expect(monitor.list()[0]?.bytesPerSecond).toBe(10)
    expect(monitor.list()[0]?.etaSeconds).toBeNull() // unknown size
  })

  test('a resume reset never shows negative speed', () => {
    const { monitor } = manualMonitor()
    const transfer = monitor.start({ direction: 'download', peer: 'p', filename: 'f', offsetBytes: 5000 })
    transfer.add(-5000)
    monitor.tick()
    expect(monitor.list()[0]?.bytesPerSecond).toBe(0)
  })

  test('ticks only while transfers are active and notifies on start, tick and end', () => {
    const { monitor, isTicking } = manualMonitor()
    let notifications = 0
    monitor.subscribe(() => notifications++)

    const a = monitor.start({ direction: 'download', peer: 'p', filename: 'a' })
    const b = monitor.start({ direction: 'upload', peer: 'p', filename: 'b' })
    expect(isTicking()).toBe(true)
    monitor.tick()
    a.end()
    a.end() // idempotent
    expect(isTicking()).toBe(true)
    b.end()
    expect(isTicking()).toBe(false)
    expect(notifications).toBe(5)
    expect(monitor.activeCount('download')).toBe(0)
  })
})

describe('TransfersService', () => {
  test('applies the scheduled limits to both limiters and reports them', () => {
    let bandwidth = BandwidthConfig.parse({ downloadLimitKiBps: 100, uploadLimitKiBps: 50, maxConcurrentUploads: 2 })
    const service = new TransfersService(() => bandwidth, () => 3, { now: () => new Date(2026, 9, 16, 12, 0) })

    expect(service.downloadLimiter.rate).toBe(100 * 1024)
    expect(service.uploadLimiter.rate).toBe(50 * 1024)
    expect(service.snapshot()).toMatchObject({
      download: { maxConcurrent: 3, limitBytesPerSecond: 100 * 1024 },
      upload: { maxConcurrent: 2, limitBytesPerSecond: 50 * 1024 },
      schedulePeriod: null,
    })

    bandwidth = BandwidthConfig.parse({ schedule: [{ days: ['fri'], start: '08:00', end: '18:00', uploadLimitKiBps: 10 }] })
    service.refresh()
    expect(service.downloadLimiter.rate).toBeNull()
    expect(service.uploadLimiter.rate).toBe(10 * 1024)
    expect(service.snapshot().schedulePeriod).toBe(0)
  })

  test('gates new uploads on maxConcurrentUploads', () => {
    const { monitor } = manualMonitor()
    const service = new TransfersService(() => BandwidthConfig.parse({ maxConcurrentUploads: 1 }), () => null, { monitor })

    expect(service.canStartUpload()).toBe(true)
    const upload = monitor.start({ direction: 'upload', peer: 'p', filename: 'f' })
    monitor.start({ direction: 'download', peer: 'p', filename: 'g' })
    expect(service.canStartUpload()).toBe(false)
    upload.end()
    expect(service.canStartUpload()).toBe(true)
  })

  test('no bandwidth config means no limits', () => {
    const service = new TransfersService(() => undefined, () => null)
    expect(service.canStartUpload()).toBe(true)
    expect(service.downloadLimiter.rate).toBeNull()
    expect(service.uploadLimiter.rate).toBeNull()
  })
})

describe('TransferMonitor across Range windows', () => {
  test('a restart with the same resumeKey continues the entry and keeps its speed', () => {
    let now = 0
    const monitor = new TransferMonitor({ setInterval: () => 1 as any, clearInterval: () => {} }, () => new Date(now))
    const first = monitor.start({ direction: 'upload', peer: 'Nicklas', filename: 'a.mkv', totalBytes: 100, party: 'key:1', resumeKey: 'key:1:item' })
    first.add(40)
    monitor.tick()
    first.end()

    // Between windows the entry stays listed but holds no slot.
    expect(monitor.list()).toHaveLength(1)
    expect(monitor.activeCount('upload')).toBe(0)

    now += 1000
    const second = monitor.start({ direction: 'upload', peer: 'Nicklas', filename: 'a.mkv', totalBytes: 100, offsetBytes: 40, party: 'key:1', resumeKey: 'key:1:item' })
    second.add(20)
    monitor.tick()

    const [entry] = monitor.list()
    expect(monitor.list()).toHaveLength(1)
    expect(entry).toMatchObject({ transferredBytes: 60, bytesPerSecond: 30 })
    expect(monitor.activeCount('upload', 'key:1')).toBe(1)
    expect(monitor.activeCount('upload', 'key:2')).toBe(0)
  })

  test('an ended entry disappears once the linger time has passed', () => {
    let now = 0
    const monitor = new TransferMonitor({ setInterval: () => 1 as any, clearInterval: () => {} }, () => new Date(now))
    monitor.start({ direction: 'upload', peer: 'p', filename: 'f', resumeKey: 'k' }).end()
    now += 6000
    expect(monitor.list()).toEqual([])
  })
})

describe('TransfersService per-friend upload limits', () => {
  const GiB = 1024 ** 3

  test('a friend at its own slot limit is refused while others still get a slot', () => {
    const { monitor } = manualMonitor()
    const service = new TransfersService(() => BandwidthConfig.parse({ maxConcurrentUploadsPerPeer: 1, maxConcurrentUploads: 3 }), () => null, { monitor })

    monitor.start({ direction: 'upload', peer: 'a', filename: 'f', party: 'key:1' })

    expect(service.uploadRefusal('key:1')).toMatchObject({ status: 503, retryAfterSeconds: 60 })
    expect(service.uploadRefusal('key:2')).toBeNull()
  })

  test('a friend past its daily limit waits until local midnight', () => {
    const { monitor } = manualMonitor()
    const now = new Date(2026, 9, 17, 23, 0, 0)
    const ledger = { bytesToday: (_d: string, party: string) => (party === 'key:1' ? 50 * GiB : 0) } as any
    const service = new TransfersService(() => BandwidthConfig.parse({ dailyUploadLimitGiBPerPeer: 50 }), () => null, { monitor, ledger, now: () => now })

    const refusal = service.uploadRefusal('key:1')

    expect(refusal).toMatchObject({ status: 429, message: 'Daily limit of 50 GiB reached' })
    expect(refusal!.retryAfterSeconds).toBe(3600)
    expect(service.uploadRefusal('key:2')).toBeNull()
  })
})
