---
description: Diagnose jack connectivity, Radarr or Sonarr registration, qBittorrent client checks, downloads, imports, permissions, management UI live updates, and peer errors.
---

# Troubleshooting

Registration runs on every startup and logs the *arr response body, so check
`docker compose logs jack` first. The common failures:

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
  database. **Restart jack**: auto-registration runs again on startup and
  updates the registration with a fresh, valid key.
- **jack answers 403 `Not available from this address`.** jack only answers
  the Torznab and qBittorrent APIs to your LAN
  ([`security.lanOnlyArrApis`](../reference/configuration.md#security)), and
  logs `Refused the Radarr/Sonarr API to an address outside your LAN` with the
  address. Typical causes: the *arr reaches jack over Tailscale (`100.x`
  addresses), from a VPS or another site, over a global IPv6 address, or
  `jack.internalUrl` is your public domain so the *arr goes through your
  reverse proxy. Use a LAN address in `jack.internalUrl`, or add the *arr's
  address under ***Settings -> Security -> Also allow***.

## qBittorrent download client test fails / `Failed to register download client`

The qBittorrent client *arr registers (or the ***Test*** button in
***Settings -> Download Clients***) connects to jack's qBittorrent API at the
host/port jack derives from `jack.internalUrl`. A failing test almost always
means *arr can't reach that address.

**Fix:** make sure `jack.internalUrl` is resolvable **from the Radarr/Sonarr
side**. On a shared Docker network use the container name (`http://jack:5225`);
otherwise the host IP/domain. If *arr and jack are on different networks, attach
jack to *arr's network (the `networks:` block in the example compose).

When *arr refuses the download client itself (`Failed to register download
client` in the log), jack leaves the indexer as it was, so it stays bound to
jack's client. Fix the cause, then save the server in the management UI again or
restart jack.

## Grabs download but never import

The download completes in jack (you see it finish in the logs) but Radarr/Sonarr
never pick the file up. jack writes finished files to the **literal**
`downloads.completedPath`, and *arr imports them by resolving that path in **its
own** filesystem, so the completed folder must exist at the **same path**
inside the Radarr/Sonarr containers.

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

**Fix:** add a `downloads` block with `completedPath`, or click ***Turn on
downloads*** under ***Settings -> Downloads*** in the management UI, and
restart jack. Saving it in the management UI registers both right away; the
restart starts the download client.

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
in `config.jsonc` or from ***Settings -> Downloads*** in the management UI. It
applies immediately, with no restart. jack then unlinks its copy as each import
is confirmed, and only then: one file per confirmed import, never your library.
Details in [After the import](/guide/how-it-works#after-the-import).

This only affects downloads imported **after** you enable it. Files already in
the folder are yours to clear out; deleting the download rows from the
management UI's Downloads page removes their files too.

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
- **The management API is down or unreachable.** The BFF answers `503` when it
  can't reach jack. Check `docker compose ps` and the backend logs for
  `Management API listening`.

## Seeing what jack is doing

Set `LOG_LEVEL=trace` to log every HTTP request (method, path, status,
duration). Registration failures always log the raw *arr response body at
`error` level. That body carries the real validation message and usually tells
you exactly what *arr is unhappy about.
