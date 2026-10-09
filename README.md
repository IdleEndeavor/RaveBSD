# RaveBSD

Self-hostable feature-rich instance of [RaveBookSearch](https://ravebooksearch.com).

Search many free book and audiobook sources at once, from your own machine. RaveBSD merges the results into one ranked list and finds direct download links for you.

> RaveBookSearch will be sunset soon, RaveBSD will be the only way to access its features moving forward. It was a good run, but the website has gotten to popular for its own good. I didn't want to completely shut it down though, so this was the next best way to keep it alive and improve on the features in ways that were previously restricted.

## Sources

**eBooks**

| Source | Notes |
| --- | --- |
| LibGen | |
| Anna's Archive | May ask for a one-time human check, which you complete yourself from the Backend page |
| Z-Library | Works without an account. Adding your login makes it faster |
| Internet Archive | Lending-library items are left out |
| Project Gutenberg | |
| OpenStax | |
| LibreTexts | |
| Memory of the World | |
| RoyalLib | |
| Mobilism | Needs a free account |

**Audiobooks**

| Source | Notes |
| --- | --- |
| AudiobookBay | Listed first. Magnet links, with an optional .torrent download |
| LibriVox | |
| AudiobooksBee | |
| Internet Archive | |
| LibGen | |
| Mobilism | Needs a free account |

The search page also has link cards for many more sites that can only be opened in your browser.

## Install

You need [Docker](https://docs.docker.com/get-docker/) with Compose.

```
git clone https://github.com/IdleEndeavor/RaveBSD.git
cd RaveBSD
mkdir data
cp .env.example .env
docker compose up -d
```

Open <http://localhost:8080>. Everything is included, including the background browser that some sources need, so there is nothing else to set up.

Settings and logins are on the **Backend** page (link in the page footer). Optional settings can also go in `.env`.

If `id -u` or `id -g` is not 1000, set `PUID` and `PGID` in `.env` before starting, otherwise RaveBSD cannot save into `data/`.

**Port 8080 already taken?** Set `PORT` in `.env` to any free port (for example `PORT=8686`) and run `docker compose up -d` again. Without Docker, start it with `PORT=8686 npm start`.

**Without Docker:** install Node 24, then run `npm install` and `npm start`. The background browser is downloaded automatically.

## Update

```
./update.sh
```

It pulls the newest version and restarts RaveBSD. Your `data/` folder is untouched. The running version is shown at the bottom of the Backend page.

To update automatically, run it from cron, for example every night at 4:

```
0 4 * * * cd /path/to/RaveBSD && ./update.sh
```

## Access it from outside your home

RaveBSD has no login of its own, so do not open its port to the internet directly. To reach your instance from other places, use [Tailscale](https://tailscale.com) (private to your own devices) or a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with Cloudflare Access in front (your own domain, with a login). Point either one at the port RaveBSD runs on.

## Your data

Everything RaveBSD saves is in the `data/` folder next to `compose.yaml`:

| File | What it holds |
| --- | --- |
| `settings.json` | Your settings and source logins |
| `stats.json` | Search and download counts |
| `browser-profile/` | The background browser's saved state, including a passed Anna's Archive check |

- Nothing is sent anywhere except to the sources you search.
- Searches themselves are never saved, and they are not written to the logs. Recent results stay in memory for 10 minutes to speed up repeat searches and are gone after a restart.
- Search and download statistics can be switched off on the Backend page ("Record local stats"). Switching them off also deletes what was recorded.

## Backup and restore

Back up the whole deployment by copying the project folder, or just the parts that matter:

```
tar czf ravebsd-backup.tgz compose.yaml .env data
```

To restore, unpack the archive on any machine with Docker and run `docker compose up -d` again.

## Future plans

- Automated configurable downloader to specified folder or shared docker volumes
- Integration as a source for locally hosted instances of 4get search and SearXNG
- Integration as a plugin for Calibre
- VERY AMBITIOUS: A way to mesh together all privately run instances of RaveBDS together so that RaveBookSearch.com can serve as a singular directory to discover instances that users have chosen to open to the public.