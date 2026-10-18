import type { ApiKey, DownloadsConfig, JackConfig, Overview } from '~/types/management'

/**
 * State of the dashboard's setup checklist, decided only from data jack serves
 * (config/jack, config/downloads, overview, api-keys) plus a few choices the user
 * made on the card, kept in localStorage. The page awaits `whenLoaded()` before it
 * renders, so the card and the attention panel never start from a guess.
 */

// done/open are the usual pair. `check` is the amber "check this" for a value that
// may be right as it is, `skipped` a step the user opted out of, and `pending` a
// step that is still being decided (a server that is still connecting).
export type SetupStepState = 'done' | 'open' | 'check' | 'pending' | 'skipped'

// The required steps taken together: `unknown` until the data is in (or when it
// failed to load), `pending` when nothing is left to do but a server is still
// connecting.
export type SetupRequiredState = 'unknown' | 'open' | 'pending' | 'done'

export interface ServerStep {
  state: SetupStepState
  // Why the step is open: no server at all, none in the role the user needs
  // (receiving downloads, or sharing for someone who only shares), or none of
  // them can be reached.
  reason: 'none' | 'no-destination' | 'no-source' | 'unreachable' | null
  // The servers behind the state: connected, still connecting, or failing.
  names: string[]
}

const FLAG_KEYS = {
  internalUrlAck: 'jack:setup:internal-url-ack',
  shareOnly: 'jack:setup:share-only',
  setupHidden: 'jack:setup:hidden',
  sharingHidden: 'jack:setup:sharing-hidden',
} as const

type Flag = keyof typeof FLAG_KEYS

// Storage can be missing or throw (private windows, blocked site data); the card
// then behaves as if nothing was ever chosen.
function readFlag(flag: Flag): boolean {
  try {
    return localStorage.getItem(FLAG_KEYS[flag]) === '1'
  }
  catch {
    return false
  }
}

function writeFlag(flag: Flag, on: boolean) {
  try {
    if (on)
      localStorage.setItem(FLAG_KEYS[flag], '1')
    else
      localStorage.removeItem(FLAG_KEYS[flag])
  }
  catch {}
}

const isDone = (state: SetupStepState) => state === 'done' || state === 'skipped'

export function useSetupStatus(overview: Ref<Overview | undefined>) {
  const { request } = useManagement()

  // Own keys, so the dashboard never shares a cache entry with the Settings forms.
  const jackReq = useAsyncData('setup:jack', () => request<JackConfig | null>('config/jack'))
  const downloadsReq = useAsyncData('setup:downloads', () => request<DownloadsConfig | null>('config/downloads'))
  const keysReq = useAsyncData('setup:api-keys', () => request<ApiKey[]>('api-keys'))

  // Read synchronously (the UI has no SSR), so an acknowledged step never flashes.
  const flags = reactive<Record<Flag, boolean>>({
    internalUrlAck: readFlag('internalUrlAck'),
    shareOnly: readFlag('shareOnly'),
    setupHidden: readFlag('setupHidden'),
    sharingHidden: readFlag('sharingHidden'),
  })

  function setFlag(flag: Flag, on: boolean) {
    flags[flag] = on
    writeFlag(flag, on)
  }

  // `null` is a real answer for both (no jack block, downloads off). `undefined`
  // means not loaded yet or the request failed. Then neither card nor the green
  // all-clear is shown. api-keys only feeds the optional card, so it gates nothing
  // else.
  const ready = computed(() =>
    overview.value !== undefined
    && jackReq.data.value !== undefined
    && downloadsReq.data.value !== undefined)

  const downloadsOn = computed(() => downloadsReq.data.value != null)
  // "I only share" counts only while downloads are off: turning them on later means
  // the user downloads after all.
  const shareOnly = computed(() => flags.shareOnly && downloadsReq.data.value === null)

  // jack falls back to the default when the config has no jack block.
  const internalUrl = computed(() => jackReq.data.value?.internalUrl ?? DEFAULT_INTERNAL_URL)
  const internalUrlStep = computed<SetupStepState>(() =>
    isDefaultInternalUrl(internalUrl.value) && !flags.internalUrlAck ? 'check' : 'done')

  const downloadsStep = computed<SetupStepState>(() => {
    if (downloadsOn.value)
      return 'done'
    return shareOnly.value ? 'skipped' : 'open'
  })

  const serversStep = computed<ServerStep>(() => {
    const items = overview.value?.servers.items ?? []
    if (items.length === 0)
      return { state: 'open', reason: 'none', names: [] }
    // Downloading needs a server that receives downloads. Someone who only shares
    // needs one that shares its library instead.
    const relevant = items.filter(s => shareOnly.value ? s.source : s.destination)
    if (relevant.length === 0)
      return { state: 'open', reason: shareOnly.value ? 'no-source' : 'no-destination', names: [] }
    const connected = relevant.filter(s => s.initialized)
    if (connected.length)
      return { state: 'done', reason: null, names: connected.map(s => s.name) }
    // No error yet means still handshaking, as right after jack starts. That is not
    // something to do, so it never reopens a hidden card.
    const connecting = relevant.filter(s => !s.initializationError)
    if (connecting.length)
      return { state: 'pending', reason: null, names: connecting.map(s => s.name) }
    return { state: 'open', reason: 'unreachable', names: relevant.map(s => s.name) }
  })

  const requiredStates = computed(() => [internalUrlStep.value, downloadsStep.value, serversStep.value.state])
  const requiredTotal = computed(() => requiredStates.value.length)
  const requiredDone = computed(() => requiredStates.value.filter(isDone).length)
  const requiredComplete = computed(() => requiredDone.value === requiredTotal.value)
  // The dashboard shows its green all-clear only for `done`.
  const requiredState = computed<SetupRequiredState>(() => {
    if (!ready.value)
      return 'unknown'
    if (requiredStates.value.some(s => s === 'open' || s === 'check'))
      return 'open'
    return requiredComplete.value ? 'done' : 'pending'
  })
  const requiredOpen = computed(() => requiredState.value === 'open')

  const addressStep = computed<SetupStepState>(() => {
    const external = jackReq.data.value?.external
    return external?.url && external.instanceName ? 'done' : 'open'
  })
  // Either half of a friendship counts: a friend you download from, or a key a
  // friend downloads from you with. Without the key list there is no answer yet.
  const friendStep = computed<SetupStepState>(() => {
    if ((overview.value?.peers.total ?? 0) >= 1 || (keysReq.data.value?.length ?? 0) >= 1)
      return 'done'
    return keysReq.data.value === undefined ? 'pending' : 'open'
  })

  // Hide is only offered once every required step is done, so an open step after
  // hiding is a regression and shows the card again until it is fixed.
  const showSetupCard = computed(() => ready.value && (requiredOpen.value || !flags.setupHidden))
  const showSharingCard = computed(() =>
    ready.value
    && !flags.sharingHidden
    && friendStep.value !== 'pending'
    && !(isDone(addressStep.value) && isDone(friendStep.value)))

  // True while refreshMissing() runs. It is set before any request starts, so the
  // page can hold its content back until the answers are in, instead of rendering
  // without them first.
  const refreshing = ref(false)

  // Refetch only what is missing: a failed refetch resets data, and refreshing a
  // loaded answer would make the card vanish for as long as jack is unreachable.
  async function refreshMissing() {
    const missing = [jackReq, downloadsReq, keysReq].filter(req => req.data.value === undefined)
    if (missing.length === 0 || refreshing.value)
      return
    refreshing.value = true
    try {
      await Promise.all(missing.map(req => req.refresh()))
    }
    finally {
      refreshing.value = false
    }
  }

  // Whether the page can render the dashboard: everything is in, or the last
  // attempt is over and failed. It then shows without the setup card and without
  // an all-clear.
  const settled = computed(() => ready.value || !refreshing.value)

  // Settles once every request answered or failed; the page awaits it before render.
  const loaded = Promise.all([jackReq, downloadsReq, keysReq]).then(() => {})

  return reactive({
    whenLoaded: () => loaded,
    ready,
    downloadsOn,
    shareOnly,
    internalUrl,
    internalUrlStep,
    downloadsStep,
    serversStep,
    requiredTotal,
    requiredDone,
    requiredComplete,
    requiredState,
    requiredOpen,
    addressStep,
    friendStep,
    showSetupCard,
    showSharingCard,
    settled,
    ackInternalUrl: () => setFlag('internalUrlAck', true),
    setShareOnly: (on: boolean) => setFlag('shareOnly', on),
    hideSetup: () => setFlag('setupHidden', true),
    hideSharing: () => setFlag('sharingHidden', true),
    refreshMissing,
  })
}

export type SetupStatus = ReturnType<typeof useSetupStatus>
