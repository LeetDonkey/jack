---
description: Reference every jack JSONC configuration option for internal URLs, downloads, Radarr and Sonarr servers, peer connections, retries, and imports.
---

# Configuration

jack reads a [JSONC](https://github.com/microsoft/node-jsonc-parser) file
(comments allowed) from `APP_CONFIG_PATH` (default `/config/config.jsonc`). If
the file doesn't exist, jack writes a default one on first boot. Copy
[`examples/config.jsonc`](https://github.com/roziscoding/jack/blob/main/examples/config.jsonc)
as a starting point.

The `jack` block is required. `downloads`, `servers`, and `peers` are optional,
so configure only what you need for what you're doing. (A top-level `version`
number also appears in the file; jack manages it for config migrations, so leave
it alone.)

## Quick reference

| Key | What it does |
| --- | --- |
| [`jack.internalUrl`](#jack-internalurl) | URL your *arr apps use to reach jack |
| [`jack.tmdbApiKey`](#jack-tmdbapikey) | TMDB metadata for the catalog |
| [`jack.external.instanceName`](#jack-external-instancename) | Peer name suggested in your invite links |
| [`jack.external.url`](#jack-external-url) | URL peers use to reach you |
| [`jack.external.headers`](#jack-external-headers) | Headers peers must send to reach you |
| [`downloads.completedPath`](#downloads-completedpath) | Where finished downloads go |
| [`downloads.maxConcurrentDownloads`](#downloads-maxconcurrentdownloads) | Simultaneous transfer cap |
| [`downloads.maxDownloadAttempts`](#downloads-maxdownloadattempts) | Retries before a download fails |
| [`downloads.retryBaseDelayMs`](#downloads-retrybasedelayms) | Download retry backoff base |
| [`downloads.retryMaxDelayMs`](#downloads-retrymaxdelayms) | Download retry backoff cap |
| [`downloads.retryWindowMs`](#downloads-retrywindowms) | How long network errors are retried |
| [`downloads.idleTimeoutMs`](#downloads-idletimeoutms) | Stalled-transfer timeout |
| [`downloads.importPollIntervalMs`](#downloads-importpollintervalms) | Import watcher poll cadence |
| [`downloads.maxManualImportAttempts`](#downloads-maxmanualimportattempts) | Retries before an import fails |
| [`downloads.manualImportBackoffBaseMs`](#downloads-manualimportbackoffbasems) | Import retry backoff base |
| [`downloads.manualImportBackoffMaxMs`](#downloads-manualimportbackoffmaxms) | Import retry backoff cap |
| [`downloads.unlinkImportedFiles`](#downloads-unlinkimportedfiles) | Drop jack's copy after *arr imports |
| [`downloads.pausedUntil`](#downloads-pauseduntil) | Hold new downloads until a time |
| [`torznab.rssMaxAgeDays`](#torznab-rssmaxagedays) | Age limit for releases in the RSS feed |
| [`torznab.rssMaxItems`](#torznab-rssmaxitems) | Size limit for the RSS feed |
| [`bandwidth`](#bandwidth) | Speed limits, upload slots and per-friend limits |
| [`notifications`](#notifications) | Webhooks for failures, offline friends and a daily summary |
| [`discovery`](#discovery) | Meeting friends of friends |
| [`security`](#security) | Bans, LAN-only Radarr/Sonarr APIs and the public API description |
| [`servers[].name`](#servers-name) | Display name |
| [`servers[].type`](#servers-type) | Radarr or Sonarr |
| [`servers[].url`](#servers-url) | *arr base URL |
| [`servers[].apiKey`](#servers-apikey) | *arr API key |
| [`servers[].headers`](#servers-headers) | Extra outbound headers |
| [`servers[].source`](#servers-source) | Share this library with peers |
| [`servers[].destination`](#servers-destination) | Search + import through this *arr |
| [`servers[].autoregister`](#servers-autoregister) | Indexer/client registration control |
| [`servers[].upgrades`](#servers-upgrades) | Peer releases for items you already have |
| [`peers[].name`](#peers-name) | Display name |
| [`peers[].url`](#peers-url) | Friend's peer URL |
| [`peers[].apiKey`](#peers-apikey) | Key the friend issued you |
| [`peers[].headers`](#peers-headers) | Extra outbound headers |

## `jack`

This instance's identity. Required.

### `jack.internalUrl`

**Type:** `string` · **Required**\
**Format:** URL

URL your own *arr apps use to reach jack, and the address jack registers for its
Torznab indexer and qBittorrent download client. Must be resolvable **from the
Radarr/Sonarr side**: on a shared Docker network use the container name
(`http://jack:5225`); otherwise the host IP/domain. Peers never use this URL.
They use whatever you hand them (see [API keys & peering](/guide/peering)).

A new config file gets `http://jack:5225`, or the value of
[`JACK_INTERNAL_URL`](/reference/environment-variables#jack-internal-url).
Changing it in the management UI applies without a restart: jack updates its
indexer and download client in every auto-register server.

### `jack.tmdbApiKey`

**Type:** [`ConfigSecret`](#configsecret)

TMDB v3 API key, used by the management UI's catalog to fill in artwork and
metadata for titles a peer sends without them (a jack from before this fork
sent titles, posters and quality from its Radarr/Sonarr). Set it in the config
file; the management UI doesn't edit it. Applies after a restart.

### `jack.external`

**Type:** `object`

How *another* jack reaches this instance, and the profile jack encodes into the
[invite links](/guide/quick-links) you create. Optional: without it, peering
still works, you just hand out the URL and key by hand.

Edit it from the management UI (***Settings -> Sharing -> Your public
address***), which writes this block through its own endpoints so the rest of
`jack` is left untouched.

### `jack.external.instanceName`

**Type:** `string`\
**Format:** 1–100 characters

The peer name suggested to whoever imports one of your invite links. They can
change it before saving the peer. ***Invite a friend*** in the management UI
asks for it first when it's missing; calling the API directly, the suggested
name comes from the request body instead.

### `jack.external.url`

**Type:** `string` · **Required**\
**Format:** `http`/`https` URL, no embedded `user:password@` credentials

The URL a peer should use to reach this instance, and what ends up in the `url`
field of every invite link you create. Distinct from
[`jack.internalUrl`](#jack-internalurl), which is for your own *arr apps. Use
`https://`: the peer's API key travels in a request header.

### `jack.external.headers`

**Type:** `object`\
**Content:** header name -> [`ConfigSecret`](#configsecret) value\
**Default:** `{}`

Extra headers a peer must send to get through whatever sits in front of you,
such as Cloudflare Access service tokens. They're copied into the invite link so
your friend doesn't have to configure them by hand, landing in their config as
[`peers[].headers`](#peers-headers).

Values are resolved when the profile is saved and when a link is generated,
while `env` and `file` references remain references in your config file.
Reserved headers (`X-Api-Key`, `Host`, `Content-Length`, `Connection`,
`Transfer-Encoding`), duplicate names, and values with line breaks are rejected;
at most 100 headers.

## `downloads`

Needed to **consume** (download) from peers. Without this block jack registers
nothing in your *arr apps, neither the download client nor the indexer: an
indexer without jack's client would let *arr hand jack's releases to another
torrent client. A Jack indexer an earlier jack added without a download client
is turned off.

Everything except `completedPath` is an optional tuning knob with a sensible
default.

A new config file gets `"downloads": { "completedPath": "/data/jack" }` when
`/data/jack` exists and jack can write to it. The Unraid template mounts the
downloads folder there.

Every key here is also editable from the management UI (***Settings -> Radarr &
Sonarr -> Downloads***), which takes the `...Ms` durations in seconds, minutes
or hours. Clearing a field there removes the key from the file, so the default
below applies again. `unlinkImportedFiles`, `maxConcurrentDownloads` and
`pausedUntil` take effect immediately; the rest are read at startup, so restart
jack after changing them. Until then, the management UI names them in a bar at
the top of every page. Adding the block in the management UI registers jack in
your *arr apps right away, but grabs only work after the restart.

### `downloads.completedPath`

**Type:** `string` · **Required**\
**Format:** non-empty filesystem path (inside jack's container)

Where jack writes finished downloads. The path is inside jack's container. The
management UI only saves a folder that exists and that jack can write to. It
must also be mounted into your **Radarr and Sonarr**
containers at the **same path**, because *arr resolves it in its own filesystem
to import finished files (see the callout in
[Getting started](/guide/getting-started)).

### `downloads.maxConcurrentDownloads`

**Type:** `integer`\
**Format:** ≥ 1\
**Default:** `3`

Maximum simultaneous transfers from peers.

### `downloads.maxDownloadAttempts`

**Type:** `integer`\
**Format:** ≥ 1\
**Default:** `13`

How many times a failing download is attempted before it's marked failed.
Attempts that grow the partial file don't count. A network or peer error is
retried past this limit while
[`downloads.retryWindowMs`](#downloads-retrywindowms) is still open.

### `downloads.retryBaseDelayMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 0\
**Default:** `1000`

Base delay for the exponential backoff between download retries.

### `downloads.retryMaxDelayMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 0\
**Default:** `1800000`

Upper bound for the download retry backoff. The default is 30 minutes.

### `downloads.retryWindowMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 0\
**Default:** `86400000`

How long jack keeps retrying a download that fails with a network error, a
timeout, HTTP 429 or a 5xx from the peer, counted from the last time the
download received data. Within the window the attempt limit doesn't apply, so a
peer that is offline for a few hours doesn't fail the queue. The default is 24
hours; `0` leaves only
[`downloads.maxDownloadAttempts`](#downloads-maxdownloadattempts).

A download waiting between attempts doesn't hold one of the
[`downloads.maxConcurrentDownloads`](#downloads-maxconcurrentdownloads) slots,
and shows the time of its next attempt in ***Downloads***. Other errors, such
as a 404 for a release the peer no longer has, fail right away.

### `downloads.idleTimeoutMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 1000\
**Default:** `60000`

How long a transfer may go without receiving data before it's considered
stalled and retried.

### `downloads.importPollIntervalMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 1000\
**Default:** `30000`

How often the import watcher polls each destination *arr's history to detect
which finished downloads were imported.

### `downloads.maxManualImportAttempts`

**Type:** `integer`\
**Format:** ≥ 1\
**Default:** `6`

When a manual import trigger keeps failing (e.g. *arr returns 500 because the
title's library folder is missing), jack backs off between attempts and marks
the download failed after this many attempts.

### `downloads.manualImportBackoffBaseMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 0\
**Default:** `60000`

Base delay for the manual-import retry backoff.

### `downloads.manualImportBackoffMaxMs`

**Type:** `integer`\
**Format:** milliseconds, ≥ 0\
**Default:** `1800000`

Upper bound for the manual-import retry backoff. The default is 30 minutes.

### `downloads.unlinkImportedFiles`

**Type:** `boolean`\
**Default:** `false`

Remove jack's copy of a download from `completedPath` once the *arr that grabbed
it confirms the import. jack has no use for the file after that, since it is
never re-served or re-imported.

jack calls `unlink` on that one file and nothing else, so what actually happens
depends on how your *arr imports:

- **Hardlink** (Radarr/Sonarr's default when the download and library folders
  share a filesystem): the library's link keeps the data alive, and only jack's
  extra directory entry disappears.
- **Copy or move**: the library already has its own bytes, so removing jack's
  copy just frees the space.

The unlink only ever runs on an import jack has confirmed: either the
destination *arr reports the download in its import history, or the manual
import command jack pushed reports `completed`. Downloads that are queued,
still importing, or failed keep their file, and a file that another download row
still references is left alone. If the unlink fails, the download stays
`imported` and the failure is logged.

Editable from the management UI (***Settings -> Radarr & Sonarr ->
Downloads***) and applies immediately. Like `maxConcurrentDownloads`, it does
not need a restart.

### `downloads.pausedUntil`

**Type:** `string`\
**Format:** ISO 8601 time with a UTC offset, or `"indefinite"`\
**Default:** absent (not paused)

While this time is in the future, no download takes a slot: downloads already
transferring finish, and new ones and retries wait as `queued`. They start by
themselves at that time. `"indefinite"` holds them until you resume. A time in
the past means not paused.

Set it with
[`POST /transfers/pause`](/reference/management-api/postTransfersPause) and
clear it with
[`POST /transfers/resume`](/reference/management-api/postTransfersResume)
rather than by hand; both apply without a restart.

## `bandwidth`

Limits on what jack moves to and from peers. Optional; every key applies
right away when edited in ***Settings -> Bandwidth***.

- **`downloadLimitKiBps`** / **`uploadLimitKiBps`**: combined speed limit in
  KiB/s across all peers. Absent means unlimited.
- **`maxConcurrentUploads`**: uploads running at once. A peer asking while all
  slots are taken gets a 503 with `Retry-After: 60`.
- **`maxConcurrentUploadsPerPeer`**: the same, per friend. Each API key you
  issued counts as one friend.
- **`dailyUploadLimitGiBPerPeer`**: GiB one friend may download from you per
  server day. Past it, new requests get a 429 with `Retry-After` until local
  midnight. The limit is checked when a request starts, so a peer that fetches
  in 64 MiB windows stops within one window.
- **`schedule`**: periods (`days`, `start`, `end` as `HH:MM`, optional
  `downloadLimitKiBps` / `uploadLimitKiBps`) that override the limits above.
  The first matching period wins; a period with `end` before `start` runs past
  midnight. Times follow the container's `TZ`.
- **`pausedUntil`**: pauses sharing until this time (ISO 8601 with a UTC
  offset), or until resumed with `"indefinite"`. Friends asking for a file get
  a 503 "Sharing is paused" with `Retry-After` set to the seconds left, at most
  60. Uploads already running finish, also when a friend's jack fetches the
  file in 64 MiB parts. A friend's jack keeps retrying for about 24 hours (its
  [`downloads.retryWindowMs`](#downloads-retrywindowms)), then gives up. Set
  it with
  [`POST /transfers/pause`](/reference/management-api/postTransfersPause).

## `notifications`

Where jack sends notifications, and which. Optional; edited in
***Settings -> Notifications*** and applies right away. ***Send test*** posts
a message to every webhook.

- **`webhooks`**: a list of `{ type, url }`. `url` is a
  [`ConfigSecret`](#configsecret), since webhook URLs usually embed a token.
  - `discord`: a Discord webhook URL.
  - `ntfy`: an ntfy topic URL. The title goes in the `Title` header.
  - `json`: posts `{ event, title, message, at }`, e.g. to a Home Assistant
    webhook.
- **`downloadFailed`** (default `true`): a download that still fails after its
  retries and [`downloads.retryWindowMs`](#downloads-retrywindowms). Cancelling
  a download sends nothing.
- **`peerOffline`** (default `true`) and **`peerOfflineMinutes`** (default
  `60`, at least `5`): a peer whose handshake has failed for that long, and
  again when it is back. Peers are checked every 5 minutes. The title names
  the cause:
  - `<name> is offline`: jack can't reach the peer.
  - `<name>'s jack rejected your key`: the peer answers 401.
  - `<name>'s jack is blocking you`: the peer answers 403, for example after
    a ban.
  - `<name> needs a newer jack`: the peer runs a version jack can't talk to.
- **`dailySummaryAt`**: `HH:MM` (server time) for a daily message with GB
  downloaded from and uploaded to each friend that day, and how many downloads
  finished, failed or are still running. Absent means no summary.

## `discovery`

Lets two jacks that share a friend find each other and connect. Optional;
edited in ***Settings -> Sharing -> Friends of friends*** and applies right
away. People to meet and requests are on the ***Friends*** page.

- **`publicName`**: the name friends of friends see. Defaults to
  [`jack.external.instanceName`](#jack-external-instancename).
- **`discoverable`** (default `false`): let friends of friends see that name and
  ask to connect.
- **`introduce`** (default `false`): list the friends who chose to be found to
  your other friends, and carry their requests and messages. Friends of friends
  only find each other through a friend who has this on.

Each jack has a random identity id and an X25519 key pair. A friend that
introduces lists only the id, public name and public key of each friend who is
discoverable. Requests, answers and messages are end-to-end encrypted
(X25519, HKDF-SHA256, AES-256-GCM, with the routing fields authenticated) and
travel through the friend you have in common: every jack exchanges this mail
with each of its peers once a minute, in the direction it already connects.
The friend in between sees who writes to whom, not what.

Nothing that locates either side is sent until both have said yes: asking is
the requester's yes, accepting is the other side's. Then each issues an API key
for the other and sends it with its [`jack.external`](#jack-external) URL and
headers, encrypted for the other side alone, and both add each other as a
peer. Both sides therefore need a public name and a public address
(***Settings -> Sharing -> Your public address***).

The friend in between carries the public keys, so it could in principle swap
them. Both sides see the same safety code for a request; comparing it outside
jack rules that out.

## `security`

How the public port protects itself. Every protection is on by default.
Optional; edited in ***Settings -> Sharing -> Security***, where the banned
addresses are listed with a button to lift each ban. Applies right away.

- **`banEnabled`** (default `true`): temporary bans for addresses that keep
  failing authentication, like fail2ban.
- **`maxFailures`** (default `10`), **`windowMinutes`** (default `10`): an
  address refused that many times within the window is banned. A refusal is a
  401 or 403 answer (a wrong, missing or expired key, no qBittorrent session) or
  a failed qBittorrent login.
- **`banMinutes`** (default `60`): a banned address gets 403 with
  `Retry-After` on every route, `/ping` included, until the ban ends. Bans are
  stored, so a restart doesn't lift them.
- **`trustedProxies`** (default: private network ranges): addresses or CIDR
  ranges of the reverse proxy in front of jack. Only a request from one of these
  may name the real client, in `X-Forwarded-For` (its rightmost entry that
  isn't a trusted proxy) or else `X-Real-IP`; any other request is judged by
  its own address, so a client can't dodge a ban or get someone else banned by
  sending those headers.
- **`neverBan`** (default: private network ranges and loopback): addresses that
  are never counted, so your Radarr/Sonarr on the LAN can't lock themselves out.
- **`lanOnlyArrApis`** (default `true`): answer the Torznab (`/torznab`) and
  qBittorrent (`/api/v2`) APIs, which only your own Radarr/Sonarr use, only to
  private network ranges, loopback and `arrApiAlsoAllowed`. Any other address
  gets 403 `Not available from this address` before its key is checked; these
  refusals don't count towards a ban, and jack logs the first one per address.
  - Behind a reverse proxy, the client address is the rightmost
    `X-Forwarded-For` entry that isn't a trusted proxy, else `X-Real-IP`. When
    the proxy sends both, both must be allowed, so a client can't get in by
    forging either.
  - A request that carries forwarding headers from an address outside
    `trustedProxies` is refused: `trustedProxies` must include the address
    your proxy connects from.
  - A proxy that sends neither header makes every request look like it comes
    from the proxy's own LAN address. Nginx Proxy Manager sends both.
- **`arrApiAlsoAllowed`** (default: none): addresses or CIDR ranges allowed on
  top of the LAN, for a Radarr/Sonarr that reaches jack from elsewhere, e.g.
  over Tailscale (`100.64.0.0/10`) or from a VPS.
- **`publicOpenApi`** (default `false`): answer `/openapi.json` on the public
  port. The same description is in this documentation.

[`notifications.ipBanned`](#notifications) (default `true`) sends a
notification when an address is banned.

## `torznab`

What the Torznab RSS feed offers your Radarr/Sonarr. Optional; the defaults
apply when the block is absent. Editable in ***Settings -> Advanced -> RSS
feed*** and applies to the next RSS sync.

Searches by id (a newly added movie, a request, a manual search) are not
affected: they always look through every peer's whole library.

### `torznab.rssMaxAgeDays`

**Type:** `integer`\
**Format:** days, ≥ 1\
**Default:** `7`

Only releases a peer added within this many days appear in the feed, newest
first. *arr grabs every upgrade it finds in a feed, so a feed of every peer's
whole library turns into one large batch of upgrades. A peer running a jack
that understands the filter applies it before answering; an older peer sends
its whole catalog and jack filters it.

### `torznab.rssMaxItems`

**Type:** `integer`\
**Format:** ≥ 1\
**Default:** `100`

Upper bound on the number of releases in one feed. The newest are kept.

## `servers`

Your Radarr/Sonarr servers. Each entry can be a source, a destination, or both
(see [Concepts](/guide/what-is-jack#concepts)).

### `servers[].name`

**Type:** `string` · **Required**

Display name, used in logs, health output, and search results.

### `servers[].type`

**Type:** `"radarr" | "sonarr"` · **Required**

Which *arr this server is.

### `servers[].url`

**Type:** `string` · **Required**\
**Format:** URL

Base URL of the *arr server, reachable from jack.

### `servers[].apiKey`

**Type:** [`ConfigSecret`](#configsecret) · **Required**\
**Format:** resolves to exactly 32 hexadecimal characters

The Radarr/Sonarr API key (***Settings -> General***).

### `servers[].headers`

**Type:** `object`\
**Content:** header name -> [`ConfigSecret`](#configsecret) value\
**Default:** `{}`

Extra HTTP headers sent to this server, for reverse proxies or access layers
such as Cloudflare Access or Authelia. These are outbound connector headers
only; jack still adds the required *arr `X-Api-Key` auth header separately.

### `servers[].source`

**Type:** `boolean`\
**Default:** `true`

Share this library with peers.

### `servers[].destination`

**Type:** `boolean`\
**Default:** `true`

Register jack in this server as an indexer + download client and import grabs
into it.

### `servers[].autoregister`

**Type:** `object`\
**Content:** `enable`: `boolean`, default `true` · `priority`: `integer` 1-50, default `50`

Controls the indexer/download-client registration jack performs in destination
servers. jack registers itself:

- on startup, in every server it can reach;
- in a server that was down at startup, once it is reachable;
- in a server saved in the management UI;
- in every server, after a new `jack.internalUrl` or a new `downloads` block is
  saved in the management UI.

After each registration jack asks the *arr to test its download client and
indexer, the same check as their ***Test*** buttons, and reports the result as
`registration` on each server in the management API. The management UI shows
it on the server's card under ***Settings -> Radarr & Sonarr***, where
***Register again*** registers jack in that server once more.

- **`enable`**: set `false` to register jack in that *arr yourself.
- **`priority`**: indexer priority in *arr, from 1 (preferred) to 50. *arr uses
  it to choose between releases that are otherwise equal. The default, 50, lets
  your other indexers win a tie. The
  qBittorrent download client is always registered at *arr's lowest priority
  (50): *arr's general client pool only round-robins among the best-priority
  group, so torrents grabbed from your other indexers never get routed to
  jack's client. Grabs from the Jack indexer still reach it because the indexer
  is bound to the client explicitly (`downloadClientId`), which *arr resolves
  before applying priority.

### `servers[].upgrades`

**Type:** `object`\
**Content:** `allow`: `boolean`, default `true` · `maxSizeGiB`: `number` > 0, optional

Which peer releases jack offers this destination for movies and episodes it
already has a file for. Releases for missing items are always offered.

- **`allow`**: set `false` to offer only what the destination is missing. *arr
  then never replaces a file with a peer's copy.
- **`maxSizeGiB`**: with `allow` on, offer an upgrade only when the release is at
  most this many GiB.

To tell, jack looks the item up in the destination when it answers a search or
RSS sync, and reuses each answer for 10 minutes. When the lookup fails the
release is left out of that answer. Editable in the Radarr/Sonarr form under
***Settings -> Radarr & Sonarr*** and applies right away.

## `peers`

Other jack instances (friends) you consume from. Sources only; sharing back is
configured on *their* side.

### `peers[].name`

**Type:** `string` · **Required**

Display name, used in logs, health output, and search results.

### `peers[].url`

**Type:** `string` · **Required**\
**Format:** URL

The reachable peer URL your friend gave you. Use `https://`, since the API key
travels in a request header, and jack logs a startup warning for `http://`
peers.

### `peers[].apiKey`

**Type:** [`ConfigSecret`](#configsecret) · **Required**

The peer API key that friend issued *you* (see
[API keys & peering](/guide/peering)), not your own.

### `peers[].headers`

**Type:** `object`\
**Content:** header name -> [`ConfigSecret`](#configsecret) value\
**Default:** `{}`

Extra HTTP headers sent to this peer, with the same semantics as
[`servers[].headers`](#servers-headers), e.g. Cloudflare Access service tokens.

## `ConfigSecret`

Every secret-valued key shares the `ConfigSecret` type: a value that can be
given as a plain string, as a reference to an environment variable, or as a
reference to a secret file, so secrets can stay out of the config file:

```jsonc
{
  // plain string
  "apiKey": "plain-string"
}
```

```jsonc
{
  // environment variable reference
  "apiKey": { "env": "RADARR_API_KEY" }
}
```

```jsonc
{
  // secret file reference
  "apiKey": { "file": "/run/secrets/radarr_api_key" }
}
```

All three forms are interchangeable everywhere a secret appears (`jack`,
`servers`, `peers`, `headers` values and webhook URLs). File paths must be
absolute; trailing line endings are ignored. If a referenced variable is
unset/empty, or a secret file cannot be read or resolves to an empty value at
startup, jack reports the problem and refuses to load that config.

In the management UI, a secret field stores a plain string. ***Use a container
variable or file instead*** under the field switches it to an `env` or `file`
reference ([Secret fields](/guide/management-ui#secret-fields)).

## Full example

```jsonc
{
  "jack": {
    "internalUrl": "http://jack:5225",
    "tmdbApiKey": { "env": "TMDB_API_KEY" },
    "external": {
      "instanceName": "Roz's Jack",
      "url": "https://jack.example.com",
      "headers": {
        "CF-Access-Client-Id": { "env": "MY_CF_CLIENT_ID" },
        "CF-Access-Client-Secret": { "env": "MY_CF_CLIENT_SECRET" }
      }
    }
  },
  "downloads": {
    "completedPath": "/data/torrents/completed",
    "maxConcurrentDownloads": 3
  },
  "servers": [
    {
      "name": "Main Radarr",
      "type": "radarr",
      "url": "http://radarr:7878",
      "apiKey": { "env": "RADARR_API_KEY" },
      "source": true,
      "destination": true,
      "autoregister": {
        "enable": true,
        "priority": 50
      }
    },
    {
      "name": "Main Sonarr",
      "type": "sonarr",
      "url": "http://sonarr:8989",
      "apiKey": { "env": "SONARR_API_KEY" }
    }
  ],
  "peers": [
    {
      "name": "friend",
      "url": "https://their-jack.example.com",
      "apiKey": { "env": "FRIEND_JACK_API_KEY" },
      "headers": {
        "CF-Access-Client-Id": { "env": "FRIEND_CF_CLIENT_ID" },
        "CF-Access-Client-Secret": { "env": "FRIEND_CF_CLIENT_SECRET" }
      }
    }
  ]
}
```
