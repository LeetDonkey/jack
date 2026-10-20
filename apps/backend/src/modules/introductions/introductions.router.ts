import type { AuthVariables } from '../../middleware/require-auth'
import type { IntroductionsService } from './introductions.service'
import { Hono } from 'hono'
import { describeRoute, validator as zValidator } from 'hono-openapi'
import z from 'zod'
import { IntroMailRequest } from '../../lib/introductions/wire'
import { validator } from '../../lib/validation'

type PeerSide = Pick<IntroductionsService, 'profile' | 'directoryFor' | 'handleMail'>
type ManagementSide = Pick<IntroductionsService, 'overview' | 'request' | 'accept' | 'decline' | 'message' | 'sync'>

/** Mounted at /peer/intro behind the peer api_key guard. */
export function getIntroPeerRouter(service: PeerSide) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/profile', describeRoute({
    tags: ['Peer'],
    summary: 'Introduction profile',
    description: 'This jack\'s random identity id, public key, public name and whether friends of friends may find it. Nothing that locates it.',
    security: [{ 'X-Api-Key': [] }],
    responses: { 200: { description: 'The profile' } },
  }), c => c.json(service.profile()))

  app.get('/directory', describeRoute({
    tags: ['Peer'],
    summary: 'Friends you can be introduced to',
    description: 'The friends of this jack who opted in to be found: random id, public name and public key. 404 when this jack doesn\'t introduce.',
    security: [{ 'X-Api-Key': [] }],
    responses: { 200: { description: 'The directory' }, 404: { description: 'This jack does not introduce its friends' } },
  }), async (c) => {
    const directory = await service.directoryFor(c.get('apiKeyId'))
    return directory ? c.json(directory) : c.json({ error: 'Not introducing' }, 404)
  })

  app.post('/mail', describeRoute({
    tags: ['Peer'],
    summary: 'Exchange introduction mail',
    description: 'Hands over end-to-end encrypted envelopes for (or through) this jack and returns the ones waiting for the caller. `introduces: false` keeps mail that would go through the caller. The caller\'s identity is pinned to its API key on first use.',
    security: [{ 'X-Api-Key': [] }],
    responses: { 200: { description: '`{ messages, refused }`: mail waiting for the caller, and the ids of handed-over envelopes this jack won\'t carry now (the caller keeps them)' }, 409: { description: 'The API key is pinned to another identity' } },
  }), zValidator('json', IntroMailRequest), async (c) => {
    return c.json(await service.handleMail(c.get('apiKeyId'), c.req.valid('json')))
  })

  return app
}

const Text = z.string().trim().min(1).max(2000)

/** Mounted at /introductions on the management API. */
export function getIntroductionsRouter(service: ManagementSide) {
  const app = new Hono()

  app.get('/', describeRoute({
    tags: ['Introductions'],
    summary: 'Friends of friends and requests',
    description: 'Your discovery status, the people your friends can introduce you to, and every request with its messages and safety code. `me` is `{ id, name, discoverable, introduce, ready, missing, introducers }`: `introducers` counts the friends\' jacks that introduce you (they have `discovery.introduce` on and answered their directory, counted once per jack), from each friend\'s last answer; null while no friend has answered yet. A request in state `connected` has `ended: true` once that person is no longer one of your peers (you removed them); they are then listed as `available` again and a new request is allowed. Waits at most 5 seconds for a friend\'s jack: the people of a friend that answers later, or not at all, come from that friend\'s last answer.',
    responses: { 200: { description: 'Overview' } },
  }), async c => c.json(await service.overview()))

  app.post('/requests', describeRoute({
    tags: ['Introductions'],
    summary: 'Ask to connect',
    description: 'Sends a request (with an optional message) to a person, through the friend who listed them. Nothing that locates you is sent.',
    responses: { 200: { description: 'The new request' } },
  }), validator('json', z.object({ personId: z.uuid(), viaPeerId: z.string().min(1), message: Text.optional() })), async (c) => {
    const { personId, viaPeerId, message } = c.req.valid('json')
    return c.json(await service.request(personId, viaPeerId, message))
  })

  const answer = z.object({ message: Text.optional() })
  app.post('/requests/:requestId/accept', describeRoute({
    tags: ['Introductions'],
    summary: 'Accept a request',
    description: 'Accepts, issues an API key for the other person and sends it with your external URL, encrypted for them alone.',
    responses: { 200: { description: 'The request' } },
  }), validator('json', answer), async c => c.json(await service.accept(c.req.param('requestId'), c.req.valid('json').message)))

  app.post('/requests/:requestId/decline', describeRoute({
    tags: ['Introductions'],
    summary: 'Decline a request',
    responses: { 200: { description: 'The request' } },
  }), validator('json', answer), async c => c.json(await service.decline(c.req.param('requestId'), c.req.valid('json').message)))

  app.post('/requests/:requestId/messages', describeRoute({
    tags: ['Introductions'],
    summary: 'Send a message',
    description: 'An end-to-end encrypted message to the other person, carried by your mutual friend.',
    responses: { 200: { description: 'The request' } },
  }), validator('json', z.object({ text: Text })), async c => c.json(await service.message(c.req.param('requestId'), c.req.valid('json').text)))

  app.post('/sync', describeRoute({
    tags: ['Introductions'],
    summary: 'Sync now',
    description: 'Exchanges introduction mail with every peer right away instead of waiting for the minute timer.',
    responses: { 200: { description: '`{ ok: true }`' } },
  }), async (c) => {
    await service.sync()
    return c.json({ ok: true })
  })

  return app
}
