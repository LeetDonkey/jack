import type { LogRecord } from '~/types/management'

/**
 * The log records the Logs page has taken in, from the backfill and from the
 * stream. A backfill fetched after a reconnect then adds only the lines that
 * were missed, and a line that arrives both ways shows once. Lines the user
 * cleared from view count as taken, so they don't come back.
 */
export class LogTail {
  private readonly keys = new Set<string>()
  private readonly order: string[] = []
  private newest: number | undefined

  // Remembers this many records. More than a backfill holds (500 lines), so a
  // backfill can always be matched against what was taken before it.
  constructor(private readonly capacity = 4_000) {}

  /** Takes the record unless it was taken before. Returns whether it is new. */
  take(record: LogRecord): boolean {
    // Both ways deliver the same parsed line, so equal JSON means the same line.
    const key = JSON.stringify(record)
    if (this.keys.has(key))
      return false
    this.keys.add(key)
    this.order.push(key)
    if (this.order.length > this.capacity)
      this.keys.delete(this.order.shift()!)
    if (typeof record.time === 'number' && (this.newest === undefined || record.time > this.newest))
      this.newest = record.time
    return true
  }

  /**
   * Whether a backfill of the last `lines` records, not taken yet, leaves out
   * lines logged since the newest record taken: it came back full, and even its
   * oldest record is newer than that one. Never true before anything was taken.
   */
  missesLines(records: LogRecord[], lines: number): boolean {
    if (this.newest === undefined || records.length < lines)
      return false
    const oldest = records.find(record => typeof record.time === 'number')?.time
    return typeof oldest === 'number' && oldest > this.newest
  }

  /**
   * The new records of a backfill (oldest to newest), now taken. Records older
   * than the newest one taken before are left out: they were seen, or cleared.
   */
  takeBackfill(records: LogRecord[]): LogRecord[] {
    const since = this.newest
    return records.filter(record =>
      (since === undefined || typeof record.time !== 'number' || record.time >= since) && this.take(record))
  }

  /**
   * Fetches and takes the lines not shown yet. `fetchLogs(n)` returns jack's
   * last n records. Asks for `lines`, and for `maxLines` when those leave a
   * hole. Returns undefined when `wanted()` turned false during a fetch (the
   * level filter changed); nothing is taken then.
   */
  async backfill(
    fetchLogs: (lines: number) => Promise<LogRecord[]>,
    { lines, maxLines, wanted = () => true }: { lines: number, maxLines: number, wanted?: () => boolean },
  ): Promise<{ records: LogRecord[], gap: boolean } | undefined> {
    let asked = lines
    let records = await fetchLogs(asked)
    if (!wanted())
      return undefined
    if (asked < maxLines && this.missesLines(records, asked)) {
      asked = maxLines
      records = await fetchLogs(asked)
      if (!wanted())
        return undefined
    }
    const gap = this.missesLines(records, asked)
    return { records: this.takeBackfill(records), gap }
  }

  reset(): void {
    this.keys.clear()
    this.order.length = 0
    this.newest = undefined
  }
}
