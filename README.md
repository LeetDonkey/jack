# jack

<p align="center">
  <a href="https://hub.docker.com/r/leetdonkey/jack"><img src="https://img.shields.io/badge/-jack-2496ED?style=flat-square&logo=docker&logoColor=white" alt="jack image"></a>
  <a href="https://hub.docker.com/r/leetdonkey/jack-ui"><img src="https://img.shields.io/badge/-jack--ui-2496ED?style=flat-square&logo=docker&logoColor=white" alt="jack-ui image"></a>
</p>

**jack** lets you and your friends share media libraries with each other through
the *arr stack you already run. You point Radarr/Sonarr at jack, search like you
would on any indexer, and when a friend has the movie or episode you want, jack
pulls it straight from their server into your library — no public trackers, no
BitTorrent swarm, just a private peer-to-peer bridge between your media servers.

Built with [Bun](https://bun.com) and [Hono](https://hono.dev).

## This fork

This is a fork of [roziscoding/jack](https://github.com/roziscoding/jack), run by
a small group of friends. Images: [`leetdonkey/jack`](https://hub.docker.com/r/leetdonkey/jack)
and [`leetdonkey/jack-ui`](https://hub.docker.com/r/leetdonkey/jack-ui) on Docker
Hub, tagged `latest` and with the commit.

- **Install on Unraid**: [Installing on Unraid](website/guide/unraid.md), with
  templates in [`unraid/`](unraid/).
- **Install with Docker Compose**: [`examples/docker-compose.yml`](examples/docker-compose.yml)
  uses the fork's images.
- **Settings the fork adds** are in the [configuration reference](website/reference/configuration.md).

What it adds on top of upstream:

- **Downloads that survive outages**: a retry window (default 24 hours) for
  network errors, bounded Range requests so a slow disk can't fill RAM, and a
  retry for files a friend's jack briefly can't find.
- **Verified downloads**: friends' jacks publish SHA-256 hashes per 16 MiB
  piece; jack checks every download, repairs bad pieces, and continues from
  another friend with the same file when one goes offline.
- **Kinder to friends' servers**: the RSS feed lists only recently added
  releases, an upgrade policy per Radarr/Sonarr, cached catalogs, upload limits
  per friend, and bandwidth schedules.
- **Guided setup**: a setup checklist on the Dashboard, a bar naming settings
  that wait for a restart, Radarr/Sonarr's own test of jack on each server's
  card, and a folder check for paths Radarr/Sonarr see differently.
- **One card per friend**: invite links, both directions on one card with a
  status that says what is wrong, and a Remove friend that also revokes their
  access.
- **Notifications**: Discord, ntfy or webhook messages for failures, offline
  friends and a daily summary.
- **Friends of friends**: find people your friends know and connect through
  them, end-to-end encrypted, without either side's address being shared
  before both accept.
- **Friends' library**: titles, posters and quality from your friends'
  Radarr/Sonarr, no TMDB key needed, with search, sort and a filter per friend.
- **Day-to-day controls**: pause sharing or downloads, download statuses with
  speed and retry times, a check of the address friends use, which build jack
  and jack-ui run, and Copy support info for asking for help.
- **fail2ban for the public port**: temporary bans for addresses that keep
  failing authentication.

The upstream documentation at [jack.roz.ninja](https://jack.roz.ninja)
describes upstream jack.

## Quick start (Docker Compose)

Two images are published on Docker Hub: the backend (`leetdonkey/jack`) and the
management UI (`leetdonkey/jack-ui`), so you don't need to clone the repo. Grab
[`examples/docker-compose.yml`](examples/docker-compose.yml) and
[`examples/config.jsonc`](examples/config.jsonc), drop them in a folder, then:

```bash
# 1. Create your config from the template
mkdir -p config
cp config.jsonc config/config.jsonc   # the template you downloaded
$EDITOR config/config.jsonc           # fill in your servers and peers

# 2. Set a management key (gates the management API + the UI's access to it)
echo "JACK_MANAGEMENT_KEY=$(openssl rand -base64 32)" > .env

# 3. Pull and run
docker compose up -d
```

The management UI comes up at **http://localhost:3000**. For volume mounts,
networking, and the path gotchas that make grabs import correctly, follow the
[getting started guide](website/guide/getting-started.md).

## Documentation

- [Installing on Unraid](website/guide/unraid.md): templates and setup
- [Getting started](website/guide/getting-started.md): Docker Compose setup
- [What is jack?](website/guide/what-is-jack.md): concepts and roles
- [How it works](website/guide/how-it-works.md): search, download and serving
- [Peering](website/guide/peering.md): sharing with friends and API keys
- [Management UI](website/guide/management-ui.md): the web interface
- [Troubleshooting](website/guide/troubleshooting.md): common failures and fixes
- [Configuration](website/reference/configuration.md) and
  [environment variables](website/reference/environment-variables.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, project
layout, and how to run tests and lint. Found a vulnerability? Report it
privately as described in [SECURITY.md](SECURITY.md).

## Support

jack costs nothing to run and takes no donations — if it's been useful to you,
[FUNDING.md](FUNDING.md) tells you what I'd love instead.

## License

[GPL-3.0](LICENSE)
