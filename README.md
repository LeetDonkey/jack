# jack

<p align="center">
  <a href="https://github.com/roziscoding/jack/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/roziscoding/jack?display_name=tag&style=flat-square&label=latest%20release&color=2496ED"></a>
  <a href="https://jack.roz.ninja"><img src="https://img.shields.io/badge/full%20documentation-jack.roz.ninja-3e63dd?style=flat-square&logoColor=white" alt="Full documentation"></a>
  <a href="https://github.com/roziscoding/jack/pkgs/container/jack"><img src="https://img.shields.io/badge/-jack-2496ED?style=flat-square&logo=docker&logoColor=white" alt="jack image"></a>
  <a href="https://github.com/roziscoding/jack/pkgs/container/jack-ui"><img src="https://img.shields.io/badge/-jack--ui-2496ED?style=flat-square&logo=docker&logoColor=white" alt="jack-ui image"></a>
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
- **Friends page and notifications**: who is online, their version and traffic
  per friend; Discord, ntfy or webhook notifications for failures, offline
  friends and a daily summary.
- **Friends of friends**: find people your friends know and connect through
  them, end-to-end encrypted, without either side's address being shared
  before both accept.
- **A nicer peer catalog**: titles, posters and quality from your friends'
  Radarr/Sonarr, no TMDB key needed.
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
[getting started guide](https://jack.roz.ninja/guide/getting-started).

## Documentation

- [What is jack?](https://jack.roz.ninja/guide/what-is-jack) — concepts and roles
- [Getting started](https://jack.roz.ninja/guide/getting-started) — full setup walkthrough
- [How it works](https://jack.roz.ninja/guide/how-it-works) — search, download, and serving flows
- [Peering](https://jack.roz.ninja/guide/peering) — sharing with friends and API keys
- [Management UI](https://jack.roz.ninja/guide/management-ui) — the web console
- [Troubleshooting](https://jack.roz.ninja/guide/troubleshooting) — common failures and fixes
- [Configuration](https://jack.roz.ninja/reference/configuration) and
  [environment variables](https://jack.roz.ninja/reference/environment-variables) — full reference
- [Peer API](https://jack.roz.ninja/reference/peer-api) and
  [management API](https://jack.roz.ninja/reference/management-api) — API reference

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, project
layout, and how to run tests and lint. Found a vulnerability? Report it
privately as described in [SECURITY.md](SECURITY.md).

## Support

jack costs nothing to run and takes no donations — if it's been useful to you,
[FUNDING.md](FUNDING.md) tells you what I'd love instead.

## License

[GPL-3.0](LICENSE)
