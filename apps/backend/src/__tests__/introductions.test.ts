import type { DiscoveryConfig } from '../lib/config'
import type { IntroPeer } from '../modules/introductions/introductions.service'
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

function makeJack(name: string, discovery: Partial<DiscoveryConfig>, external: string | null): Jack {
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

  test('mail through a friend who stops introducing waits instead of getting lost', async () => {
    const alice = makeJack('Alice', { publicName: 'Alice' }, 'https://alice.example')
    const bob = makeJack('Bob', { publicName: 'Bob' }, 'https://bob.example')
    const carol = makeJack('Carol', { publicName: 'Carol', discoverable: true }, 'https://carol.example')
    connect(alice, bob, 1)
    connect(bob, carol, 2)
    const [person] = (await alice.service.overview()).people
    await alice.service.request(person!.id, 'conn-Bob', 'Hej')

    // Bob stops introducing before Alice's request reaches him: he refuses it, and Alice keeps it.
    bob.discovery.introduce = false
    await syncAll(alice, bob)
    expect((await carol.service.overview()).threads).toEqual([])
    expect(alice.store.mailFor(bob.service.profile().id, alice.service.profile().id)).toHaveLength(1)

    // Once Bob introduces again, the same request goes through.
    bob.discovery.introduce = true
    await syncAll(alice, bob)
    expect((await carol.service.overview()).threads).toMatchObject([{ direction: 'incoming', state: 'pending', messages: [{ text: 'Hej' }] }])
    expect(alice.store.mailFor(bob.service.profile().id, alice.service.profile().id)).toEqual([])
  })

  test('mail waiting for a friend who connects to us is held while it does not introduce', async () => {
    const alice = makeJack('Alice', { publicName: 'Alice' }, 'https://alice.example')
    const bob = makeJack('Bob', { publicName: 'Bob' }, 'https://bob.example')
    const carol = makeJack('Carol', { publicName: 'Carol', discoverable: true }, 'https://carol.example')
    connect(alice, bob, 1)
    connect(bob, carol, 2)
    const [person] = (await alice.service.overview()).people
    const { requestId } = await alice.service.request(person!.id, 'conn-Bob')
    await syncAll(alice, bob)
    await carol.service.accept(requestId)

    // Carol's answer and card go to Alice through Bob, who collects them from Carol.
    // While Bob doesn't introduce, Carol keeps them.
    bob.discovery.introduce = false
    await syncAll(bob)
    expect(carol.store.mailFor(bob.service.profile().id, carol.service.profile().id)).toHaveLength(2)
    bob.discovery.introduce = true
    await syncAll(bob, alice)
    expect(carol.store.mailFor(bob.service.profile().id, carol.service.profile().id)).toEqual([])
    expect(alice.added).toEqual([{ name: 'Carol', url: 'https://carol.example', apiKey: 'Carol-key-1' }])
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
