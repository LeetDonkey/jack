import type { JackMeta } from '../../database/jack-meta'
import { DiscoveryConfig, SecurityConfig } from '../../lib/config'
import { NotFoundError } from '../../lib/errors/NotFoundError'
import { logger } from '../../logger'

/** Settings whose default changed in an update, as `<block>.<key>` in config.jsonc. */
export const CHANGED_DEFAULT_SETTINGS = ['discovery.introduce', 'security.banEnabled', 'security.lanOnlyArrApis', 'security.publicOpenApi'] as const
export type ChangedDefaultSetting = typeof CHANGED_DEFAULT_SETTINGS[number]

export interface ChangedDefault {
  setting: ChangedDefaultSetting
  /** What jack did before the update while the setting wasn't stored. */
  was: boolean
  /** The default now. */
  now: boolean
}

export interface SystemNotice {
  id: string
  kind: 'defaultsChanged'
  changed: ChangedDefault[]
}

/** The notice for installs from before the secure defaults (84471be); the last build without them is 8d40802. */
export const DEFAULTS_NOTICE_ID = 'defaults-2026-10'

// What 8d40802 did with the setting absent from config.jsonc:
// - introduce defaulted to true.
// - banEnabled defaulted to false.
// - lanOnlyArrApis didn't exist: /torznab and /api/v2 answered every address.
// - publicOpenApi didn't exist: /openapi.json was always served.
const OLD_BEHAVIOUR: Record<ChangedDefaultSetting, boolean> = {
  'discovery.introduce': true,
  'security.banEnabled': false,
  'security.lanOnlyArrApis': false,
  'security.publicOpenApi': true,
}

function currentDefaults(): Record<ChangedDefaultSetting, boolean> {
  const discovery = DiscoveryConfig.parse({})
  const security = SecurityConfig.parse({})
  return {
    'discovery.introduce': discovery.introduce,
    'security.banEnabled': security.banEnabled,
    'security.lanOnlyArrApis': security.lanOnlyArrApis,
    'security.publicOpenApi': security.publicOpenApi,
  }
}

/** The part of config.jsonc the notice reads, refs unresolved. */
export interface RawConfigBlocks {
  discovery?: Record<string, unknown> | null
  security?: Record<string, unknown> | null
}

/**
 * The settings whose behaviour changed for an install that never stored them.
 * A stored value (true or false) is the user's choice, so it drops out.
 */
export function changedDefaults(raw: RawConfigBlocks | null | undefined): ChangedDefault[] {
  const now = currentDefaults()
  return CHANGED_DEFAULT_SETTINGS.flatMap((setting) => {
    const [block, key] = setting.split('.') as ['discovery' | 'security', string]
    const stored = raw?.[block]?.[key]
    if (stored != null || OLD_BEHAVIOUR[setting] === now[setting])
      return []
    return [{ setting, was: OLD_BEHAVIOUR[setting], now: now[setting] }]
  })
}

// Written at the first boot of a jack that keeps jack_meta. A database without
// it, but with migrations, comes from an older jack.
const INSTALL_MARKER = 'install.firstBootAt'
const noticeKey = (id: string) => `notice.${id}`

type NoticeState = 'open' | 'dismissed'

/**
 * One-time notices for this install (overview.system.notices), until dismissed.
 * Today there is one: an install that existed before the secure defaults is
 * told which defaults changed under it.
 */
export class SystemNotices {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly meta: JackMeta,
    private readonly raw: () => RawConfigBlocks | null | undefined,
  ) {}

  /**
   * Once per boot, before anything reads the notices. `preexisting`: the
   * database had migrations applied before this boot. The first boot with this
   * code opens the notice for such an install; a new install never gets it.
   */
  init(preexisting: boolean, now: Date = new Date()): void {
    this.meta.transaction(() => {
      if (this.meta.get(INSTALL_MARKER) != null)
        return
      this.meta.set(INSTALL_MARKER, now.toISOString())
      if (!preexisting)
        return
      this.meta.set(noticeKey(DEFAULTS_NOTICE_ID), 'open' satisfies NoticeState)
      logger.info({ notice: DEFAULTS_NOTICE_ID }, 'This install is from before the secure defaults; the dashboard lists the defaults that changed')
    })
  }

  /** Open notices with something to say. */
  list(): SystemNotice[] {
    if (this.meta.get(noticeKey(DEFAULTS_NOTICE_ID)) !== 'open')
      return []
    const changed = changedDefaults(this.raw())
    return changed.length ? [{ id: DEFAULTS_NOTICE_ID, kind: 'defaultsChanged', changed }] : []
  }

  /** Hides a notice for good. Dismissing it again is fine; an id this install never had is NotFound. */
  dismiss(id: string): void {
    const state = this.meta.get(noticeKey(id))
    if (state == null)
      throw new NotFoundError(`No notice "${id}"`)
    if (state === 'dismissed')
      return
    this.meta.set(noticeKey(id), 'dismissed' satisfies NoticeState)
    for (const listener of this.listeners) {
      try {
        listener()
      }
      catch {}
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
