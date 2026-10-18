import type { DiscoveryConfig } from '../lib/config'
import type { IntroductionsDeps, IntroPeer } from '../modules/introductions/introductions.service'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { ConflictError } from '../lib/errors/ConflictError'
import { open, safetyCode, seal, sharedKey } from '../lib/introductions/crypto'
import { IntroStore } from '../modules/introductions/intro-store'
import { getIntroPeerRouter } from '../modules/introductions/introductions.router'
import { IntroductionsService } from '../modules/introductions/introductions.service'

interface Jack {
  name: string
  service: IntroductionsService
  store: IntroStore
  app: Hono<any>
  peers: IntroPeer[]
  added: Array<{ name: string, url: string, apiKey: string }>
  issued: string[]
  discovery: DiscoveryConfig
}

// Everything that crosses a wire, to check what the jack in the middle could read.
const wire: string[] = []

function makeJack(name: string, discovery: Partial<DiscoveryConfig>, external: string | null, extra: Partial<IntroductionsDeps> = {}): Jack {
  const store = new IntroStore(new Database(':memory:'))
  const jack = { name, store, peers: [] as IntroPeer[], added: [], issued: [], discovery: { introduce: true, discoverable: false, ...discovery } } as unknown as Jack
  let keys = 0
  jack.service = new IntroductionsService({
    store,
    discovery: () => jack.discovery,
    external: () => (external ? { url: external, headers: { 'X-Secret': `${name}-header` }, instanceName: name } : null),
    peers: () => jack.peers,
    issueKey: () => {
      const key = `${name}-key-${++keys}`
      jack.issued.push(key)
      return { id: keys, key }
    },
    apiKeyName: () => null,
    addPeer: async (peer) => {
      jack.added.push({ name: peer.name, url: peer.url, apiKey: peer.apiKey })
    },
    ...extra,
  })
  const app = new Hono<any>()
  app.onError((err, c) => c.json({ error: err.message }, err instanceof ConflictError ? 409 : 500))
  app.use('*', async (c, next) => {
    c.set('apiKeyId', Number(c.req.header('x-key')))
    await next()
  })
  app.route('/peer/intro', getIntroPeerRouter(jack.service))
  jack.app = app
  return jack
}

/** `from` adds `to` as a peer, using API key `keyId` that `to` issued to it. */
function connect(from: Jack, to: Jack, keyId: number, tamper?: (body: string) => string) {
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    if (payload)
      wire.push(payload)
    const res = await to.app.request(`/peer/intro${path}`, {
      method,
      headers: { 'x-key': String(keyId), 'Content-Type': 'application/json' },
      body: payload && tamper ? tamper(payload) : payload,
    })
    const text = await res.text()
    wire.push(text)
    if (res.status === 404)
      return null
    if (!res.ok)
      throw new Error(`HTTP ${res.status}: ${text}`)
    return JSON.parse(text)
  }
  from.peers.push({
    id: `conn-${to.name}`,
    name: to.name,
    url: `https://${to.name.toLowerCase()}.example`,
    introProfile: () => call('GET', '/profile'),
    introDirectory: () => call('GET', '/directory'),
    introMail: body => call('POST', '/mail', body),
  })
}

async function syncAll(...jacks: Jack[]) {
  for (const jack of jacks)
    await jack.service.sync()
}

describe('introductions between friends of friends', () => {
  test('a request through a mutual friend ends with a peer on both sides, and the friend sees only ciphertext', async () => {
    wire.length = 0
    const alice = makeJack('Alice', { publicName: 'Alice' }, 'https://alice.example')
    const bob = makeJack('Bob', { publicName: 'Bob' }, 'https://bob.example')
    const carol = makeJack('Carol', { publicName: 'Carol', discoverable: true }, 'https://carol.example')
    connect(alice, bob, 1) // Alice downloads from Bob
    connect(bob, carol, 2) // Bob downloads from Carol

    const people = (await alice.service.overview()).people
    expect(people).toMatchObject([{ name: 'Carol', status: 'available', via: [{ peerId: 'conn-Bob', name: 'Bob' }] }])

    const request = await alice.service.request(people[0]!.id, 'conn-Bob', 'Hej Carol, Bob sagde du har gode film')
    await syncAll(alice, bob)

    const incoming = (await carol.service.overview()).threads
    expect(incoming).toMatchObject([{ direction: 'incoming', state: 'pending', peerName: 'Alice', viaName: 'a mutual friend', messages: [{ from: 'them', text: 'Hej Carol, Bob sagde du har gode film' }] }])

    await carol.service.accept(request.requestId, 'Velkommen')
    await syncAll(bob, alice) // Bob collects Carol's answer, Alice collects it from Bob
    await syncAll(alice, bob) // Alice's card goes to Bob, then on to Carol

    expect(alice.added).toEqual([{ name: 'Carol', url: 'https://carol.example', apiKey: 'Carol-key-1' }])
    expect(carol.added).toEqual([{ name: 'Alice', url: 'https://alice.example', apiKey: 'Alice-key-1' }])
    const aliceThread = (await alice.service.overview()).threads[0]!
    const carolThread = (await carol.service.overview()).threads[0]!
    expect(aliceThread).toMatchObject({ state: 'connected', messages: [{ from: 'me' }, { from: 'them', text: 'Velkommen' }] })
    expect(carolThread.state).toBe('connected')
    expect(aliceThread.safetyCode).toBe(carolThread.safetyCode)

    // Nothing that locates Alice or Carol, no key and no message crossed Bob in the clear.
    const everything = wire.join('\n')
    for (const secret of ['alice.example', 'carol.example', 'Alice-key-1', 'Carol-key-1', 'Alice-header', 'Carol-header', 'Velkommen', 'gode film'])
      expect(everything).not.toContain(secret)
    // Bob's directory never offered Alice (not discoverable) to anyone.
    expect(everything).not.toContain('"name":"Alice","publicKey"')
  })

  test('only discoverable people are listed, and only by friends who introduce', async () => {
    const alice = makeJack('Alice', { publicName: 'Alice' }, 'https://alice.example')
    const bob = makeJack('Bob', { publicName: 'Bob', introduce: false }, null)
    const carol = makeJack('Carol', { publicName: 'Carol', discoverable: true }, null)
    const dave = makeJack('Dave', { publicName: 'Dave' }, null)
    const erin = makeJack('Erin', { publicName: 'Erin' }, null)
    connect(alice, bob, 1)
    connect(bob, carol, 2)
    connect(alice, erin, 3)
    connect(erin, dave, 4)

    expect((await alice.service.overview()).people).toEqual([])
    bob.discovery.introduce = true
    // Directories are cached for 5 minutes; a fresh service sees the change.
    const fresh = makeJack('Alice2', { publicName: 'Alice' }, 'https://alice.example')
    connect(fresh, bob, 5)
    connect(fresh, erin, 6)
    expect((await fresh.service.overview()).people.map(p => p.name)).toEqual(['Carol'])
  })

  test('declining tells the requester, and nothing is exchanged', async () => {
    const alice = makeJack('Alice', { publicName: 'Alice' }, 'https://alice.example')
    const bob = makeJack('Bob', { publicName: 'Bob' }, null)
    const carol = makeJack('Carol', { publicName: 'Carol', discoverable: true }, 'https://carol.example')
    connect(alice, bob, 1)
    connect(bob, carol, 2)
    const [person] = (await alice.service.overview()).people
    const { requestId } = await alice.service.request(person!.id, 'conn-Bob')
    await syncAll(alice, bob)
    await carol.service.decline(requestId, 'Nej tak')
    await syncAll(bob, alice)

    expect((await alice.service.overview()).threads[0]).toMatchObject({ state: 'declined', messages: [{ from: 'them', text: 'Nej tak' }] })
    expect(alice.added).toEqual([])
    expect(carol.added).toEqual([])
    expect(carol.issued).toEqual([])
  })

  test('a request the carrier tampered with is dropped', async () => {
    const alice = makeJack('Alice', { publicName: 'Alice' }, 'https://alice.example')
    const bob = makeJack('Bob', { publicName: 'Bob' }, null)
    const carol = makeJack('Carol', { publicName: 'Carol', discoverable: true }, 'https://carol.example')
    connect(alice, bob, 1)
    // Bob flips the request's sender name on its way to Carol.
    connect(bob, carol, 2, body => body.replace('"fromName":"Alice"', '"fromName":"Mallory"'))
    const [person] = (await alice.service.overview()).people
    await alice.service.request(person!.id, 'conn-Bob', 'hi')
    await syncAll(alice, bob)

    expect((await carol.service.overview()).threads).toEqual([])
  })

  test('an API key is pinned to the first identity that used it', async () => {
    const bob = makeJack('Bob', { publicName: 'Bob' }, null)
    const alice = makeJack('Alice', { publicName: 'Alice' }, null)
    const mallory = makeJack('Mallory', { publicName: 'Mallory' }, null)
    connect(alice, bob, 1)
    connect(mallory, bob, 1)
    await alice.service.sync()

    const body = { self: { id: mallory.store.identity().id, publicKey: mallory.store.identity().publicKey }, messages: [] }
    const res = await bob.app.request('/peer/intro/mail', { method: 'POST', headers: { 'x-key': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect(res.status).toBe(409)
  })

  test('a connection links each side\'s key to the new peer, and removing that peer ends it', async () => {
    const links: Record<string, Array<[number, string]>> = { Alice: [], Carol: [] }
    const linkKey = (name: string) => (apiKeyId: number, url: string) => links[name]!.push([apiKeyId, url])
    const alice = makeJack('Alice', { publicName: 'Alice' }, 'https://alice.example', { linkKey: linkKey('Alice') })
    const bob = makeJack('Bob', { publicName: 'Bob' }, 'https://bob.example')
    const carol = makeJack('Carol', { publicName: 'Carol', discoverable: true }, 'https://carol.example', { linkKey: linkKey('Carol') })
    connect(alice, bob, 1)
    connect(bob, carol, 2)

    const [person] = (await alice.service.overview()).people
    const request = await alice.service.request(person!.id, 'conn-Bob')
    await syncAll(alice, bob)
    await carol.service.accept(request.requestId)
    await syncAll(bob, alice)
    await syncAll(alice, bob)

    // Each side's issued key belongs to the peer the other side's card added.
    expect(links).toEqual({ Alice: [[1, 'https://carol.example']], Carol: [[1, 'https://alice.example']] })

    // Alice now downloads from Carol: Carol is no longer offered, the thread is live.
    connect(alice, carol, 1)
    let overview = await alice.service.overview()
    expect(overview.people).toEqual([])
    expect(overview.threads[0]).toMatchObject({ state: 'connected', ended: false })
    await expect(alice.service.request(person!.id, 'conn-Bob')).rejects.toThrow('already have a request')

    // Alice removes Carol: she can ask to connect again.
    alice.peers = alice.peers.filter(p => p.id !== 'conn-Carol')
    overview = await alice.service.overview()
    expect(overview.people).toMatchObject([{ name: 'Carol', status: 'available' }])
    expect(overview.threads[0]).toMatchObject({ state: 'connected', ended: true })
    expect((await alice.service.request(person!.id, 'conn-Bob')).state).toBe('pending')
  })

  test('a connected thread stays live while the key is linked to a current peer, even an offline one', async () => {
    const linked = new Map<number, string>([[7, 'offline-peer']])
    const jack = makeJack('Alice', { publicName: 'Alice' }, 'https://alice.example', { keyPeerId: id => linked.get(id) ?? null })
    const carol = new IntroStore(new Database(':memory:')).identity()
    jack.store.createThread({ requestId: 'r1', direction: 'incoming', peerId: carol.id, peerName: 'Carol', peerKey: carol.publicKey, viaId: 'x', viaName: 'Bob', state: 'pending', messages: [] })
    jack.store.updateThread('r1', { state: 'connected', apiKeyId: 7 })
    const unreachable = async () => {
      throw new Error('offline')
    }
    jack.peers.push({ id: 'offline-peer', name: 'Carol', url: 'https://carol.example', introProfile: unreachable, introDirectory: unreachable, introMail: unreachable })

    expect((await jack.service.overview()).threads[0]!.ended).toBe(false)
    linked.clear()
    expect((await jack.service.overview()).threads[0]!.ended).toBe(true)
  })

  test('forgetting a revoked key drops its identity binding', async () => {
    const bob = makeJack('Bob', { publicName: 'Bob' }, null)
    const alice = makeJack('Alice', { publicName: 'Alice' }, null)
    connect(alice, bob, 1)
    await alice.service.sync()
    expect(bob.service.keyBindings()).toMatchObject([{ apiKeyId: 1, identityId: alice.store.identity().id }])

    bob.service.forgetKey(1)
    expect(bob.service.keyBindings()).toEqual([])
    expect(alice.service.peerIdentity('conn-Bob')).toBe(bob.store.identity().id)
  })

  test('a peer\'s identity survives a restart while that peer is down', async () => {
    const sqlite = new Database(':memory:')
    const carol = new IntroStore(new Database(':memory:')).identity()
    const carolProfile = { id: carol.id, publicKey: carol.publicKey, name: 'Carol', discoverable: true }
    // A jack whose only peer is Carol, on the same database each time (a restart).
    const boot = (introProfile: IntroPeer['introProfile'], peerId = 'carol-peer') => new IntroductionsService({
      store: new IntroStore(sqlite),
      discovery: () => ({ publicName: 'Alice', introduce: true, discoverable: false }),
      external: () => ({ url: 'https://alice.example', headers: {} }),
      peers: () => [{ id: peerId, name: 'Carol', url: 'https://carol.example', introProfile, introDirectory: async () => null, introMail: async () => ({ messages: [] }) }],
      issueKey: () => ({ id: 1, key: 'k' }),
      apiKeyName: () => null,
      addPeer: async () => {},
    })
    // Connected before key links existed: only the identity ties the thread to Carol's peer.
    const store = new IntroStore(sqlite)
    store.createThread({ requestId: 'r1', direction: 'outgoing', peerId: carol.id, peerName: 'Carol', peerKey: carol.publicKey, viaId: 'x', viaName: 'Bob', state: 'pending', messages: [] })
    store.updateThread('r1', { state: 'connected', apiKeyId: 7 })

    const before = boot(async () => carolProfile)
    await before.sync()
    expect(before.peerIdentity('carol-peer')).toBe(carol.id)

    const down = async () => {
      throw new Error('Unable to connect')
    }
    const after = boot(down)
    expect(after.peerIdentity('carol-peer')).toBe(carol.id)
    expect((await after.overview()).threads[0]!.ended).toBe(false)
    await expect(after.request(carol.id, 'carol-peer')).rejects.toThrow('already have a request')

    // A new url (new id) keeps it; removing the peer forgets it.
    after.movePeer('carol-peer', 'carol-new')
    expect(after.peerIdentity('carol-new')).toBe(carol.id)
    expect(boot(down, 'carol-new').peerIdentity('carol-peer')).toBeNull()
    after.forgetPeer('carol-new')
    expect(after.peerIdentity('carol-new')).toBeNull()

    // A peer that answers without introductions has no identity any more.
    const before2 = boot(async () => carolProfile)
    await before2.sync()
    const upstream = boot(async () => null)
    await upstream.sync()
    expect(upstream.peerIdentity('carol-peer')).toBeNull()
  })
})

describe('introduction crypto', () => {
  test('seals for one recipient and gives both sides the same safety code', () => {
    const a = new IntroStore(new Database(':memory:')).identity()
    const c = new IntroStore(new Database(':memory:')).identity()
    const x = new IntroStore(new Database(':memory:')).identity()
    const header = { v: 1 as const, id: crypto.randomUUID(), type: 'message' as const, requestId: crypto.randomUUID(), from: a.id, fromName: 'A', fromKey: a.publicKey, to: c.id, via: x.id, createdAt: new Date().toISOString() }
    const envelope = { ...header, ...seal(sharedKey(a, c.publicKey), header, { text: 'hej' }) }

    expect(open(sharedKey(c, a.publicKey), envelope)).toEqual({ text: 'hej' })
    expect(() => open(sharedKey(x, a.publicKey), envelope)).toThrow()
    expect(() => open(sharedKey(c, a.publicKey), { ...envelope, to: x.id })).toThrow()
    expect(safetyCode(a.publicKey, c.publicKey)).toBe(safetyCode(c.publicKey, a.publicKey))
    expect(safetyCode(a.publicKey, c.publicKey)).toMatch(/^\d{4} \d{4} \d{4}$/)
  })
})
