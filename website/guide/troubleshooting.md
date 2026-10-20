---
description: Diagnose jack connectivity, Radarr or Sonarr registration, qBittorrent client checks, downloads, imports, permissions, management UI live updates, and peer errors.
---

# Troubleshooting

Registration runs on every startup and logs the *arr response body, so check
`docker compose logs jack` first. In the management UI, each card under
***Settings -> Radarr & Sonarr*** shows jack's last registration in that server
and the *arr's own test of it. The common failures:

## Radarr/Sonarr report failures talking to Jack

Once registered, *arr health checks and grabs can start failing with messages
like:

```
Unable to communicate with Jack.
Failed to connect to qBittorrent, please check your settings.
```

When *arr mentions **Jack** and **qBittorrent** in the same message, it's
talking about **jack's qBittorrent API**. jack registered itself as a
qBittorrent instance, and *arr can't tell the difference, so this **does not**
mean your own qBittorrent has a problem (if you even run one). Both the indexer
and the download client point at jack, so either way the failure is between
*arr and jack.

The usual causes:

- **jack isn't running.** Check `docker compose ps` / the container logs.
- **jack is unreachable from *arr.** Same networking story as
  [below](#qbittorrent-download-client-test-fails-failed-to-register-download-client):
  `jack.internalUrl` must resolve from the Radarr/Sonarr side.
- **The managed key is no longer valid**, for example after wiping jack's
  database. Click ***Register again*** on the server's card under ***Settings
  -> Radarr & Sonarr***, or restart jack: both register jack again with a
  fresh, valid key.
- **jack answers 403 `Not available from this address`.** jack only answers
  the Torznab and qBittorrent APIs to your LAN
  ([`security.lanOnlyArrApis`](../reference/configuration.md#security)), and
  logs `Refused the Radarr/Sonarr API to an address outside your LAN` with the
  address. Typical causes: the *arr reaches jack over Tailscale (`100.x`
  addresses), from a VPS or another site, over a global IPv6 address, or
  `jack.internalUrl` is your public domain so the *arr goes through your
  reverse proxy. Use a LAN address in `jack.internalUrl`, or add the *arr's
  address under ***Settings -> Sharing -> Security -> Also allow***.

## qBittorrent download client test fails / `Failed to register download client`

The qBittorrent client *arr registers (or the ***Test*** button in
***Settings -> Download Clients***) connects to jack's qBittorrent API at the
host/port jack derives from `jack.internalUrl`. A failing test almost always
means *arr can't reach that address.

**Fix:** make sure `jack.internalUrl` is resolvable **from the Radarr/Sonarr
side**. On a shared Docker network use the container name (`http://jack:5225`);
otherwise the host IP/domain. If *arr and jack are on different networks, attach
jack to *arr's network (the `networks:` block in the example compose).

jack runs the same test after each registration, and the server's card in the
management UI says what failed in plain words, for example ***Radarr can't
resolve jack. Use your server's IP in Address Radarr/Sonarr use to reach
jack.*** A new address saved under ***Settings -> Radarr & Sonarr*** applies
right away: jack updates every *arr and tests again. A test that fails runs
once more a few seconds later, and the card drops a failure as soon as the
*arr logs in to jack's download client.

When *arr refuses the download client itself (`Failed to register download
client` in the log), jack leaves the indexer as it was, so it stays bound to
jack's client. Fix the cause, then click ***Register again*** on the server's
card in the management UI, or restart jack.

## Indexer test says `Query successful, but no results`

The ***Test*** button on the Jack indexer in Radarr or Sonarr answers this
while jack's feed is empty: you have no friends yet, or they added nothing in
the last
[`torznab.rssMaxAgeDays`](../reference/configuration.md#torznab-rssmaxagedays).
It means the *arr reached jack, so jack counts it as a passed test. jack adds
its indexer anyway (see
[`servers[].autoregister`](../reference/configuration.md#servers-autoregister)),
and Radarr and Sonarr find releases in it once a friend has some.

Radarr and Sonarr count this answer to their ***Test*** button as a failure,
and skip the indexer for a while afterwards (see
[below](#radarr-or-sonarr-says-indexers-unavailable-due-to-failures)). While
your feed is empty, leave that button alone: jack tests the indexer after
every registration without that effect.

If an *arr still refused the indexer, the server's card says so, and jack
tries again when you add or save a friend.

## Radarr or Sonarr says `Indexers unavailable due to failures`

Radarr's or Sonarr's ***System -> Status*** shows one of:

```
All indexers are unavailable due to failures
Indexers unavailable due to failures: Jack
```

After an indexer fails, Radarr and Sonarr skip it for a while: 1 minute after
the first failure, and longer after each further one, up to 24 hours. While
they skip jack's indexer, their searches and RSS syncs leave jack out, so they
find nothing from your friends. They resume it by themselves when the time is
up.

The failures come from:

- **jack was down** when the *arr synced or searched, for example during an
  update or a restart.
- **A test in the *arr:** its ***Test*** button on the Jack indexer, while
  jack's feed is empty (see
  [above](#indexer-test-says-query-successful-but-no-results)).

jack checks after every registration whether the *arr skips its indexer, and
every few minutes after that. The *arr updates that answer a few seconds after
jack saves the indexer, so a pause found right after a registration is checked
once more 15 seconds later. The server's card under ***Settings -> Radarr &
Sonarr*** then says ***Radarr is skipping jack's indexer after earlier
errors***, and the dashboard lists it under ***Worth knowing***. When
jack's feed has releases for that *arr, jack runs a test that passes, and a
passing test ends the pause right away. jack does that at every registration,
after you add or save a friend, and every 30 minutes while the pause lasts.

**Fix:** usually none. To end the pause now, once a friend has new releases,
click ***Register again*** on the server's card.

## Grabs download but never import

The download completes in jack (you see it finish in the logs) but Radarr/Sonarr
never pick the file up. jack writes finished files to the **literal**
`downloads.completedPath`, and *arr imports them by resolving that path in **its
own** filesystem, so the completed folder must exist at the **same path**
inside the Radarr/Sonarr containers.

***Check folders*** under ***Settings -> Radarr & Sonarr -> Downloads*** in the
management UI tests this: jack writes a file to the completed folder and asks
each Radarr/Sonarr that receives downloads to list it at the same path. The
result names the server and the path that doesn't match.

**Fix:** mount the **same host folder** into Radarr **and** Sonarr at the **same
container path** jack uses. If jack has:

```yaml
# jack
volumes:
  - /srv/media/jack-completed:/data/torrents/completed
```

then Radarr and Sonarr each need:

```yaml
# radarr AND sonarr
volumes:
  - /srv/media/jack-completed:/data/torrents/completed
```

Two gotchas:

- **Use a dedicated completed folder.** Don't point `completedPath` at a folder
  another download client (e.g. a real qBittorrent's `/downloads`) already
  writes to, or *arr will try to import unrelated files.
- **Permissions.** jack runs as **uid/gid 1000**, matching the `PUID/PGID` the
  linuxserver.io *arr images default to, so files jack writes are owned by the
  same user that imports them. Make sure the completed folder (and the `/config`
  mount) are readable/writable by uid 1000, with `chown -R 1000:1000`. If your
  *arr uses a different `PUID`, set it to match.

## `Downloads are off`, nothing registered

```
Downloads are off, so jack did not add its indexer or download client to Radarr/Sonarr. Turn on Downloads in Settings, then restart the jack container.
```

jack only registers itself in your *arr when a `downloads` block is present in
your config (it needs `completedPath` to know where to write files). Without it,
jack registers neither the qBittorrent download client nor the Torznab indexer:
an indexer without jack's client would let *arr send jack's releases to another
torrent client, where they never start.

If an earlier jack already added a Jack indexer with no download client bound,
jack turns it off in that *arr (the `Turned off the Jack indexer` warning in
the log). Registering with downloads on turns it back on, bound to jack's
client.

**Fix:** add a `downloads` block with `completedPath`, or click ***Turn
on downloads*** under ***Settings -> Radarr & Sonarr -> Downloads*** in the
management UI, and restart jack. Saving it in the management UI registers both
right away; the restart starts the download client. Until then, the management
UI names ***Downloads*** in a bar at the top of every page, and each server's
card reads `download client waits for a restart`.

If registration fails with `Failed to register indexer`, check that the
destination server is reachable and its API key is correct. Registration logs
the raw *arr response body at `error` level.

## `ConnectionRefused` on startup

```
Failed to initialize connector radarr: Unable to connect. Is the computer able to access the url?
```

jack tries to connect to your servers at boot. If it starts before Radarr/Sonarr
are ready, those connectors fail initially and you'll see `sources:0` /
`destinations:0` in the `Server listening` line. Source and peer connectors are
retried lazily the next time a search/download needs them, so they can recover
without a restart once the remote service is up.

jack also retries an auto-register destination that was down at boot, after 30
seconds at first and backing off to every 15 minutes, and registers its Torznab
indexer and qBittorrent download client there as soon as it connects. To make
startup deterministic, wait for the dependencies to be healthy:

```yaml
# jack
depends_on:
  radarr: {condition: service_healthy}
  sonarr: {condition: service_healthy}
```

(This needs `healthcheck` blocks on those services; the linuxserver.io images
ship with them.)

## The completed folder keeps growing

Everything imports fine, but `downloads.completedPath` never shrinks. Every
title you've ever grabbed is still sitting there.

That's the default behaviour, not a bug. Importing doesn't consume the file:
Radarr/Sonarr read it and write your library copy, and jack's copy stays put.
Whether that costs you real space depends on your *arr, since a hardlinked
import shares bytes with the library and a copied one doesn't, but either way
the folder fills up.

**Fix:** turn on
[`downloads.unlinkImportedFiles`](/reference/configuration#downloads-unlinkimportedfiles),
in `config.jsonc` or from ***Settings -> Radarr & Sonarr -> Downloads*** in
the management UI. It applies immediately, with no restart. jack then unlinks
its copy as each import is confirmed, and only then: one file per confirmed
import, never your library. Details in
[After the import](/guide/how-it-works#after-the-import).

This only affects downloads imported **after** you enable it. Files already in
the folder are yours to clear out; deleting the download rows from the
management UI's Downloads page removes their files too.

## jack-ui shows a connection error

jack-ui checks jack's management API when it loads, and shows what went wrong
instead of the console. The address in each message is
`JACK_MANAGEMENT_API_URL`, `http://jack:5226` in the example compose file:

- ***jack-ui can't find jack at http://jack:5226***: that name doesn't
  resolve. jack is stopped (Docker drops a stopped container's name), or the
  two services aren't on the same network.
- ***jack isn't answering at http://jack:5226***: the name resolves, but
  nothing answers on that port. jack is still starting or has stopped, or it
  runs without `JACK_MANAGEMENT_KEY` and so never started the management API.
- ***jack didn't answer at http://jack:5226 within 5 seconds***: check
  `JACK_MANAGEMENT_API_URL` on the jack-ui service. It must point at jack's
  [`MANAGEMENT_PORT`](/reference/environment-variables#management-port).
- ***jack rejected jack-ui's key***: `JACK_MANAGEMENT_KEY` differs between the
  two services. The example compose file reads both from one `.env` entry.

The checks listed on that screen use the names from the Unraid templates:
***Management key*** is `JACK_MANAGEMENT_KEY`, and ***Management API*** is
`JACK_MANAGEMENT_API_URL`. ***Retry*** checks again.

## Management UI stuck on "Reconnecting..."

The ***Dashboard***, ***Downloads*** and ***Live traffic*** pages show a
***Live*** badge while their
[event stream](/guide/management-ui#live-updates) is connected. If it sits on
***Connecting...*** or ***Reconnecting...***, or flips to ***Reconnecting...***
every few seconds, the stream is being closed or buffered before it reaches the
browser. The pages still load; they just stop updating on their own.

The usual causes:

- **A reverse proxy is buffering the response.** SSE only works if the proxy
  streams bytes through. jack sends `X-Accel-Buffering: no` and the UI's BFF
  forwards it, which nginx honours; for others turn buffering off explicitly
  (`proxy_buffering off;` on nginx, `flush_interval = -1` on Traefik, Caddy's
  `reverse_proxy` streams by default).
- **The proxy's idle timeout is too short.** Streams are idle between changes,
  with only a `ping` every 15 seconds. Give the UI route a read/idle timeout
  well above that, 60 seconds or more.
- **The management API is down or unreachable.** The BFF answers `503`
  (***jack isn't answering***) when it can't reach jack. Check
  `docker compose ps` and the backend logs for `Management API listening`.

## Seeing what jack is doing

Set `LOG_LEVEL=trace` to log every HTTP request (method, path, status,
duration). Registration failures always log the raw *arr response body at
`error` level. That body carries the real validation message and usually tells
you exactly what *arr is unhappy about.

To ask someone for help, click ***Copy support info*** in the management UI's
***Logs*** header. It copies jack's build, the state of each Radarr/Sonarr and
friend, and the last 50 warnings and errors, with keys, header values and
webhook URLs left out. See [Support info](/guide/management-ui#support-info).
