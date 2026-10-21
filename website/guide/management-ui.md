---
description: Manage Radarr and Sonarr, friends, invite links, downloads, requests from friends' libraries, and logs from jack's self-hosted web console, with live updates over Server-Sent Events.
---

# Management UI

jack ships with a web console, the **management UI**, so you can run your
instance without hand-editing `config.jsonc`. With the
[Getting started](./getting-started.md) compose file it runs as the
`jack-ui` service at **http://localhost:3000**, and it's the easiest way to
operate jack day to day:

- ***Dashboard***:
  - ***Finish setting up jack***: the setup steps left, until jack is ready. An
    optional ***Share with friends*** card follows.
  - ***Needs attention***: what is failing, including a Radarr/Sonarr that jack
    couldn't set itself up in. When the only thing to report is a Radarr/Sonarr
    that skips jack's indexer for now, the card is ***Worth knowing*** instead.
    While jack doesn't answer, the card is marked ***last known***.
  - ***Right now***: speeds both ways, how many downloads are downloading,
    waiting, queued for import or failed, and the running downloads with speed
    and time left. Each count opens ***Downloads*** with that filter. While
    every count is 0, the counts are hidden.
  - ***Friends & Radarr/Sonarr***: each friend's status and when jack last
    reached them, and when each Radarr/Sonarr last reached jack.
  - ***Lifetime***: what you downloaded from and shared with friends, and how
    many downloads started and were imported, once anything has moved.
- ***Friends' library***: everything your friends share, to search and request
  into your library ([below](#friends-library)).
- ***Downloads***: every download with its status and actions
  ([below](#downloads)).
- ***Live traffic***: what is moving right now, in both directions, with the
  pause buttons ([below](#live-traffic)).
- ***Friends***: one card per friend, and friends of friends
  ([below](#friends)).
- ***Logs***: live-tail the backend's logs. A line with a known fix has a help
  icon; click the line for a link to the fix. ***Copy support info*** is in the
  header ([below](#support-info)).
- ***Settings***, in tabs:
  - ***Radarr & Sonarr***:
    - ***Address Radarr/Sonarr use to reach jack***
      ([`jack.internalUrl`](../reference/configuration.md#jack-internalurl)). It
      applies right away.
    - ***Downloads***: the whole
      [`downloads`](../reference/configuration.md#downloads) block, and the
      folder check ([below](#settings-radarr-sonarr-downloads)).
    - ***Radarr & Sonarr***: add, edit, and remove your Radarr/Sonarr
      connections, and see what jack set up in each
      ([below](#settings-radarr-sonarr)).
  - ***Sharing***:
    - ***Your public address***: how friends' jacks reach yours
      ([below](#settings-sharing)).
    - ***Friends of friends***: the
      [`discovery`](../reference/configuration.md#discovery) block.
    - ***Security***: the [`security`](../reference/configuration.md#security)
      block, and the banned addresses with ***Lift ban***. ***Trusted
      proxies***, ***Never ban*** and ***Radarr/Sonarr outside your LAN*** are
      folded away under ***Reverse proxy and exceptions***. A link to one of
      them, such as the help on a refused Radarr/Sonarr line in ***Logs***,
      opens it.
  - ***Bandwidth***: the [`bandwidth`](../reference/configuration.md#bandwidth)
    block, and ***Pause sharing*** and ***Pause downloads***.
  - ***Notifications***: the
    [`notifications`](../reference/configuration.md#notifications) block.
  - ***Advanced***:
    - ***RSS feed***: the
      [`torznab`](../reference/configuration.md#torznab) block.
    - ***API keys for other tools***: keys that aren't on a friend's card
      ([below](#settings-advanced)).
    - ***About***: which build jack and jack-ui run, and ***Copy support
      info***.

Links to a setting from elsewhere in the UI, such as the setup card on the
***Dashboard***, open the right tab of ***Settings*** scrolled to that section.
Older links to the single ***Settings*** page land on the tab that holds the
section now.

Each section of ***Settings*** saves on its own. Switching tabs or leaving
***Settings*** while a section has unsaved changes asks first, naming the
sections, for example ***Leave without saving Downloads?*** with ***Stay*** and
***Leave without saving***. Reloading or closing the tab gets the browser's own
prompt instead. A dialog such as ***Connect Radarr or Sonarr*** stays open on a
click outside it or on Escape once you've changed a field; close it with its
own buttons.

Some settings only apply when jack starts, such as turning on downloads or a
new ***Completed folder***. Once you save one, a bar at the top of every page
names them, for example ***jack needs a restart to apply: Downloads***, until
you restart the jack container. jack-ui then shows ***jack restarted. New
settings are active.*** jack-ui itself never needs a restart.

When an update changes the default of a setting you never set yourself, a note
at the top of every page lists it under ***jack's update changed some
settings***, with a ***Change*** link to its switch. Saving the setting takes
it off the list. ***Dismiss*** hides the note for good. A new install never
shows it.

Don't want it? Delete the `jack-ui` service and the backend's
`JACK_MANAGEMENT_KEY` line to run jack headless.

## Friends' library

***Friends' library*** shows every movie and show your friends share, one card
per title, with every friend who has it. The toolbar narrows the list:

- ***Search titles or years***: each word you type must appear in the title or
  the year.
- ***All***, ***Movies*** or ***TV***.
- The sort: ***Recently added*** (the default), ***Title***, ***Year*** or
  ***Rating***. ***Title*** ignores leading punctuation and a leading "The",
  "A" or "An". The browser remembers your choice.
- With two or more friends, ***All friends*** or one friend's name.

Click a title, then ***Download*** next to a friend's copy. The dialog asks
which Radarr or Sonarr to send it to and its root folder. For a show, jack
queues every episode that friend has. The confirmation, such as ***Sent to
Radarr.***, has ***View downloads***.

When jack can't download a title, the panel says why above ***Download***,
with the button that fixes it:

- Downloads are off: ***Turn on downloads***.
- Downloads were turned on after jack started: restart the jack container.
- No Radarr (or Sonarr) has ***Download from friends into this Radarr*** on,
  or jack can't reach the one that has: ***Open Radarr & Sonarr***.

When a friend's jack doesn't answer, a banner such as ***Alice is offline.
Showing their library from 3 hours ago.*** keeps their titles on the page.
***Download*** stays available, with a warning that it may fail until they're
back.

## Downloads

***Downloads*** opens on ***Active***: what is downloading, waiting for import
or failed. The other filters are ***Downloading***, ***Waiting***, ***Import
queued***, ***Failed***, ***Cancelled***, ***Imported*** and ***All***.
***Waiting*** holds the downloads that wait for a free slot or to retry, and
***Downloading*** the rest of the running ones, as the ***Dashboard*** counts
them. A link such as `/downloads?status=failed` opens a filter directly; the
***Dashboard*** uses these.

Each row shows its status:

- ***Downloading***, with speed and time left under the progress bar.
- ***Waiting for a free slot***: more downloads are running than ***Downloads
  at once*** allows.
- ***Paused***: downloads are paused, and this one starts or retries when you
  resume them.
- ***Retrying at 14:32***: the last attempt hit a network error, a timeout, a
  busy friend, or a file the friend's jack couldn't find. The line under the
  file name says which attempt failed and why.
- ***Import queued***: finished, and waiting for Radarr/Sonarr to import it.
- ***Imported***.
- ***Failed***, with the error.
- ***Cancelled***: you cancelled it. It doesn't count as failed.

Common errors read in plain words, such as ***The connection to Alice
dropped.*** jack's own error text shows when you hover the line, and under
***Details*** on narrower screens, unless it says the same as the plain words.

While downloads are paused and the list shows a running or waiting download,
the top of the page says until when, for example ***Downloads paused until
18:30***, with ***Resume*** next to it.

The actions:

- ***Retry now*** starts the next attempt of a download that waits to retry,
  instead of at the time shown. It still waits for a free slot, ahead of new
  downloads. It isn't offered while downloads are paused.
- ***Cancel*** stops a running download after asking ***Cancel this
  download?***. The partial file is kept, and Radarr/Sonarr show the download
  as paused.
- ***Retry*** starts a failed or cancelled download again. A cancelled one
  continues from the partial file. Under ***Active*** and ***Failed***,
  ***Retry all failed*** retries every failed download that can be retried.
- ***Remove***, in the ***...*** menu, removes the row and jack's own copy of
  the file, partial or finished. What Radarr/Sonarr already imported stays in
  your library.

## Live traffic

***Live traffic*** lists what you download from friends and share with them
right now, with the friend, progress, speed and time left. The cards show how
many run at once, for example ***1 of 3 at once***, and the current limit. A
link under them opens ***Settings -> Bandwidth***. While a bandwidth schedule
period applies, the line names it and the link reads ***Edit schedule***.

The header has ***Pause sharing*** and ***Pause downloads***, and so does
***Settings -> Bandwidth***. Each pauses ***For 1 hour***, ***For 4 hours***,
until the next 08:00, or ***Until I resume***:

- **Sharing paused**: friends' jacks are told sharing is paused and try again
  later. Uploads already running finish. A friend's jack gives up on a
  download after about 24 hours, so ***Until I resume*** warns about that.
- **Downloads paused**: new downloads wait in the queue as ***Paused***.
  Downloads already running finish. The button only shows while downloads are
  on.

While a pause lasts, the button reads, for example, ***Sharing paused until
18:30***, with ***Resume*** next to it. The ***Dashboard*** says so under
***Right now***. A pause survives a restart of jack.

## Friends

***Friends*** shows one card per friend, with both directions together: the
jack you download from, and the keys that let your friend download from you.
The badge says where you stand:

- ***Connected both ways***: you download from them, and their jack used your
  key in the last 24 hours.
- ***Waiting for Alice***: you download from Alice and sent them a link, but
  their jack has never used your key. The card offers ***Send a new link*** in
  case they lost it.
- ***Only one way***: one direction is missing, and the card offers the
  button that adds it:
  - ***Paste Alice's link*** when you don't download from Alice yet.
  - ***Send Alice a link*** when Alice can't download from you yet.
- ***Only one way since 12 Oct***: you download from Alice, but their jack
  last used your key on 12 Oct, more than 24 hours ago. Their jack checks in
  every 5 minutes, so this usually means your public address or proxy stopped
  working for them, or they removed you. The card says ***Alice's jack hasn't
  connected to yours since 12 Oct.*** and offers ***Check your address***.
- When the last check of their jack failed, the badge shows the status
  instead: ***Offline since 14:02***, ***Rejected your key***, ***Is blocking
  you*** or ***Needs a newer jack***. A line under it says what to do, and
  ***Rejected your key*** comes with ***Paste new link***.

Under ***You download from Alice***, the card shows the status (***Online***,
or ***Checking...*** until the first check), when jack last reached their
jack, its address and build, and what you downloaded today, in 7 days and in
30 days. Under ***Alice downloads from you***, it shows when their jack last
used each key, such as ***Last connected 3 min ago*** or ***Never used***, what
they downloaded, and the upload limits each friend gets, with a link to
***Settings -> Bandwidth***.

jack checks every friend's jack every 5 minutes; ***Check now*** checks them
all at once. Daily totals reset at midnight in jack's time zone.

The ***...*** menu on a card has:

- ***Rename***: renames the friend, and the keys named after them.
- ***Change address or key***: edits the address and key you use for their
  jack, or takes a new link from them (***Paste it instead***).
- ***Send a new link***: see [Invite a friend](#invite-a-friend).
- ***Remove friend***: asks ***Remove Alice?*** with a box for each
  direction, all ticked:
  - ***Stop downloading from Alice***: removes their jack from your friends,
    and any other address you saved for it. Downloads in progress finish.
  - ***Revoke Alice's access (key 'Alice')***, one per key: their jack can no
    longer search or download from you.

  Untick what you want to keep, then click ***Remove***.

A key and an address with matching names aren't put together by themselves.
The card then asks, for example ***Is this the Alice you download from?***,
and ***Link*** puts both on one card.

***Not linked to a friend*** lists what isn't on a card:

- Keys made by hand, or before jack recorded which friend a key is for. Pick
  the friend whose jack uses the key under ***Link to...***, or click ***Link***
  when jack suggests one by name. These keys also show under
  ***Settings -> Advanced -> API keys for other tools*** until you link them.
- A second address for a friend's jack, such as their old one. jack uses the
  one that answers; ***Remove this address*** drops the other.

***Friends of friends*** below the cards lists the people your friends
introduced, with their requests to connect. The line under it says whether they
can see you: only through a friend who has ***Introduce my friends to each
other*** on. When none of your friends do, it says so. While jack can't reach a
friend's jack, requests and messages through that friend wait. The people they
introduced stay listed from their last answer until jack restarts. After a
restart, they show again once jack reaches that friend.

### Invite a friend

***Invite a friend*** makes an [invite link](./quick-links.md) for one
friend:

1. If ***Name friends see*** or ***Address friends use*** is missing, the
   dialog asks for them first (***First, set the address friends use***, then
   ***Save and continue***).
2. ***Who is this link for?***: your friend's name. It names the key the link
   carries and their card.
3. ***Create invite link***, then ***Copy link***, and send it. The link is
   shown once.

When the name matches a friend you already download from, ***This is the Alice
you download from*** (ticked) puts the new key on their card. When it matches
a friend who already has a key, the dialog offers ***Send a new link
instead***.

***Send a new link*** on a friend's card makes a link with a new key. jack
revokes the old key if their jack never used it. If it did, or jack can't
tell, the dialog asks: ***Replace*** revokes the old key, ***Keep both***
leaves it working.

### Add a friend

***Add a friend*** takes the link a friend sent you: paste it into ***Paste
the link your friend sent***, click ***Continue***, check the name and address,
and click ***Add friend***. ***Add without a link*** opens an empty form for an
address and key typed by hand.

Saving connects to their jack. If it doesn't answer, the dialog says why, for
example that the address doesn't resolve or the connection was refused. For a
problem that may be temporary, ***Add anyway, keep trying*** saves the friend
and jack keeps retrying; ***Back to edit*** returns to the form. When their
jack answers but refuses, for example because it doesn't accept the key, the
dialog says so and doesn't offer ***Add anyway, keep trying***.

If you haven't sent that friend a link yet, the dialog then offers ***Invite
Alice***.

Links elsewhere in the UI open these dialogs directly: `/friends?action=invite`
and `/friends?action=add`.

## Settings -> Radarr & Sonarr -> Downloads

The whole [`downloads`](../reference/configuration.md#downloads) block is
editable here, so there's no reason to hand-edit `config.jsonc` for it:

- The settings you actually choose sit at the top: ***Completed folder***,
  ***Downloads at once***, and the
  ***[Remove jack's copy after Radarr/Sonarr import it](../reference/configuration.md#downloads-unlinkimportedfiles)***
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
[Getting started](./getting-started.md), change it to a path under
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

### Folder check

***Folder check*** under the form checks, with the saved settings:

- that jack sees each library a Radarr/Sonarr shares, at the path that
  Radarr/Sonarr uses, and can read a file or two from it.
- that each Radarr/Sonarr that receives downloads sees the ***Completed
  folder*** at the same path as jack. jack writes a test file there and asks
  Radarr/Sonarr to list it.

***Check folders*** runs it, which can take up to 30 seconds. It shows ***All
folders line up.*** or the first problem, naming the path and the template to
change, and ***Show details*** lists every check. With no Radarr/Sonarr
connected yet, it says that jack can write to the ***Completed folder*** and
asks you to connect one. It also runs by itself after
you save a new ***Completed folder***, and after you connect a Radarr/Sonarr or
change its address or roles. Each card under ***Radarr & Sonarr*** shows the
result too, until you reload the page. The setup card on the ***Dashboard***
keeps a problem in that browser after a reload, with how long ago it was
checked and ***Check again***, and setup doesn't count as finished until a
check passes. With downloads off, ***Check folders*** sits above the cards
under ***Radarr & Sonarr*** instead.

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
  - `indexer skipped · download client failed`: downloads were turned on
    after jack started, and Radarr refused jack's download client, which jack
    serves only after a restart.
  - `download client waits for a restart`: Radarr already had jack's download
    client, and downloads were turned on after jack started.
  - `failed`: jack couldn't add that part, or Radarr's test of it failed. The
    reason follows on the next line.
- When Radarr last reached jack with the key jack gave it, for example
  ***Radarr last reached jack 3 min ago***. If it still hasn't ten minutes
  after jack added itself, the card says so, with a ***Change the address***
  link.
- ***Register again***, which adds jack and runs the tests again, for example
  after you fixed the address or Radarr was down.
- The result of the last [folder check](#folder-check) for that server.

[`servers[].autoregister`](../reference/configuration.md#servers-autoregister)
lists every time jack registers itself.

## Settings -> Sharing

***Your public address*** holds the
[`jack.external`](../reference/configuration.md#jack-external) profile that
invite links carry:

- ***Name friends see***: how you show up when a friend adds you, at most 60
  characters.
- ***Address friends use***: your public jack address, for example
  `https://jack.example.com`.
- ***Proxy headers (optional)***: headers a friend's jack must send to get
  through your proxy. Every invite link you create includes them.

***Check*** under the address has jack fetch `/ping` there with those
headers, the way a friend's jack would, within 10 seconds. It checks what you
typed, saved or not, and shows ***Answers from this server.*** or what went
wrong. The request starts on your server, so it can't show whether friends
outside your network get through; your friend's import is the real test.

***Save changes*** stores the profile and only lights up once something
changed; ***Revert*** discards your edits. ***Remove*** deletes the profile.
Friends who already have one of your links keep their access, but until you set
an address again you can't create invite links or connect with friends of
friends.

Friends of friends see you under ***Name friends see*** as well. ***Use a
different name for friends of friends*** in the ***Friends of friends***
section sets another one.

## Settings -> Advanced

***API keys for other tools*** lists the keys that aren't on a friend's card:
keys for a script or another tool, and friends' keys made before jack recorded
which friend a key is for. ***Create key*** makes one and shows it once. The
pencil edits a key's name, description and expiration, and the bin revokes it.
Each key counts as one friend for the per-friend upload limits. To let a friend
download from you, use ***Invite a friend*** on ***Friends*** instead.

***About*** shows which build each container runs, for example `jack build
4ca4a2a (17 Oct) · UI build 4ca4a2a`, and warns ***jack and jack-ui run
different builds. Update both containers.*** when they differ. It also holds
the TMDB attribution while jack uses a TMDB key, and ***Copy support info***.

## Support info

***Copy support info***, in the ***Logs*** header and under ***Settings ->
Advanced -> About***, copies a summary to paste into a message to whoever
helps you:

- jack's build, time zone, and the host of the address Radarr/Sonarr use.
- Whether downloads are on, a restart is pending, or anything is paused.
- Each Radarr/Sonarr: its roles, whether it's connected, and what jack set up
  in it.
- Each friend: status, last error and build.
- Each key's name and when it was last used.
- The last 50 warnings and errors from the log, and the lines that say a
  Radarr, Sonarr or friend that failed to connect is reachable again.

Keys, header values and webhook URLs are left out. Error messages and log
lines can still contain the addresses of your Radarr, Sonarr and friends, so
read it before you post it anywhere public.

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
[`ConfigSecret`](../reference/configuration.md#configsecret) forms.

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
   cookie. With an empty or shorter value, the UI shows ***jack-ui is missing
   a key*** instead of the prompt.

When the UI can't use the management API, it shows ***jack-ui can't reach
jack***, with the address it tried and what to check, or ***jack rejected
jack-ui's key*** when the injected key doesn't match jack's. See
[Troubleshooting](./troubleshooting.md#jack-ui-shows-a-connection-error).

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

Every page keeps the overview
[Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
stream open through the BFF, for the restart bar, the ***Dashboard*** and
friends' status. ***Downloads***, ***Live traffic***, ***Settings*** and the
pause buttons open a stream of their own. jack pushes a fresh snapshot the
moment something changes: a download's progress, a connection's state, a pause,
or a friend or Radarr/Sonarr you just edited. ***Friends*** also reloads every
30 seconds for the traffic totals. There is no refresh interval to tune.

The streams are plain `GET` endpoints on the management API:

| Stream | What it pushes |
| --- | --- |
| `/overview/stream` | Connector overview, friends' health after every check, registration results, download state and pending restarts |
| `/downloads/stream` | Every persisted download change |
| `/transfers/stream` | Running uploads and downloads, every second while any run, and every pause and resume |
| `/config/stream` | Peer and server config changes, and each server's registration results |

Each sends its current snapshot immediately on connect, then a full snapshot per
change, with no deltas to reassemble. A `ping` event every 15 seconds keeps idle
proxies from dropping the connection. When jack stops, it ends every open
stream before it exits, so clients see the stream finish and reconnect. The
Logs page tails `/logs/stream`, which works the same way except each event is a
single log line rather than a snapshot.

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
[Troubleshooting](./troubleshooting.md#management-ui-stuck-on-reconnecting).

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
