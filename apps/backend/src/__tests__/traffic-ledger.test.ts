import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { TrafficLedger } from '../modules/transfers/traffic-ledger'

describe('TrafficLedger', () => {
  test('counts bytes per party and day, before and after a flush', () => {
    const sqlite = new Database(':memory:')
    let now = new Date(2026, 9, 17, 12, 0, 0)
    const ledger = new TrafficLedger(sqlite, () => now)

    ledger.add('out', 'key:1', 'Nicklas', 100)
    expect(ledger.bytesToday('out', 'key:1')).toBe(100)
    ledger.flush()
    ledger.add('out', 'key:1', 'Nicklas', 50)
    ledger.add('in', 'peer:abc', 'Nicklas', 7)
    expect(ledger.bytesToday('out', 'key:1')).toBe(150)

    now = new Date(2026, 9, 18, 0, 1, 0)
    ledger.add('out', 'key:1', 'Nicklas (new name)', 10)
    expect(ledger.bytesToday('out', 'key:1')).toBe(10)

    expect(ledger.totalsSince('2026-10-17')).toEqual([
      { direction: 'out', party: 'key:1', label: 'Nicklas (new name)', bytes: 160 },
      { direction: 'in', party: 'peer:abc', label: 'Nicklas', bytes: 7 },
    ])
    expect(ledger.totalsSince('2026-10-18')).toEqual([
      { direction: 'out', party: 'key:1', label: 'Nicklas (new name)', bytes: 10 },
    ])
  })
})
