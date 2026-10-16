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
