---
description: Manage Radarr and Sonarr, friends, access keys, downloads, requests from friends' libraries, and logs from jack's self-hosted web console, with live updates over Server-Sent Events.
---

# Management UI

jack ships with a web console, the **management UI**, so you can run your
instance without hand-editing `config.jsonc`. With the
[Getting started](/guide/getting-started) compose file it runs as the
`jack-ui` service at **http://localhost:3000**, and it's the easiest way to
operate jack day to day:

- ***Dashboard***: a setup checklist until jack is ready, then your
  Radarr/Sonarr and friends and whether each one connected, with download
  activity updating live. Each Radarr/Sonarr shows when it last reached jack,
  and ***Needs attention*** lists what is failing, including a Radarr/Sonarr
  that jack couldn't set itself up in.
- ***Friends' library***: browse everything your friends share, and request
  titles into your library.
- ***Downloads***: inspect, cancel, retry, and delete in-flight or finished
  grabs, updating live as they progress.
- ***Live traffic***: what is moving right now, in both directions.
- ***Friends***: who you download from, who can download from you, their
  traffic, and friends of friends.
- ***Logs***: live-tail the backend's logs. A line with a known fix has a help
  icon; click the line for a link to the fix.
- ***Settings***: one page, with these sections in this order:
  - ***jack***: ***Address Radarr/Sonarr use to reach jack***
    ([`jack.internalUrl`](/reference/configuration#jack-internalurl)). It
    applies right away.
  - ***Downloads***: the whole
    [`downloads`](/reference/configuration#downloads) block, covering where
    finished files land, how many downloads run at once, whether jack drops its
    copy after an import, and the retry and import-watcher tuning.
  - ***Radarr & Sonarr***: add, edit, and remove your Radarr/Sonarr
    connections, and see what jack set up in each
    ([below](#settings-radarr-sonarr)).
  - ***Quick linking***: how friends reach this instance, plus the buttons that
    generate and import [quick links](/guide/quick-links).
  - ***Friends you download from***: add, edit, and remove the friends whose
    libraries you download from.
  - ***Friend access keys***: issue and revoke the keys you hand to friends.
  - ***Friends of friends***: the
    [`discovery`](/reference/configuration#discovery) block.
  - ***Bandwidth***: the [`bandwidth`](/reference/configuration#bandwidth)
    block.
  - ***RSS feed***: the [`torznab`](/reference/configuration#torznab) block.
  - ***Notifications***: the
    [`notifications`](/reference/configuration#notifications) block.
  - ***Security***: the [`security`](/reference/configuration#security) block.
  - ***About***: jack's version and the TMDB attribution.

Links to a setting from elsewhere in the UI, such as the setup card on the
***Dashboard***, open ***Settings*** scrolled to that section.

Each section of ***Settings*** saves on its own. Leaving ***Settings*** while
a section has unsaved changes asks first, naming the sections, for example
***Leave without saving Downloads?*** with ***Stay*** and ***Leave without
saving***. Reloading or closing the tab gets the browser's own prompt instead.
A dialog such as ***Connect Radarr or Sonarr*** stays open on a click outside
it or on Escape once you've changed a field; close it with its own buttons.

Some settings only apply when jack starts, such as turning on downloads or a
new ***Completed folder***. Once you save one, a bar at the top of every page
names them, for example ***jack needs a restart to apply: Downloads***, until
you restart the jack container. jack-ui then shows ***jack restarted. New
settings are active.*** jack-ui itself never needs a restart.

Don't want it? Delete the `jack-ui` service and the backend's
`JACK_MANAGEMENT_KEY` line to run jack headless.

## Settings -> Downloads

The whole [`downloads`](/reference/configuration#downloads) block is editable
here, so there's no reason to hand-edit `config.jsonc` for it:

- The settings you actually choose sit at the top: ***Completed folder***,
  ***Downloads at once***, and the
  ***[Remove jack's copy after Radarr/Sonarr import it](/reference/configuration#downloads-unlinkimportedfiles)***
  switch.
- ***Download retries*** and ***Handing files to Radarr/Sonarr*** are collapsed
  below, each labelled with how many of its values you've moved off jack's
  defaults.

Every field's placeholder is jack's default, and **clearing a field means "use
the default"**: jack drops the key from the config file rather than storing a
blank. `completedPath` is the exception, since it has no default and so can't be
cleared. If your config has no `downloads` block at all, the section offers
***Turn on downloads***. It prefills ***Completed folder*** with `/data/jack`,
the folder the Unraid template mounts; with the compose file from
[Getting started](/guide/getting-started), change it to a path under
`/data/torrents`.

Each duration field shows its unit after the number: seconds, minutes or
hours. jack-ui converts the value to the milliseconds the config file stores.

jack only saves a ***Completed folder*** it can write to. Otherwise the field
shows ***jack can't write to /data/jack. Check the Downloads path in the jack
template.*** and nothing is saved.

One ***Save changes*** covers the form and only lights up once something
changed; ***Revert*** discards your edits. ***Downloads at once*** and
***Remove jack's copy*** take effect the moment you save. **Every other key
here is read at startup, so restart the jack container** to apply it. After
saving, the message names what still needs a restart, and so does the bar at
the top of every page until you restart.

## Settings -> Radarr & Sonarr

With downloads on, saving a Radarr or Sonarr that has ***Download from friends
into this Radarr*** and ***Auto-register jack in this Radarr*** on adds jack
there as an indexer and a download client. jack then asks Radarr to test both,
the check behind Radarr's own ***Test*** buttons. The dialog waits for the
tests, up to about 30 seconds, and shows the result: ***jack is set up in
Radarr.***, or what failed with a button to the setting that fixes it. If the
tests take longer, the card shows the result once it's in. While downloads are
off, the dialog says so and offers ***Turn on downloads***.

The server's card then shows:

- What jack set up there, for example
  `jack in Radarr: indexer ✓ · download client ✓`. Other states:
  - `skipped (downloads off)`: downloads are off, so jack added nothing.
  - `download client waits for a restart`: downloads were turned on after
    jack started.
  - `failed`: jack couldn't add that part, or Radarr's test of it failed. The
    reason follows on the next line.
- When Radarr last reached jack with the key jack gave it, for example
  ***Radarr last reached jack 3 min ago***. If it still hasn't ten minutes
  after jack added itself, the card says so, with a ***Change the address***
  link.
- ***Register again***, which adds jack and runs the tests again, for example
  after you fixed the address or Radarr was down.

[`servers[].autoregister`](/reference/configuration#servers-autoregister)
lists every time jack registers itself.

## Settings -> Quick linking

This section holds the [`jack.external`](/reference/configuration#jack-external)
profile, meaning the ***Instance name***, ***External URL***, and any ***Proxy
headers*** a friend's jack needs to reach you, along with the two buttons that
use it:

- ***Generate quick link*** issues a fresh peer API key and encodes it, together
  with the profile, into a single shareable string. It's enabled only once the
  profile is saved, with a line under the button saying what is missing until
  then. The link is revealed exactly once.
- ***Add via quick link*** decodes a link a friend sent you and opens the
  ***Add a friend*** form prefilled, for you to review before saving.

***Save changes*** stores the profile and only lights up once something
changed; ***Revert*** discards your edits.

Treat a generated link as a credential. [Quick links](/guide/quick-links) covers
the full workflow and how to revoke one.

## Secret fields

Fields that hold a secret, such as an API key, an access key, a proxy header
value or a webhook URL, are masked; the eye button shows the value. ***Use a
container variable or file instead*** under the field picks where jack reads
it from:

- ***Typed here***: the value itself, stored in the config file.
- ***Container variable***: the name of an environment variable in the jack
  container, stored as `{ "env": "NAME" }`.
- ***File in the container***: a path inside the jack container, such as a
  Docker secret, stored as `{ "file": "/run/secrets/name" }`.

A field whose stored value already comes from a variable or file opens with
that choice shown. These are the
[`ConfigSecret`](/reference/configuration#configsecret) forms.

## Access control

The UI supports two auth modes, depending on where the management key comes
from:

1. **Injected**, which feels authless. Set `JACK_MANAGEMENT_KEY` in the UI's
   env; the compose file wires this for you. The UI adds the key on every
   request and the browser is never prompted, so put a proxy such as Cloudflare
   Access or Traefik forward-auth in front of it to gate access.
2. **Cookie prompt.** Leave `JACK_MANAGEMENT_KEY` unset. The browser is
   prompted for the key once (***Enter the Management key***); it's validated
   against the management API and stored in a sealed `HttpOnly` cookie. Set
   `JACK_SESSION_KEY` in production, at least 32 characters, to seal that
   cookie.

When the UI can't use the management API, it shows ***jack-ui can't reach
jack***, with the address it tried and what to check, or ***jack rejected
jack-ui's key*** when the injected key doesn't match jack's. See
[Troubleshooting](/guide/troubleshooting#jack-ui-shows-a-connection-error).

## How it works

The UI is a Nuxt **backend-for-frontend**: a small server that serves the
browser app and proxies every call it makes.

Nothing management-related is ever exposed to your browser directly. The
browser only talks to the BFF; the BFF forwards each request to jack's
[management API](#management-api) and attaches the `X-Management-Key`
credential server-side, either injected from its environment or unsealed from
the session cookie, depending on the [access-control mode](#access-control).
The browser never holds the key in plain text.

The UI talks *only* to the management API. The public peer/Torznab port is a
separate listener the UI never touches.

See [`apps/ui/README.md`](https://github.com/roziscoding/jack/blob/main/apps/ui/README.md)
for the full UI configuration reference.

## Live updates

The UI doesn't poll. Every page keeps the overview
[Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
stream open through the BFF, for the restart bar and the ***Dashboard***.
***Downloads***, ***Live traffic*** and ***Settings*** open a stream of their
own. jack pushes a fresh snapshot the moment something changes: a download's
progress, a connection's state, or a friend or Radarr/Sonarr you just edited.
There is no refresh interval to tune and no manual refresh button.

The streams are plain `GET` endpoints on the management API:

| Stream | What it pushes |
| --- | --- |
| `/overview/stream` | Connector overview, registration results, download state and pending restarts |
| `/downloads/stream` | Every persisted download change |
| `/transfers/stream` | Running uploads and downloads, every second while any run |
| `/config/stream` | Peer and server config changes, and each server's registration results |

Each sends its current snapshot immediately on connect, then a full snapshot per
change, with no deltas to reassemble. A `ping` event every 15 seconds keeps idle
proxies from dropping the connection. The Logs page tails `/logs/stream`, which
works the same way except each event is a single log line rather than a
snapshot.

The browser reconnects on its own if a stream drops. ***Dashboard***,
***Downloads***, ***Live traffic*** and ***Logs*** show a badge in the header:

- ***Connecting...*** until the stream opens for the first time.
- ***Live*** while it's open.
- ***Reconnecting...*** after it dropped, until it's back.

A page that can't load at all shows ***Can't reach jack. It may be restarting.
Retrying automatically...*** and tries again every 5 seconds; ***Retry now***
tries at once.

**Behind a reverse proxy:** SSE needs response buffering **off** and an idle
timeout **longer than 15 seconds** on whatever sits in front of the UI. jack
sends `X-Accel-Buffering: no` (nginx and compatible proxies honour it) and the
BFF forwards that header, but proxies that buffer regardless, or cut idle
connections early, will leave the UI stuck on ***Reconnecting...***. See
[Troubleshooting](/guide/troubleshooting#management-ui-stuck-on-reconnecting).

## Management API

The UI's backing API, the **management API**, is a separate listener on its
own port (`MANAGEMENT_PORT`, default `5226`), started only when
`JACK_MANAGEMENT_KEY` is set. It can read and rewrite your whole config,
including connector credentials, so treat it as an admin socket:

Anyone who can reach it with the key controls your jack, and can read the
config, redirect downloads, or point your *arr connectors elsewhere. A single
bug in its auth check would hand that to anyone who can reach it at all.

That's why the default compose setup is the way it is, and why you shouldn't
change it: it publishes no host port for `5226`, so the management API is
reachable only from inside the Docker network, which holds exactly the one thing
that needs it, the UI's BFF. If you want remote management, expose the **UI**
behind an authenticating proxy and let it do the talking.

If you truly need to expose the management API itself, don't let its key be
the only lock. Put an independent auth layer in front, such as Cloudflare
Access, Authelia, or Traefik forward-auth, so a bug in jack's auth isn't a bug
in *your* perimeter. No code is immune to bugs; defense in depth is the
point.
