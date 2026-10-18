import type { ApiKey, DestinationRegistration, DownloadsConfig, JackConfig, Overview, OverviewServerItem, RestartReason, ServerItem } from '~/types/management'

/**
 * State of the dashboard's setup checklist, decided only from data jack serves
 * (config/jack, config/downloads, config/servers, overview, api-keys) plus a few
 * choices the user made on the card, kept in localStorage. The page awaits
 * `whenLoaded()` before it renders, so the card and the attention panel never start
 * from a guess.
 */

// done/open are the usual pair. `check` is the amber "check this" for a value that
// may be right as it is, or that a Radarr/Sonarr test says is wrong. `skipped` is a
// step the user opted out of, and `pending` a step that is still being decided (a
// server that is still connecting, or jack still adding itself to it).
export type SetupStepState = 'done' | 'open' | 'check' | 'pending' | 'skipped'

// The required steps taken together: `unknown` until the data is in (or when it
// failed to load), `restart` when only the restart of the jack container is left
// (the banner on every page says so), and `pending` when nothing is left to do but
// a server is still connecting or being set up.
export type SetupRequiredState = 'unknown' | 'open' | 'restart' | 'pending' | 'done'

/** What jack reports about one Radarr/Sonarr, as the card shows it. */
export interface ServerNote {
  id: string
  name: string
  message: string
}

export interface InternalUrlStep {
  state: SetupStepState
  // Servers whose own test reached jack at the internal URL.
  reachedBy: string[]
  // Servers whose test of jack failed, listed only while none reached it.
  failures: ServerNote[]
}

export interface ServerStep {
  state: SetupStepState
  // Why the step is open or pending: no server at all, none in the role the user
  // needs (receiving downloads, or sharing for someone who only shares), none of
  // them can be reached, jack is still adding itself to them, downloads are off so
  // jack added nothing, or jack's download client isn't in any of them.
  reason: 'none' | 'no-destination' | 'no-source' | 'unreachable' | 'registering' | 'downloads-off' | 'no-client' | null
  // The servers behind the state.
  names: string[]
  // With `no-client`: why jack's download client isn't in each of them.
  problems: ServerNote[]
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

const names = (servers: Array<{ name: string }>) => servers.map(s => s.name)

// Either of the *arr's tests passing means it reached jack at the internal URL. The
// indexer test counts too: it is the only one that runs while jack still needs a
// restart to serve its download client.
const reachedJack = (r: DestinationRegistration) => r.clientTest === 'ok' || r.indexerTest === 'ok'
const testFailed = (r: DestinationRegistration) => r.clientTest === 'failed' || r.indexerTest === 'failed'

export function useSetupStatus(overview: Readonly<Ref<Overview | undefined>>) {
  const { request } = useManagement()

  // Own keys, so the dashboard never shares a cache entry with the Settings forms.
  const jackReq = useAsyncData('setup:jack', () => request<JackConfig | null>('config/jack'))
  const downloadsReq = useAsyncData('setup:downloads', () => request<DownloadsConfig | null>('config/downloads'))
  const keysReq = useAsyncData('setup:api-keys', () => request<ApiKey[]>('api-keys'))
  // Only for each server's auto-register switch, which the overview doesn't carry.
  const serversReq = useAsyncData('setup:servers', () => request<{ servers: ServerItem[] }>('config/servers'))

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
  // all-clear is shown. api-keys only feeds the optional card and config/servers
  // only the auto-register switch, so neither gates anything else.
  const ready = computed(() =>
    overview.value !== undefined
    && jackReq.data.value !== undefined
    && downloadsReq.data.value !== undefined)

  const downloadsOn = computed(() => downloadsReq.data.value != null)
  const completedPath = computed(() => downloadsReq.data.value?.completedPath ?? null)
  // "I only share" counts only while downloads are off: turning them on later means
  // the user downloads after all.
  const shareOnly = computed(() => flags.shareOnly && downloadsReq.data.value === null)

  // Whether jack adds itself to this server: undefined when config/servers isn't
  // loaded or doesn't list it yet.
  function autoRegisters(id: string): boolean | undefined {
    return serversReq.data.value?.servers.find(s => s.id === id)?.autoregister.enable
  }

  // Destinations with what jack registered in them this boot, and the *arr's tests.
  const registered = computed(() => (overview.value?.servers.items ?? []).flatMap(server =>
    server.destination && server.registration ? [{ server, registration: server.registration }] : []))

  // jack falls back to the default when the config has no jack block.
  const internalUrl = computed(() => jackReq.data.value?.internalUrl ?? DEFAULT_INTERNAL_URL)

  // A Radarr/Sonarr test is the real answer. Without one, the default address is
  // only right on the jack Docker network, which the user can confirm.
  const internalUrlStep = computed<InternalUrlStep>(() => {
    const reachedBy = names(registered.value.filter(({ registration }) => reachedJack(registration)).map(({ server }) => server))
    if (reachedBy.length)
      return { state: 'done', reachedBy, failures: [] }
    const failures = registered.value
      .filter(({ registration }) => testFailed(registration))
      .map(({ server, registration }) => ({
        id: server.id,
        name: server.name,
        message: registration.message ?? `${server.name} couldn't reach jack.`,
      }))
    if (failures.length)
      return { state: 'check', reachedBy, failures }
    const state = isDefaultInternalUrl(internalUrl.value) && !flags.internalUrlAck ? 'check' : 'done'
    return { state, reachedBy, failures }
  })

  const downloadsStep = computed<SetupStepState>(() => {
    if (downloadsOn.value)
      return 'done'
    return shareOnly.value ? 'skipped' : 'open'
  })

  // Why jack's download client isn't in a server it registered in.
  function clientProblem(server: OverviewServerItem, registration: DestinationRegistration): ServerNote {
    // Registered while downloads were off, and not again since they were turned on.
    const message = registration.reason === 'downloads-off'
      ? `jack added nothing to ${server.name} while downloads were off. Click Register again on its card under Radarr & Sonarr.`
      : registration.message ?? `jack couldn't add its download client to ${server.name}.`
    return { id: server.id, name: server.name, message }
  }

  const serversStep = computed<ServerStep>(() => {
    const step = (state: SetupStepState, reason: ServerStep['reason'], servers: Array<{ name: string }> = [], problems: ServerNote[] = []): ServerStep =>
      ({ state, reason, names: names(servers), problems })

    const items = overview.value?.servers.items ?? []
    if (items.length === 0)
      return step('open', 'none')
    // Downloading needs a server that receives downloads. Someone who only shares
    // needs one that shares its library instead.
    const relevant = items.filter(s => shareOnly.value ? s.source : s.destination)
    if (relevant.length === 0)
      return step('open', shareOnly.value ? 'no-source' : 'no-destination')
    const connected = relevant.filter(s => s.initialized)
    if (connected.length === 0) {
      // No error yet means still handshaking, as right after jack starts. That is
      // not something to do, so it never reopens a hidden card.
      const connecting = relevant.filter(s => !s.initializationError)
      if (connecting.length)
        return step('pending', null, connecting)
      return step('open', 'unreachable', relevant)
    }
    if (shareOnly.value)
      return step('done', null, connected)

    // Receiving needs jack's download client in the *arr. A server jack doesn't add
    // itself to (auto-register off) is the user's to set up, so it counts as it is.
    const receiving = connected.filter(s => s.registration?.downloadClient.status === 'ok' || autoRegisters(s.id) === false)
    if (receiving.length)
      return step('done', null, receiving)
    const registering = connected.filter(s => !s.registration)
    if (registering.length)
      return step('pending', 'registering', registering)
    if (!downloadsOn.value)
      return step('open', 'downloads-off', connected)
    return step('open', 'no-client', connected, connected.flatMap(s => s.registration ? [clientProblem(s, s.registration)] : []))
  })

  // Settings saved since jack started that wait for a restart of the jack container.
  const restartReasons = computed<RestartReason[]>(() => overview.value?.system?.restartPending ?? [])
  // Shown only while something waits for the restart, so it is never done.
  const restartStep = computed<SetupStepState | null>(() => restartReasons.value.length ? 'open' : null)

  const setupStates = computed(() => [internalUrlStep.value.state, downloadsStep.value, serversStep.value.state])
  const requiredStates = computed(() => restartStep.value ? [...setupStates.value, restartStep.value] : setupStates.value)
  const requiredTotal = computed(() => requiredStates.value.length)
  const requiredDone = computed(() => requiredStates.value.filter(isDone).length)
  const requiredComplete = computed(() => requiredDone.value === requiredTotal.value)
  // The dashboard shows its green all-clear only for `done`.
  const requiredState = computed<SetupRequiredState>(() => {
    if (!ready.value)
      return 'unknown'
    if (setupStates.value.some(s => s === 'open' || s === 'check'))
      return 'open'
    if (restartStep.value)
      return 'restart'
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
  // hiding is a regression and shows the card again until it is fixed. A pending
  // restart is not: the banner on every page carries it.
  const showSetupCard = computed(() => ready.value && (requiredOpen.value || !flags.setupHidden))
  const showSharingCard = computed(() =>
    ready.value
    && !flags.sharingHidden
    && friendStep.value !== 'pending'
    && !(isDone(addressStep.value) && isDone(friendStep.value)))

  // What the card's step list shows right now, so the attention panel can leave it
  // out: the servers whose test or registration result it quotes, and whether it
  // asks for a server that receives downloads.
  const showsSteps = computed(() => showSetupCard.value && !requiredComplete.value)
  const cardServerIds = computed(() => showsSteps.value
    ? [...internalUrlStep.value.failures, ...serversStep.value.problems].map(note => note.id)
    : [])
  const cardAsksForReceiver = computed(() => showsSteps.value && serversStep.value.reason === 'no-destination')

  // True while refreshMissing() runs. It is set before any request starts, so the
  // page can hold its content back until the answers are in, instead of rendering
  // without them first.
  const refreshing = ref(false)

  // Refetch only what is missing: a failed refetch resets data, and refreshing a
  // loaded answer would make the card vanish for as long as jack is unreachable.
  async function refreshMissing() {
    const missing = [jackReq, downloadsReq, keysReq, serversReq].filter(req => req.data.value === undefined)
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
  const loaded = Promise.all([jackReq, downloadsReq, keysReq, serversReq]).then(() => {})

  return reactive({
    whenLoaded: () => loaded,
    ready,
    downloadsOn,
    completedPath,
    shareOnly,
    internalUrl,
    internalUrlStep,
    downloadsStep,
    serversStep,
    restartReasons,
    restartStep,
    requiredTotal,
    requiredDone,
    requiredComplete,
    requiredState,
    requiredOpen,
    addressStep,
    friendStep,
    showSetupCard,
    showSharingCard,
    cardServerIds,
    cardAsksForReceiver,
    settled,
    ackInternalUrl: () => setFlag('internalUrlAck', true),
    setShareOnly: (on: boolean) => setFlag('shareOnly', on),
    hideSetup: () => setFlag('setupHidden', true),
    hideSharing: () => setFlag('sharingHidden', true),
    refreshMissing,
  })
}

export type SetupStatus = ReturnType<typeof useSetupStatus>
