---
description: Connect jack instances securely, exchange scoped peer API keys, and share Radarr or Sonarr media libraries with trusted friends.
---

# API keys & peering

jack authenticates each external surface by **key type**, so a credential only
works where it's meant to (`/ping` is the only unauthenticated route):

- **Peer API keys.** Issued per friend: every
  [invite link](./quick-links.md) carries a new one, and ***Settings ->
  Advanced -> API keys for other tools -> Create key*** in the management UI,
  or the management API, makes one by hand. They are named, revocable, and
  optionally expiring. Scoped to the **peer API** (`/handshake`, `/peer/*`): a
  peer key **cannot** query your Torznab indexer or act as your download
  client.
- **Managed keys.** jack mints these automatically and registers them in your
  Radarr/Sonarr when it auto-registers as their indexer + download client.
  Scoped to the ***arr surface** (`/torznab`, the qBittorrent API); you never
  see or handle them.

So keys flow in two directions:

- Your **Radarr/Sonarr** authenticate with the managed key jack registered for
  them (as the Torznab `apikey` and the download-client password).
- Your **peers** send the peer API key you issued them as the `X-Api-Key` header
  when they search or download from you.

## Sharing with friends (peering)

Peering is symmetric. You each run jack and exchange a URL where the other
instance can reach your peer API, plus a **peer API key**. This public or
LAN-reachable peer URL is independent of `jack.internalUrl`, which is the
address your own Radarr/Sonarr use to reach jack.

### With an invite link

The easiest way to do that exchange is an [invite link](./quick-links.md):
***Friends -> Invite a friend*** in the management UI makes one, and your
friend pastes it under ***Friends -> Add a friend*** in theirs. The link
carries your peer URL, a peer API key issued on the spot, and any proxy
headers needed to reach you, so neither of you types a credential by hand.

### By hand

You can also exchange the two values yourself, which is what an invite link
automates:

- **You give a friend** your reachable peer URL plus a peer API key you issue
  them under ***Settings -> Advanced -> API keys for other tools -> Create
  key***. Once you've added them too, pick their name under ***Link to...***
  in ***Friends -> Not linked to a friend***, so the key shows on their card.
  They add you with ***Friends -> Add a friend -> Add without a link***, or
  under `peers` in *their* config:

  ```jsonc
  {
    "peers": [
      { "name": "you", "url": "https://your-jack.example.com", "apiKey": "<the key you issued them>" }
    ]
  }
  ```

- **They give you** theirs, and you add them the same way in your config.

Either way, each side's Radarr/Sonarr can then find and pull media the other
has.

::: tip One key per peer
Issue a **separate key per peer**. Each one is scoped to the peer API, so it
can't reach your indexer or download client, and each can be revoked
individually without disrupting your other peers.
:::

::: warning Use HTTPS for peer URLs
The key travels in the `X-Api-Key` request header, so a plain `http://` peer
exposes it in transit to anything on the path. jack logs a warning at startup
for any peer configured over `http://`.
:::
