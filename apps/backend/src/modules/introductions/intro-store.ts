import type { Database } from 'bun:sqlite'
import type { IdentityKeys } from '../../lib/introductions/crypto'
import type { IntroEnvelope } from '../../lib/introductions/wire'
import { randomUUID } from 'node:crypto'
import { generateIdentityKeys } from '../../lib/introductions/crypto'

export type ThreadDirection = 'outgoing' | 'incoming'
// pending: waiting for the other side's answer; accepted: answered yes, waiting
// for the other side's card; connected: both peers exist; declined: answered no.
export type ThreadState = 'pending' | 'accepted' | 'connected' | 'declined'

export interface ThreadMessage {
  from: 'me' | 'them' | 'system'
  text: string
  at: string
}

export interface IntroThread {
  requestId: string
  direction: ThreadDirection
  peerId: string
  peerName: string
  peerKey: string
  viaId: string
  viaName: string
  state: ThreadState
  messages: ThreadMessage[]
  apiKeyId: number | null
  createdAt: string
  updatedAt: string
}

export interface Identity extends IdentityKeys {
  id: string
}

// Fork-only tables, created outside the drizzle migrations (see traffic-ledger.ts).
const SCHEMA = [
  `create table if not exists intro_identity (
    singleton integer primary key check (singleton = 1),
    id text not null, public_key text not null, private_key text not null, created_at text not null)`,
  // Which identity a friend's api key speaks for, pinned on first use.
  `create table if not exists intro_bindings (
    api_key_id integer primary key, identity_id text not null, public_key text not null, bound_at text not null)`,
  // Mail waiting to be handed to `to_id` (or, for our own mail, to the carrier `via_id`).
  `create table if not exists intro_mail (
    id text primary key, from_id text not null, to_id text not null, via_id text not null,
    envelope text not null, created_at text not null)`,
  // Envelope ids already handled, so a resent one isn't processed twice.
  `create table if not exists intro_seen (id text primary key, seen_at text not null)`,
  `create table if not exists intro_threads (
    request_id text primary key, direction text not null, peer_id text not null, peer_name text not null,
    peer_key text not null, via_id text not null, via_name text not null, state text not null,
    messages text not null default '[]', api_key_id integer, created_at text not null, updated_at text not null)`,
]

interface ThreadRow {
  request_id: string
  direction: ThreadDirection
  peer_id: string
  peer_name: string
  peer_key: string
  via_id: string
  via_name: string
  state: ThreadState
  messages: string
  api_key_id: number | null
  created_at: string
  updated_at: string
}

function toThread(row: ThreadRow): IntroThread {
  return {
    requestId: row.request_id,
    direction: row.direction,
    peerId: row.peer_id,
    peerName: row.peer_name,
    peerKey: row.peer_key,
    viaId: row.via_id,
    viaName: row.via_name,
    state: row.state,
    messages: JSON.parse(row.messages) as ThreadMessage[],
    apiKeyId: row.api_key_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class IntroStore {
  constructor(private readonly sqlite: Database, private readonly now: () => Date = () => new Date()) {
    for (const statement of SCHEMA)
      sqlite.exec(statement)
  }

  private stamp(): string {
    return this.now().toISOString()
  }

  /** This jack's identity, created on first use. */
  identity(): Identity {
    const row = this.sqlite.query<{ id: string, public_key: string, private_key: string }, []>(
      'select id, public_key, private_key from intro_identity where singleton = 1',
    ).get()
    if (row)
      return { id: row.id, publicKey: row.public_key, privateKey: row.private_key }
    const keys = generateIdentityKeys()
    const identity = { id: randomUUID(), ...keys }
    this.sqlite.query('insert into intro_identity (singleton, id, public_key, private_key, created_at) values (1, ?, ?, ?, ?)')
      .run(identity.id, identity.publicKey, identity.privateKey, this.stamp())
    return identity
  }

  /**
   * Pin the identity an api key speaks for. Returns false when the key is
   * already bound to a different identity or public key.
   */
  bind(apiKeyId: number, identityId: string, publicKey: string): boolean {
    const row = this.sqlite.query<{ identity_id: string, public_key: string }, [number]>(
      'select identity_id, public_key from intro_bindings where api_key_id = ?',
    ).get(apiKeyId)
    if (row)
      return row.identity_id === identityId && row.public_key === publicKey
    this.sqlite.query('insert into intro_bindings (api_key_id, identity_id, public_key, bound_at) values (?, ?, ?, ?)')
      .run(apiKeyId, identityId, publicKey, this.stamp())
    return true
  }

  boundIdentity(apiKeyId: number): string | null {
    return this.sqlite.query<{ identity_id: string }, [number]>('select identity_id from intro_bindings where api_key_id = ?').get(apiKeyId)?.identity_id ?? null
  }

  boundIdentities(): string[] {
    return this.sqlite.query<{ identity_id: string }, []>('select identity_id from intro_bindings').all().map(r => r.identity_id)
  }

  queue(envelope: IntroEnvelope): void {
    this.sqlite.query('insert or ignore into intro_mail (id, from_id, to_id, via_id, envelope, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(envelope.id, envelope.from, envelope.to, envelope.via, JSON.stringify(envelope), this.stamp())
  }

  /** Mail for `partyId`, plus our own mail that `partyId` carries onward. */
  mailFor(partyId: string, ownId: string): IntroEnvelope[] {
    return this.sqlite.query<{ envelope: string }, [string, string, string]>(
      'select envelope from intro_mail where to_id = ? or (via_id = ? and from_id = ?) order by created_at limit 100',
    ).all(partyId, partyId, ownId).map(r => JSON.parse(r.envelope) as IntroEnvelope)
  }

  delivered(ids: string[]): void {
    const remove = this.sqlite.query('delete from intro_mail where id = ?')
    this.sqlite.transaction(() => {
      for (const id of ids)
        remove.run(id)
    })()
  }

  /** Drop mail nobody collected within 30 days, and handled ids after 90. */
  prune(): void {
    const now = this.now().getTime()
    this.sqlite.query('delete from intro_mail where created_at < ?').run(new Date(now - 30 * 86_400_000).toISOString())
    this.sqlite.query('delete from intro_seen where seen_at < ?').run(new Date(now - 90 * 86_400_000).toISOString())
  }

  /** Mark an envelope as handled; false when it already was. */
  firstSeen(id: string): boolean {
    return this.sqlite.query('insert or ignore into intro_seen (id, seen_at) values (?, ?)').run(id, this.stamp()).changes > 0
  }

  thread(requestId: string): IntroThread | null {
    const row = this.sqlite.query<ThreadRow, [string]>('select * from intro_threads where request_id = ?').get(requestId)
    return row ? toThread(row) : null
  }

  threads(): IntroThread[] {
    return this.sqlite.query<ThreadRow, []>('select * from intro_threads order by updated_at desc').all().map(toThread)
  }

  createThread(thread: Omit<IntroThread, 'createdAt' | 'updatedAt' | 'apiKeyId'>): void {
    const at = this.stamp()
    this.sqlite.query(`insert into intro_threads
      (request_id, direction, peer_id, peer_name, peer_key, via_id, via_name, state, messages, api_key_id, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)`)
      .run(thread.requestId, thread.direction, thread.peerId, thread.peerName, thread.peerKey, thread.viaId, thread.viaName, thread.state, JSON.stringify(thread.messages), at, at)
  }

  updateThread(requestId: string, changes: { state?: ThreadState, apiKeyId?: number, message?: ThreadMessage }): void {
    const thread = this.thread(requestId)
    if (!thread)
      return
    const messages = changes.message ? [...thread.messages, changes.message].slice(-200) : thread.messages
    this.sqlite.query('update intro_threads set state = ?, api_key_id = ?, messages = ?, updated_at = ? where request_id = ?')
      .run(changes.state ?? thread.state, changes.apiKeyId ?? thread.apiKeyId, JSON.stringify(messages), this.stamp(), requestId)
  }
}
