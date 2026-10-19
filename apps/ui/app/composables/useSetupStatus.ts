import type { ApiKey, DownloadsConfig, JackConfig, Overview, RestartReason, ServerItem } from '~/types/management'
import type { InternalUrlStep, ServerStep, SetupStepState } from '~/utils/setup-steps'
import { folderSummary } from '~/utils/folder-check'
import { addressFailures, serverStepWithAddressFailures, withAddressFailures } from '~/utils/setup-address'
import { isSetupStepDone, setupDownloadsStep, setupInternalUrlStep, setupServerStep } from '~/utils/setup-steps'

/**
 * State of the dashboard's setup checklist, decided only from data jack serves
 * (config/jack, config/downloads, config/servers, overview, api-keys), the last
 * folder check, and a few choices the user made on the card, kept in localStorage.
 * The page awaits `whenLoaded()` before it renders, so the card and the attention
 * panel never start from a guess. The steps themselves are decided in
 * utils/setup-steps.ts, with utils/setup-address.ts for a server that couldn't
 * reach the address while jack added itself.
 */

// The required steps taken together: `unknown` until the data is in (or when it
// failed to load), `open` while there is something to do (a step, or a folder
// check that failed), `restart` when only the restart of the jack container is
// left (the banner on every page says so), and `pending` when nothing is left to
// do but a server is still connecting or being set up, or the address waits for
// its test.
export type SetupRequiredState = 'unknown' | 'open' | 'restart' | 'pending' | 'done'

const FLAG_KEYS = {
  shareOnly: 'jack:setup:share-only',
  setupHidden: 'jack:setup:hidden',
  sharingHidden: 'jack:setup:sharing-hidden',
} as const

type Flag = keyof typeof FLAG_KEYS

// The address the user confirmed on the card. Older builds stored '1' for "Yes, on
// the jack network", which confirmed the default address.
const CONFIRMED_URL_KEY = 'jack:setup:internal-url-ack'

// Storage can be missing or throw (private windows, blocked site data); the card
// then behaves as if nothing was ever chosen.
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  }
  catch {
    return null
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null)
      localStorage.removeItem(key)
    else
      localStorage.setItem(key, value)
  }
  catch {}
}

function readConfirmedUrl(): string | null {
  const stored = readStored(CONFIRMED_URL_KEY)
  return stored === '1' ? DEFAULT_INTERNAL_URL : stored
}

export function useSetupStatus(overview: Readonly<Ref<Overview | undefined>>) {
  const { request } = useManagement()

  // Own keys, so the dashboard never shares a cache entry with the Settings forms.
  const jackReq = useAsyncData('setup:jack', () => request<JackConfig | null>('config/jack'))
  const downloadsReq = useAsyncData('setup:downloads', () => request<DownloadsConfig | null>('config/downloads'))
  const keysReq = useAsyncData('setup:api-keys', () => request<ApiKey[]>('api-keys'))
  // Only for each server's auto-register switch, which the overview doesn't carry.
  const serversReq = useAsyncData('setup:servers', () => request<{ servers: ServerItem[] }>('config/servers'))

  // The last folder check, shared with Settings. A problem it found is kept across
  // reloads (the card says how long ago it ran).
  const { lastReport: folderReport } = useFolderCheck()

  // Read synchronously (the UI has no SSR), so a choice made on the card never flashes.
  const flags = reactive<Record<Flag, boolean>>({
    shareOnly: readStored(FLAG_KEYS.shareOnly) === '1',
    setupHidden: readStored(FLAG_KEYS.setupHidden) === '1',
    sharingHidden: readStored(FLAG_KEYS.sharingHidden) === '1',
  })
  const confirmedUrl = ref<string | null>(readConfirmedUrl())

  function setFlag(flag: Flag, on: boolean) {
    flags[flag] = on
    writeStored(FLAG_KEYS[flag], on ? '1' : null)
  }

  // `null` is a real answer for both (no jack block, downloads off). `undefined`
  // means not loaded yet or the request failed. Then neither card nor the green
  // all-clear is shown. api-keys only feeds the optional card and config/servers
  // only the auto-register switch, so neither gates anything else.
  const ready = computed(() =>
    overview.value !== undefined
    && jackReq.data.value !== undefined
    && downloadsReq.data.value !== undefined)

  const servers = computed(() => overview.value?.servers.items ?? [])
  const downloadsOn = computed(() => downloadsReq.data.value != null)
  const completedPath = computed(() => downloadsReq.data.value?.completedPath ?? null)
  // "I only share" counts while no Radarr/Sonarr receives downloads: turning on
  // Download from friends for one means the user downloads after all. Downloads
  // being on says nothing, since new installs start with them on.
  const shareOnly = computed(() => flags.shareOnly && (overview.value?.servers.destinations ?? 0) === 0)

  // Whether jack adds itself to this server: undefined when config/servers isn't
  // loaded or doesn't list it yet.
  function autoRegisters(id: string): boolean | undefined {
    return serversReq.data.value?.servers.find(s => s.id === id)?.autoregister.enable
  }

  // jack falls back to the default when the config has no jack block.
  const internalUrl = computed(() => jackReq.data.value?.internalUrl ?? DEFAULT_INTERNAL_URL)

  // Servers that couldn't reach the address while jack added itself. On a first
  // registration that is all a wrong address shows: the tests never run.
  const unreachedAddress = computed(() => addressFailures(servers.value, internalUrl.value))

  const internalUrlStep = computed<InternalUrlStep>(() => withAddressFailures(setupInternalUrlStep({
    internalUrl: internalUrl.value,
    servers: servers.value,
    autoRegisters,
    shareOnly: shareOnly.value,
    confirmedUrl: confirmedUrl.value,
  }), unreachedAddress.value))

  const downloadsStep = computed<SetupStepState>(() => setupDownloadsStep(downloadsOn.value, shareOnly.value))

  const serversStep = computed<ServerStep>(() => serverStepWithAddressFailures(setupServerStep({
    servers: servers.value,
    autoRegisters,
    shareOnly: shareOnly.value,
    downloadsOn: downloadsOn.value,
  }), unreachedAddress.value))

  // Settings saved since jack started that wait for a restart of the jack container.
  const restartReasons = computed<RestartReason[]>(() => overview.value?.system?.restartPending ?? [])
  // Shown only while something waits for the restart, so it is never done.
  const restartStep = computed<SetupStepState | null>(() => restartReasons.value.length ? 'open' : null)

  const setupStates = computed(() => [internalUrlStep.value.state, downloadsStep.value, serversStep.value.state])
  const requiredStates = computed(() => restartStep.value ? [...setupStates.value, restartStep.value] : setupStates.value)
  const requiredTotal = computed(() => requiredStates.value.length)
  const requiredDone = computed(() => requiredStates.value.filter(isSetupStepDone).length)
  const requiredComplete = computed(() => requiredDone.value === requiredTotal.value)

  // The folder check, once there are folders to check: a Radarr/Sonarr in the
  // needed role, and downloads on (or only sharing). It never runs by itself; saves
  // in Settings and the Check folders button run it. A failure is the most common
  // Unraid mistake (Radarr/Sonarr see a folder under another path), so it keeps
  // setup from counting as finished, also after a reload until a check passes.
  const folderCheckReady = computed(() => isSetupStepDone(downloadsStep.value) && serversStep.value.state === 'done')
  const folderResult = computed(() => folderCheckReady.value && folderReport.value ? folderSummary(folderReport.value) : null)
  const folderFailed = computed(() => folderResult.value?.tone === 'error')

  // Every step done and no known problem: the card says "jack is set up".
  const setupComplete = computed(() => requiredComplete.value && !folderFailed.value)

  // The dashboard shows its green all-clear only for `done`.
  const requiredState = computed<SetupRequiredState>(() => {
    if (!ready.value)
      return 'unknown'
    if (setupStates.value.some(s => s === 'open' || s === 'check') || folderFailed.value)
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

  // Hide is only offered once setup is complete, so something to do after hiding
  // (an open step, a failed folder check) is a regression and shows the card again
  // until it is fixed. A pending restart is not: the banner on every page carries it.
  const showSetupCard = computed(() => ready.value && (requiredOpen.value || !flags.setupHidden))
  const showSharingCard = computed(() =>
    ready.value
    && !flags.sharingHidden
    && friendStep.value !== 'pending'
    && !(isSetupStepDone(addressStep.value) && isSetupStepDone(friendStep.value)))

  // What the card shows right now, so the attention panel can leave it out: the
  // servers whose test or registration result it quotes, whether it asks for a
  // server that receives downloads, and whether it shows a problem at all (then
  // "Nothing is failing" would be wrong).
  const showsSteps = computed(() => showSetupCard.value && !requiredComplete.value)
  const cardServerIds = computed(() => showsSteps.value
    ? [...internalUrlStep.value.failures, ...serversStep.value.problems].map(note => note.id)
    : [])
  const cardAsksForReceiver = computed(() => showsSteps.value && serversStep.value.reason === 'no-destination')
  const cardShowsProblem = computed(() => cardServerIds.value.length > 0 || (showSetupCard.value && folderFailed.value))

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
    setupComplete,
    requiredState,
    requiredOpen,
    folderCheckReady,
    folderResult,
    addressStep,
    friendStep,
    showSetupCard,
    showSharingCard,
    cardServerIds,
    cardAsksForReceiver,
    cardShowsProblem,
    settled,
    // Confirms the address as it is now; a later change asks again.
    confirmInternalUrl: () => {
      confirmedUrl.value = internalUrl.value
      writeStored(CONFIRMED_URL_KEY, internalUrl.value)
    },
    setShareOnly: (on: boolean) => setFlag('shareOnly', on),
    hideSetup: () => setFlag('setupHidden', true),
    hideSharing: () => setFlag('sharingHidden', true),
    refreshMissing,
  })
}

export type SetupStatus = ReturnType<typeof useSetupStatus>
