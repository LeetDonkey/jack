import type { PausedUntil } from '../../lib/config'
import type { PauseState, PauseTarget } from './pause'
import type { TransfersService } from './transfers.service'
import { PAUSE_INDEFINITE } from '../../lib/config'
import { ConflictError } from '../../lib/errors/ConflictError'
import { ValidationError } from '../../lib/validation'

/** Where pauses are stored: bandwidth.pausedUntil and downloads.pausedUntil (ConfigService). */
export interface PauseStore {
  updateBandwidth: (patch: { pausedUntil: PausedUntil | null }) => Promise<void>
  updateDownloads: (patch: { pausedUntil: PausedUntil | null }) => Promise<void>
  /** The stored bandwidth block, or undefined when there is none. */
  getBandwidth: () => { pausedUntil?: string | null } | undefined
  /** The stored downloads block, or null when downloads are off. */
  getRawDownloads: () => { pausedUntil?: string | null } | null
}

export interface PausesAnswer {
  ok: true
  paused: Record<PauseTarget, PauseState>
}

/**
 * POST /transfers/pause and /transfers/resume. A pause is written to the config
 * file, so it survives a restart, and ends by itself at its time.
 */
export class TransferPauses {
  constructor(
    private readonly store: PauseStore,
    private readonly transfers: Pick<TransfersService, 'refresh' | 'pauseState'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private answer(): PausesAnswer {
    // Apply the new pause right away (config saves also refresh, but not for
    // every caller or test).
    this.transfers.refresh()
    return { ok: true, paused: { uploads: this.transfers.pauseState('uploads'), downloads: this.transfers.pauseState('downloads') } }
  }

  private write(what: PauseTarget, pausedUntil: PausedUntil | null): Promise<void> {
    return what === 'uploads'
      ? this.store.updateBandwidth({ pausedUntil })
      : this.store.updateDownloads({ pausedUntil })
  }

  async pause(what: PauseTarget, until: PausedUntil): Promise<PausesAnswer> {
    if (until !== PAUSE_INDEFINITE && Date.parse(until) <= this.now().getTime())
      throw ValidationError.forField('until', 'The time to resume is in the past')
    if (what === 'downloads' && !this.store.getRawDownloads())
      throw new ConflictError('Downloads are off, so there are no downloads to pause')
    await this.write(what, until)
    return this.answer()
  }

  /**
   * Resume one direction, or both when `what` is absent. Only a stored pause is
   * cleared, so resuming what isn't paused leaves the config file alone.
   */
  async resume(what?: PauseTarget): Promise<PausesAnswer> {
    if (what !== 'downloads' && this.store.getBandwidth()?.pausedUntil != null)
      await this.write('uploads', null)
    if (what !== 'uploads' && this.store.getRawDownloads()?.pausedUntil != null)
      await this.write('downloads', null)
    return this.answer()
  }
}

/**
 * Keep a downloads service paused while downloads are paused: right away, for
 * a pause saved before a restart, and on every change after that.
 */
export function followDownloadsPause(
  transfers: Pick<TransfersService, 'pauseState' | 'onPauseChange'>,
  downloads: { setPaused: (paused: boolean) => void },
): () => void {
  downloads.setPaused(transfers.pauseState('downloads').paused)
  return transfers.onPauseChange((target, state) => {
    if (target === 'downloads')
      downloads.setPaused(state.paused)
  })
}
