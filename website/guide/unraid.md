---
description: Install jack on Unraid from the templates, connect Radarr and Sonarr, put it behind a reverse proxy and connect to friends.
---

# Installing on Unraid

This guide installs jack on Unraid from ready-made templates, connects it to
your Radarr and Sonarr, and gets you connected to a friend. It takes about
fifteen minutes. Everything after the install is done in jack's web interface;
you never have to edit a config file.

jack runs as two containers:

- **jack**: the server. Your Radarr/Sonarr and your friends' jacks talk to it.
- **jack-ui**: the web interface, for you only, on your LAN.

The images are `leetdonkey/jack` and `leetdonkey/jack-ui` on Docker Hub, so
Unraid's update button keeps them current.

## Before you start

You'll need:

- **Unraid 6.12 or newer.**
- **Radarr and/or Sonarr**, and their API keys (***Settings -> General ->
  API Key*** in each).
- **The paths your Radarr and Sonarr use inside their containers**, both for
  your libraries (their root folders, e.g. `/movies` or `/data/media/tv`) and
  for downloads. Open the Radarr container's ***Edit*** page in the Docker tab
  and note each *Container Path* and the share it points to.
- **To share with friends over the internet:** a domain name and a reverse
  proxy with HTTPS, such as Nginx Proxy Manager. You can install and try jack
  without one.

## 1. Create the jack network

jack-ui reaches jack's management API over a private Docker network, so that
API is never published on your server. Open the terminal (the `>_` icon at the
top of the Unraid UI) and run:

```bash
docker network create jack
```

You only do this once; the network survives reboots.

## 2. Get the templates

In the same terminal, download the two templates into Unraid's user templates
folder:

```bash
cd /boot/config/plugins/dockerMan/templates-user
wget -O my-jack.xml https://raw.githubusercontent.com/LeetDonkey/jack/main/unraid/jack.xml
wget -O my-jack-ui.xml https://raw.githubusercontent.com/LeetDonkey/jack/main/unraid/jack-ui.xml
```

They now show up as ***jack*** and ***jack-ui*** under ***Docker -> Add
Container -> Template*** (in the ***User templates*** group).

## 3. Install jack

***Docker -> Add Container***, pick ***jack*** under ***Template***, and fill in:

- **Peer and \*arr port** (`5225`): leave it unless something else uses 5225.
  If you change it, use your port instead of 5225 everywhere below.
- **Appdata** (`/mnt/user/appdata/jack`): jack keeps its config, database and
  logs here and creates a default config on first start.
- **Movies** and **TV**: the libraries you share with friends.
  - The *Host Path* is the share, e.g. `/mnt/user/media/movies`.
  - The *Container Path* must be exactly what your Radarr (or Sonarr) uses for
    that folder. Click ***Edit*** next to the entry to change it. jack serves a
    file by the path your *arr reports, so a different path here means
    friends get "file not found".
  - Use ***Add another Path*** if your *arr has several root folders. Remove an
    entry you don't need. Read-only is enough: jack never changes your library.
- **Downloads** (`/data/jack`): where jack puts finished downloads for your
  Radarr/Sonarr to import. They must see the same folder at the same
  *Container Path*. If your Radarr maps `/mnt/user/downloads` to `/data`, keep
  the *Container Path* `/data/jack` and set the *Host Path* to
  `/mnt/user/downloads/jack`.
- **Management key**: a long random secret. Generate one in the terminal:

  ```bash
  openssl rand -hex 32
  ```

  Copy it somewhere; jack-ui needs the same value.

Click ***Apply***. The template runs jack as `nobody:users` (the `--user
99:100` in ***Extra Parameters***), so downloaded files get the same owner as
the rest of your shares. Unraid passes your server's time zone (***Settings ->
Date and Time***) to the container; bandwidth schedules, daily limits and the
daily summary follow it.

## 4. Install jack-ui

***Add Container*** again, pick ***jack-ui***, and fill in:

- **Web UI port** (`3000`): pick another port if 3000 is taken.
- **Management key**: the same value as in jack.

Click ***Apply***, then open the interface from the jack-ui icon in the Docker
tab (***WebUI***) or at `http://<your-server-ip>:3000`.

::: warning Keep jack-ui on your LAN
With the management key set, jack-ui doesn't ask for a login. Never add it to
your reverse proxy. If you want a login prompt anyway, leave ***Management
key*** empty in jack-ui and set ***Session key*** (under ***Show more
settings***) to another `openssl rand -hex 32` value; jack-ui then asks for the
management key in each new browser session.
:::

## 5. Connect Radarr and Sonarr

Open jack-ui. Until jack is set up, the ***Dashboard*** shows a setup card,
***Finish setting up jack***, with steps 1, 2 and 4 below, in order. Each step
has a button that opens its section of ***Settings***, and the card ticks the
step off once it's done. When every step is done, the card reads ***jack is set
up*** and offers ***Hide***. A second card, ***Share with friends***, points to
steps 6 and 7 and is optional.

Set up jack's address and downloads before you connect Radarr and Sonarr: jack
reads both when it starts, and it adds its download client to Radarr/Sonarr
only once downloads are on.

1. **jack's address.** Under ***Settings -> jack***, set ***Address
   Radarr/Sonarr use to reach jack*** to `http://<your-server-ip>:5225` and
   click ***Save***. If you opened jack-ui by IP address, the button ***Use
   http://...:5225 (if you kept port 5225)*** under the field fills in that
   address. This is the address jack registers in your Radarr/Sonarr. The
   default `http://jack:5225` only works if they run on the jack network too;
   in that case keep it and click ***Yes, on the jack network*** on the setup
   card.
2. **Downloads.** Under ***Settings -> Downloads***, click ***Turn on
   downloads***. Check that ***Completed folder*** is the *Container Path* of
   your downloads mount (`/data/jack`, filled in for you), turn on ***Remove
   jack's copy after Radarr/Sonarr import it***, and click ***Save changes***.
   With it on, jack removes its own copy once Radarr/Sonarr confirm the import:
   if they copied the file (the usual case when downloads and library are
   separate mounts in their container) that saves the space of a second copy;
   if they hardlinked it, only jack's extra link goes away.

   If you only want to share your library, click ***I only share*** on the
   setup card instead and skip this step.
3. **Restart** the jack container (Docker tab -> jack -> ***Restart***). jack-ui
   doesn't need a restart.
4. **Radarr & Sonarr.** Under ***Settings -> Radarr & Sonarr***, click
   ***Connect Radarr or Sonarr*** once for each of them:
   - ***Name***: e.g. `Radarr` or `Sonarr`.
   - ***URL***: e.g. `http://<your-server-ip>:7878` for Radarr, `:8989` for
     Sonarr.
   - ***Type***: ***Radarr*** or ***Sonarr***. It defaults to Radarr, so change
     it when you add Sonarr. The labels below name the type you pick.
   - ***API key***: from ***Settings -> General -> API Key*** in that Radarr or
     Sonarr.
   - ***Share this Radarr's library with friends***: friends can see and
     download what it has. On by default.
   - ***Download from friends into this Radarr***: jack becomes an indexer and
     download client there. On by default. While it is on, the form also
     shows:
     - ***Auto-register jack in this Radarr***, ticked by default, with its
       ***Indexer priority***: 1 is the most preferred and 50 the least. The
       form starts at 50, so your other indexers win when two releases are
       otherwise equal.
     - ***Releases from friends***: whether friends' copies of movies or
       episodes you already have are offered as upgrades. ***Offer upgrades up
       to a size*** keeps a friend's 60 GB remux from replacing your 10 GB
       file.

   Click ***Connect Radarr*** (or ***Connect Sonarr***). With auto-register
   ticked, jack registers itself there right away: you'll find ***Jack*** under
   ***Settings -> Indexers*** and under ***Settings -> Download Clients*** in
   Radarr or Sonarr.

::: tip Radarr, Sonarr or a proxy with their own IP
If a container runs on `br0` (or another custom network) with its own IP, use
that IP instead of `<your-server-ip>`, and turn on ***Host access to custom
networks*** in ***Settings -> Docker*** (switch to ***Advanced View*** and stop
Docker to change it). Without it, containers on `br0` and containers using the
server's IP can't reach each other.
:::

## 6. Open jack to your friends

Your friends' jacks reach yours through your reverse proxy. On your router,
forward ports 80 and 443 to the HTTP and HTTPS ports of your Nginx Proxy
Manager container (the host ports from its template, not the Unraid web UI's
own 80/443). Port 80 is needed to get the Let's Encrypt certificate; you can
skip it if you use ***Use a DNS Challenge***. Never forward 5225 itself.

In Nginx Proxy Manager, add a ***Proxy Host***:

- ***Domain***: e.g. `jack.example.com`.
- ***Forward Hostname / IP***: your server's IP, ***Forward Port*** `5225`,
  scheme `http`.
- ***SSL***: request a Let's Encrypt certificate and turn on ***Force SSL***.
- ***Advanced***:

  ```nginx
  proxy_buffering off;
  proxy_request_buffering off;
  ```

  Without this, nginx reads up to a gigabyte ahead from jack. ***Live
  traffic*** then shows the wrong speed, upload limits are off, and nginx
  writes large temporary files.

Your friends only need `/ping`, `/handshake` and `/peer/`. The Torznab
(`/torznab`) and qBittorrent (`/api/v2`) paths are for your own Radarr/Sonarr on
the LAN; you can block them in the proxy host with ***Custom locations*** that
return 403.

Then, in jack-ui, ***Settings -> Quick linking***: set ***Instance name*** (the
name friends see for you) and ***External URL*** (`https://jack.example.com`),
and click ***Save***.

## 7. Connect to a friend

A quick link carries everything a friend's jack needs to reach yours: your
external URL and an access key made for them.

1. ***Settings -> Quick linking -> Generate quick link***. Fill in ***Who is
   this link for?*** with your friend's name (so you can limit or revoke their
   access later), click ***Generate link***, then ***Copy quick link*** and
   send them the `jack-link:` text. The link is shown only once, so send it
   before closing the dialog.
2. They do the same and send you theirs. Click ***Settings -> Quick linking ->
   Add via quick link***, paste it, click ***Continue***, check the name and
   click ***Add friend***. Saving connects to their jack, so their reverse
   proxy must already work. If their jack can't be reached yet, click ***Add
   anyway, keep trying*** and jack keeps retrying.
3. ***Settings -> Friends you download from*** shows them as connected right
   away. The ***Friends*** page shows them as online after its next check,
   within five minutes. Their library appears under ***Friends' library***
   (the first load can take a minute while their Radarr/Sonarr list
   everything).

From then on, your Radarr/Sonarr find your friends' releases through the Jack
indexer, and grabs download through jack.

If you and another jack user share a friend, you don't even need to exchange
links: see ***Settings -> Friends of friends***.

## 8. Worth a look

- ***Settings -> Bandwidth***: upload and download limits, a weekly schedule
  (e.g. less upload in the evening), and limits per friend.
- ***Settings -> Notifications***: Discord, ntfy or a Home Assistant webhook
  when a download fails, a friend goes offline, and a daily summary.
- ***Settings -> Security***: temporarily ban addresses that keep sending wrong
  keys.
- ***Settings -> RSS feed***: how far back friends' new releases show up in
  your *arr's RSS sync.
- ***Live traffic*** shows what's moving right now; ***Downloads*** shows
  history and lets you retry or cancel.

## Updating and backups

- Update from the Docker tab: ***Check for Updates***, then ***Update*** on
  jack and jack-ui. Downloads in progress pause during the restart and resume
  from where they were.
- To get a newer template (new settings), run the two `wget` lines from step 2
  again. Your container's values stay as they are.
- Back up `/mnt/user/appdata/jack`. It holds your config, your friends' keys
  and the download history. The Appdata Backup plugin covers it.

## Troubleshooting

- **jack stops right after starting, with "EACCES" or "permission denied" in its
  log**: the appdata folder existed before and isn't owned by `nobody:users`. Fix
  it in the terminal with `chown -R nobody:users /mnt/user/appdata/jack` and
  start jack again. (Unraid creates missing folders with the right owner.)
- **jack-ui says it can't reach jack**: both containers must be on the `jack`
  network, and the management key must be identical in both.
- **Radarr says it can't reach jack, or grabs never start**: ***Address
  Radarr/Sonarr use to reach jack*** (***Settings -> jack***) is wrong. It must
  be an address your Radarr container can reach, usually
  `http://<your-server-ip>:5225` (see the tip in step 5 for `br0`). Restart the
  jack container after you change it.
- **No Jack download client in Radarr/Sonarr**: downloads were off when jack
  started. Click ***Turn on downloads*** under ***Settings -> Downloads***,
  save, and restart the jack container; jack adds the download client when it
  starts.
- **Downloads finish but Radarr doesn't import them**: the downloads folder
  doesn't match. jack's ***Completed folder***, its downloads *Container Path*
  and the path your Radarr sees must all be the same.
- **Friends get "can't find this file on disk"**: your Movies/TV *Container
  Paths* differ from the ones in your Radarr/Sonarr.
- **A friend shows as offline**: check that `https://jack.example.com/ping`
  answers `{"status":"OK"}` from outside your network, and that the quick link
  they imported is current.
- **Everything else**: ***Logs*** in jack-ui shows what jack is doing, and the
  jack container's log (Docker tab -> jack -> ***Logs***) shows the same.
