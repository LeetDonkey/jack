import type { Overview } from '~/types/management'
import type { JackDownTracker } from '~/utils/jack-down'
import { createJackDownTracker } from '~/utils/jack-down'

// Components using useOverview that are mounted right now. The first one subscribes
// to /overview/stream and the last one to unmount ends it, so the layout and every
// page share one connection and one subscriber.
let consumers = 0
let unsubscribe: (() => void) | undefined
// The first consumer's listener, so the last one to unmount can remove it.
let visibilityListener: (() => void) | undefined
// Sets `jackDown` for the whole app, from the first mount to the last unmount.
let downTracker: JackDownTracker | undefined
// Bumped by every stream snapshot. A GET that started before one must not
// overwrite it with what may be older data.
let streamRevision = 0
// Bumped by every GET, so only the latest one writes its answer.
let fetchSeq = 0
let inflight: Promise<void> | undefined

/**
 * The /overview snapshot, shared by the whole app and kept live by one
 * /overview/stream connection while any component uses it and the tab is visible.
 * The layout keeps it open on every page, so pages read `overview.value?.system`
 * and `overview.value?.servers` without a stream of their own.
 *
 * `hasConnectedOnce` is the current stream's, for the "Reconnecting…" badge; a
 * tab shown again opens a new stream, which starts at false. `jackDown` is the
 * one "jack isn't answering" state: true once the stream, which connected since
 * sign-in, has been closed for JACK_DOWN_AFTER_MS of visible time, and false again
 * as soon as it reopens (createJackDownTracker). The layout's notice and the pages
 * read it, so they change together.
 *
 * `refresh()` fetches GET /overview and never rejects; a failure lands in `error`.
 * `whenLoaded()` settles once the first load is done, for pages that hold their
 * first render until the data is in.
 */
export function useOverview() {
  const { request } = useManagement()
  const overview = useState<Overview | undefined>('overview', () => undefined)
  const pending = useState('overview:pending', () => false)
  const error = useState<unknown>('overview:error', () => undefined)
  const connected = useState('overview:connected', () => false)
  const hasConnectedOnce = useState('overview:has-connected-once', () => false)
  const jackDown = useState('overview:jack-down', () => false)

  function refresh(): Promise<void> {
    const seq = ++fetchSeq
    const revision = streamRevision
    pending.value = true
    const run: Promise<void> = request<Overview>('overview')
      .then((snapshot) => {
        if (seq !== fetchSeq)
          return
        if (revision === streamRevision)
          overview.value = snapshot
        error.value = undefined
      }, (err: unknown) => {
        if (seq === fetchSeq)
          error.value = err
      })
      .finally(() => {
        if (seq === fetchSeq)
          pending.value = false
        if (inflight === run)
          inflight = undefined
      })
    inflight = run
    return run
  }

  function whenLoaded(): Promise<void> {
    return inflight ?? Promise.resolve()
  }

  // The first caller (or the first after a failed load) starts the request, so a
  // page that awaits whenLoaded() renders with data.
  if (overview.value === undefined && !inflight)
    void refresh()

  function subscribe() {
    unsubscribe = subscribeManagementStream<Overview>('overview/stream', {
      onSnapshot: (snapshot) => {
        streamRevision++
        overview.value = snapshot
        error.value = undefined
      },
      onConnection: (isConnected, once) => {
        connected.value = isConnected
        hasConnectedOnce.value = once
        downTracker?.update(isConnected, !document.hidden)
      },
    }, async () => {
      await request('ping')
    })
  }

  // A hidden tab lets go of the stream. Opened by IP, jack-ui speaks HTTP/1.1, where
  // a browser allows six connections per host across all tabs, and most pages hold a
  // stream of their own. The stream starts with a full snapshot, so reopening it
  // when the tab is shown again brings the overview up to date.
  function onVisibilityChange() {
    if (document.hidden) {
      unsubscribe?.()
      unsubscribe = undefined
      connected.value = false
      downTracker?.update(false, false)
    }
    else if (!unsubscribe) {
      subscribe()
    }
  }

  // A page whose async setup is abandoned unmounts without ever mounting; only a
  // mounted caller counts.
  let counted = false
  onMounted(() => {
    counted = true
    if (consumers++ > 0)
      return
    downTracker = createJackDownTracker((down) => {
      jackDown.value = down
    })
    visibilityListener = onVisibilityChange
    document.addEventListener('visibilitychange', visibilityListener)
    if (!document.hidden)
      subscribe()
  })

  onUnmounted(() => {
    if (!counted)
      return
    counted = false
    if (--consumers > 0)
      return
    if (visibilityListener)
      document.removeEventListener('visibilitychange', visibilityListener)
    visibilityListener = undefined
    unsubscribe?.()
    unsubscribe = undefined
    downTracker?.reset()
    downTracker = undefined
    connected.value = false
    hasConnectedOnce.value = false
    jackDown.value = false
    // Nothing keeps the snapshot live any more (signed out), so drop it rather than
    // show it stale on the next mount. A GET still on its way is dropped too.
    fetchSeq++
    inflight = undefined
    pending.value = false
    overview.value = undefined
    error.value = undefined
  })

  return { overview, connected, hasConnectedOnce, jackDown, pending, error, refresh, whenLoaded }
}
