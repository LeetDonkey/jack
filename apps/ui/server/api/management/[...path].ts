import { onClientGone, relayBody } from '../../utils/relay'

// BFF proxy: every UI data call goes through here. It injects the management key
// (from env or the sealed cookie), enforces same-origin on mutations, and mirrors
// the upstream status + body back to the browser. The browser never sees the key.
export default defineEventHandler(async (event) => {
  const method = event.method
  const isMutation = method !== 'GET' && method !== 'HEAD'

  if (isMutation)
    assertSameOrigin(event)

  const { key } = await resolveKey(event)
  if (!key)
    throw createError({ statusCode: 401, statusMessage: 'not authenticated' })

  const path = event.context.params?.path ?? ''
  const search = getRequestURL(event).search
  const target = upstreamUrl(event, `/${path}${search}`)

  const headers: Record<string, string> = { 'X-Management-Key': key }
  let body: BodyInit | undefined
  if (isMutation) {
    const raw = await readRawBody(event, false)
    if (raw) {
      body = new Uint8Array(raw)
      headers['content-type'] = getRequestHeader(event, 'content-type') ?? 'application/json'
    }
  }

  let res: Response
  // A browser that leaves (a closed tab, an EventSource reopened) aborts the call
  // to jack. Otherwise every stream left behind keeps a connection to jack open,
  // and at Bun's limit of 256 every further call waits forever. A browser that
  // left during the awaits above aborts it here already, so the fetch fails
  // without reaching jack.
  const upstreamAbort = new AbortController()
  const stopWatching = onClientGone(event.node.req, event.node.res, () => upstreamAbort.abort())
  try {
    res = await fetch(target, { method, headers, body, signal: upstreamAbort.signal })
  }
  catch {
    stopWatching()
    // Shown as-is on the page that made the call (extractError reads `message`).
    throw createError({ statusCode: 503, statusMessage: 'jack isn\'t answering. Check that the jack container is running (Docker tab).' })
  }

  setResponseStatus(event, res.status)
  for (const header of ['content-type', 'cache-control', 'x-accel-buffering']) {
    const value = res.headers.get(header)
    if (value)
      setResponseHeader(event, header, value)
  }

  // Copied by hand rather than returned: h3 never ends a response whose body
  // fails, so a stream jack drops on restart would hang in the browser.
  try {
    if (!await relayBody(res.body, event.node.res, upstreamAbort.signal))
      upstreamAbort.abort()
  }
  finally {
    stopWatching()
  }
})
