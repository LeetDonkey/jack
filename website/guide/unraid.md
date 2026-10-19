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
- **Internal URL**: `http://<your-server-ip>:5225`, the address your
  Radarr/Sonarr use to reach jack. jack reads it when it creates its config on
  first start; after that you change it in jack-ui.
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
tab (***WebUI***) or at `http://<your-server-ip>:3000`. If it shows ***jack-ui
can't reach jack*** or ***jack rejected jack-ui's key*** instead, see
[Troubleshooting](#troubleshooting).

::: warning Keep jack-ui on your LAN
With the management key set, jack-ui doesn't ask for a login. Never add it to
your reverse proxy. If you want a login prompt anyway, leave ***Management
key*** empty in jack-ui and set ***Session key*** (under ***Show more
settings***) to another `openssl rand -hex 32` value; jack-ui then asks for the
management key in each new browser session.
:::

## 5. Connect Radarr and Sonarr

Open jack-ui. Until jack is set up, the ***Dashboard*** shows a setup card,
***Finish setting up jack***, with steps 1 to 3 below, in order. Each step has
a button that opens its section of ***Settings***, and the card ticks the step
off once it's done. Once Radarr or Sonarr has tested jack's address, step 1
follows that test: it ticks off when the test passed and shows the test's
message when it failed. When every step is done, the card reads ***jack is set
up*** and offers ***Hide***. A second card, ***Share with friends***, points to
steps 6 and 7 and is optional.

Some settings, such as turning on downloads, only apply when jack starts. Until
you restart the jack container (Docker tab -> jack -> ***Restart***), a bar at
the top of every page names them, for example ***jack needs a restart to
apply: Downloads***, and the setup card adds the step ***Restart the jack
container***. Once jack is back, jack-ui shows ***jack restarted. New settings
are active.*** jack-ui itself never needs a restart.

1. **jack's address.** At the top of ***Settings -> Radarr & Sonarr***, check
   that ***Address Radarr/Sonarr use to reach jack*** is
   `http://<your-server-ip>:5225` (the ***Internal URL*** you set in the
   template). If it shows the default `http://jack:5225`, change it and click
   ***Save changes***. If you opened jack-ui by IP address, a button under the
   field fills in that address, for example ***Use http://192.168.1.10:5225
   (if you kept port 5225)***. The default only works if Radarr and Sonarr run on the jack network
   too; in that case keep it and click ***Yes, on the jack network*** on the
   setup card. A new address applies right away: jack updates its indexer and
   download client in every Radarr/Sonarr it is registered in.
2. **Downloads.** On first start jack turns on downloads with ***Completed
   folder*** `/data/jack`, the *Container Path* of your downloads mount. Under
   ***Settings -> Radarr & Sonarr -> Downloads***, turn on ***Remove jack's
   copy after Radarr/Sonarr import it*** and click ***Save changes***. With it
   on, jack removes its own copy once Radarr/Sonarr confirm the import: if they
   copied the file (the usual case when downloads and library are separate
   mounts in their container) that saves the space of a second copy; if they
   hardlinked it, only jack's extra link goes away.

   If the section offers ***Turn on downloads*** instead (the config is from an
   older jack, or jack couldn't write to `/data/jack` on first start), click
   it, check that ***Completed folder*** is `/data/jack`, and click ***Save
   changes***. If jack can't write to that folder, the field says so and
   nothing is saved: check the ***Downloads*** path in the jack template. After
   saving, restart the jack container. Radarr and Sonarr can only use jack's
   download client after that restart.

   If you only want to share your library, click ***I only share*** on the
   setup card instead and skip this step.
3. **Radarr & Sonarr.** Under ***Settings -> Radarr & Sonarr***, click
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
   ticked, jack adds itself there as ***Jack*** under ***Settings ->
   Indexers*** and ***Settings -> Download Clients***, and asks Radarr to test
   both. Meanwhile the button reads ***Connecting and testing...***; this can
   take up to 30 seconds. The dialog then shows the result:

   - ***jack is set up in Radarr.*** when both tests passed. Click ***Done***.
   - ***Restart the jack container so Radarr can use jack's download
     client.*** when you turned on downloads in step 2 and haven't restarted
     jack since.
   - Otherwise what went wrong, in plain words, with a button to the setting
     that fixes it, such as ***Change the address*** for step 1.

   If Radarr takes longer to test, the dialog says so and the card shows the
   result once it's in. The setup card ticks off step 3 once jack's download
   client is in Radarr or Sonarr.

   Radarr's card under ***Radarr & Sonarr*** keeps the result, for example
   `jack in Radarr: indexer ✓ · download client ✓`, and shows when Radarr last
   reached jack. If Radarr still hasn't reached jack ten minutes after jack
   added itself, the card says so and links to step 1. ***Register again*** on
   the card adds jack and runs the tests again, for example after you changed
   the address.

   Each time you connect a Radarr or Sonarr, jack-ui also checks the folders:
   that jack sees each library at the path Radarr and Sonarr use, and that
   they see the ***Completed folder*** at the same path as jack. The setup card
   and each card under ***Radarr & Sonarr*** show the result: ***All folders
   line up.***, or the first problem with the path and the template to change.
   After changing a template, click ***Check folders*** on the setup card, or
   under ***Settings -> Radarr & Sonarr -> Downloads***, to check again.

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
the LAN, and jack refuses them to every other address, also through the proxy
(***Settings -> Sharing -> Security -> Radarr/Sonarr APIs only on your LAN***).

Then, in jack-ui, open ***Settings -> Sharing -> Your public address***: set
***Name friends see*** and ***Address friends use***
(`https://jack.example.com`), and click ***Save changes***.

***Check*** under the address has jack fetch `/ping` there, the way a friend's
jack would, and shows ***Answers from this server.*** or what went wrong, with
a ***Help*** link to this step. The request starts on your server, so it
can't show whether friends outside your network get through. If your router
doesn't route your own domain back to your server (NAT loopback), the check
fails even though friends can reach you.

## 7. Connect to a friend

An invite link carries everything a friend's jack needs to reach yours: your
public address and an access key made for them. You each send the other a
link, so you can download from each other.

1. ***Friends -> Invite a friend***. Fill in ***Who is this link for?*** with
   your friend's name (so you can limit or revoke their access later), click
   ***Create invite link***, then ***Copy link***, and send them the
   `jack-link:` text in a private message. The link is shown only once, so
   send it before closing the dialog. If you skipped step 6, the dialog asks
   for ***Name friends see*** and ***Address friends use*** first.
2. Your friend now has a card on ***Friends*** that reads ***You don't
   download from Alice yet.*** When their link arrives, click ***Paste Alice's
   link*** on that card, paste it, click ***Continue***, check the name and
   click ***Add friend***. Saving connects to their jack, so their reverse
   proxy must already work. If their jack can't be reached yet, click ***Add
   anyway, keep trying*** and jack keeps retrying.

   If their link comes before you sent yours, click ***Add a friend*** at the
   top of ***Friends*** instead. Once it's saved, the dialog offers ***Invite
   Alice*** for your side.
3. The card reads ***Connected both ways*** once you download from them and
   their jack has used your key. Until then it reads ***Waiting for Alice***
   or ***Only one way***, with a button for the side that's missing. Their
   library appears under ***Friends' library*** (the first load can take a
   minute while their Radarr/Sonarr list everything).

From then on, your Radarr/Sonarr find your friends' releases through the Jack
indexer, and grabs download through jack.

If you and another jack user share a friend, you don't even need to exchange
links: see ***Settings -> Sharing -> Friends of friends***. It is off until you
turn it on: you choose ***Let friends of friends find me***, and the friend you
have in common turns on ***Introduce my friends to each other***.

## 8. Worth a look

- ***Settings -> Bandwidth***: upload and download limits, a weekly schedule
  (e.g. less upload in the evening), and limits per friend.
- ***Pause sharing*** and ***Pause downloads***, on ***Live traffic*** and
  under ***Settings -> Bandwidth***: for 1 or 4 hours, until 08:00, or until
  you resume. Transfers already running finish. While sharing is paused,
  friends' jacks wait and try again later.
- ***Settings -> Notifications***: Discord, ntfy or a JSON webhook (e.g. Home
  Assistant) when a download fails for good, a friend goes offline, and a
  daily summary.
- ***Settings -> Sharing -> Security***: on by default. Addresses that keep
  sending wrong keys are banned for an hour, the Radarr/Sonarr APIs only answer
  your LAN, and the public port doesn't publish its API description. Banned
  addresses are listed there, each with ***Lift ban***.
- ***Settings -> Advanced -> RSS feed***: how far back friends' new releases
  show up in your *arr's RSS sync.
- ***Downloads*** opens on ***Active***: what is running, waiting for import or
  failed, with speed and time left. ***Retry all failed*** retries every failed
  one.
- ***Friends' library*** has a search field, a sort that starts with
  ***Recently added***, and, with two or more friends, a filter per friend.

## Updating and backups

- Update from the Docker tab: ***Check for Updates***, then ***Update*** on
  jack and jack-ui. Downloads in progress pause during the restart and resume
  from where they were.
- ***Settings -> Advanced -> About*** shows which build jack and jack-ui run,
  and warns when they differ. Update both containers then.
- To get a newer template (new settings), run the two `wget` lines from step 2
  again. Your container's values stay as they are.
- Back up `/mnt/user/appdata/jack`. It holds your config, your friends' keys
  and the download history. The Appdata Backup plugin covers it.

## Troubleshooting

- **jack stops right after starting, with "EACCES" or "permission denied" in its
  log**: the appdata folder existed before and isn't owned by `nobody:users`. Fix
  it in the terminal with `chown -R nobody:users /mnt/user/appdata/jack` and
  start jack again. (Unraid creates missing folders with the right owner.)
- **jack-ui shows *jack-ui can't reach jack***: the screen names the address it
  tried (`http://jack:5226` by default) and what it found:
  - ***jack-ui can't find jack***: the jack container is stopped, isn't on the
    `jack` network, or isn't named `jack`.
  - ***jack isn't answering***: jack is still starting or has stopped (check
    its log; for EACCES see the entry above), or ***Management key*** in the
    jack template is empty. jack only lets jack-ui connect when that key is
    set.
  - ***jack didn't answer ... within 5 seconds***: check ***Management API***
    in the jack-ui template (under ***Show more settings***). The default,
    `http://jack:5226`, works when both containers are on the `jack` network.

  Click ***Retry*** once it's fixed.
- **jack-ui shows *jack rejected jack-ui's key***: ***Management key*** differs
  between the two templates. Copy the value from the jack template into the
  jack-ui template and click ***Apply***. If jack-ui asks for the key instead
  (its ***Management key*** is empty), paste the value from the jack template.
- **Radarr says it can't reach jack, or grabs never start**: ***Address
  Radarr/Sonarr use to reach jack*** (***Settings -> Radarr & Sonarr***) is
  wrong. It must be an address your Radarr container can reach, usually
  `http://<your-server-ip>:5225` (see the tip in step 5 for `br0`). Radarr's
  card under ***Settings -> Radarr & Sonarr*** shows Radarr's own test of jack
  in plain words, for example ***Radarr can't resolve jack. Use your server's
  IP in Address Radarr/Sonarr use to reach jack.*** Saving a new address
  updates Radarr and tests again; ***Register again*** on the card does the
  same without a change.
- **No Jack indexer or download client in Radarr/Sonarr**: Radarr's card reads
  `jack in Radarr: skipped (downloads off)`. Click ***Turn on downloads***
  under ***Settings -> Radarr & Sonarr -> Downloads*** and save; saving adds
  both to every Radarr/Sonarr right away. Then restart the jack container:
  until then the card reads `download client waits for a restart`, and Radarr
  can't use the download client.
- **Saving Downloads fails with "jack can't write to /data/jack"**: that folder
  doesn't exist in the jack container, or jack can't write to it. Check that
  the ***Downloads*** path in the jack template has the *Container Path*
  `/data/jack`. If its host folder existed before, fix the owner with
  `chown -R nobody:users` on that folder.
- **Downloads finish but Radarr doesn't import them**: the downloads folder
  doesn't match. jack's ***Completed folder***, its downloads *Container Path*
  and the path your Radarr sees must all be the same. ***Check folders*** under
  ***Settings -> Radarr & Sonarr -> Downloads*** names the path that differs.
- **Friends get "can't find this file on disk"**: your Movies/TV *Container
  Paths* differ from the ones in your Radarr/Sonarr. ***Check folders*** finds
  this too.
- **A friend's card shows a problem**: the badge on ***Friends*** has the
  result of the last check of their jack, and a line on the card says what to
  do. ***Check now*** at the top of the page checks again right away.
  - ***Offline since 14:02***: their jack or their proxy didn't answer, and
    the card says why, for example that the address doesn't resolve. Ask them
    to check that their address's `/ping` answers `{"status":"OK"}` from
    outside their network. Downloads from them wait and retry.
  - ***Rejected your key***: they revoked your key or sent you a new link.
    Click ***Paste new link*** and paste the link they send.
  - ***Is blocking you***: their jack banned your address after failed
    attempts. They can lift the ban under ***Settings -> Sharing ->
    Security***.
  - ***Needs a newer jack***: they need to update jack.
- **A card stays on "Waiting for Alice"**: their jack has never used the key
  you sent. If they never pasted your link, click ***Send a new link*** on the
  card and send them that one.
- **A card says "Only one way since 12 Oct"**: their jack last used your key
  on 12 Oct, more than 24 hours ago, and the card says ***Alice's jack hasn't
  connected to yours since 12 Oct.*** Click ***Check your address*** on the
  card to check that your public address still works, and ask them what their
  jack shows for you. If it says ***Is blocking you***, lift the ban under
  ***Settings -> Sharing -> Security***.
- **The address check fails**: ***Check*** under ***Address friends use***
  says what went wrong, such as a certificate or proxy error. If friends can
  reach you anyway, your router probably doesn't route your own domain back to
  your server (see step 6).
- **About warns that jack and jack-ui run different builds**: update both
  containers (Docker tab -> ***Check for Updates***).
- **Everything else**: ***Logs*** in jack-ui shows what jack is doing, and the
  jack container's log (Docker tab -> jack -> ***Logs***) shows the same. A
  line in ***Logs*** with a known fix has a help icon; click the line for a
  link to the fix.
- **Asking for help**: ***Copy support info***, in the ***Logs*** header or
  under ***Settings -> Advanced -> About***, copies jack's build, the state of
  your Radarr/Sonarr and friends, and the last warnings and errors from the
  log, without keys, header values or webhook URLs. Error messages in it can
  contain the addresses of your Radarr, Sonarr and friends.
