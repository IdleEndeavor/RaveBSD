# public/js/ : the page code

Plain ES modules loaded straight by the browser. The page modules (`search.js`, `shelf.js`, `settings.js`) each export `mount(el, opts)`, `unmount()` and `relayout()` (called when the window crosses the 900px phone line); `setup.js` exports `mount` only, and `verify.js` exports `openVerify`. Pages talk to each other through `bus` (an `EventTarget` in `app.js`), never by importing each other's internals.

## Files

| File | What it does | Look for |
| --- | --- | --- |
| `app.js` | The shell. Asks `/api/session`, then shows sign-in, setup or the app. Draws the nav and tab bar, routes between pages, keeps the `/events` connection, shows "on the shelf" toasts and browser notifications. | `app` (session, settings, status, jobs), `bus`, `ROUTES`, `go(path)`, `drawNav`, `refreshStatus`, `refreshSettings`, `isAdmin()`, `login({ asAdmin })` |
| `ui.js` | Shared helpers used by every page. | `$`, `$$`, `esc` (escapes scraped text), `api(path, { method, body })`, `icon(name)`, `size`, `when`, `ago`, `plural`, `toast`, `showMenu`, `copy`, `saveToDevice(id)`, `patchHtml(el, html)` (redraws only what changed, so focus and running animations survive), `prefs` (per-browser settings in localStorage), `priv` / `privPath` (blur private details), `paletteFor` / `coverPalette` / `genCover` (book colours), `sfx` (sounds), `anim` |
| `search.js` | Discover and Results, one module with a transition between them. The search bar becomes a loading bar that fills as each library answers, then rises into the results page. Results show as a shelf of spines (ebooks) or cassettes (audiobooks), or as a list. Download to server turns the button into a live progress pill. | `S` (page state), `LIBS` (loading bar labels per library), `startSearch`, `discoverFlow`, `renderResults`, `filtered`, `shelfView`, `cassetteHtml`, `linkPill`, `advPanel` (advanced search) |
| `shelf.js` | The Shelf page: downloads in progress, what is on the server, saving to this device, delete and forget, and the Stats tab (`/shelf/stats`). | `load`, `drawJobs`, `drawItems`, `jobCard`, `itemRow`, `renderStats` and the `*Card` stat cards |
| `settings.js` | Two pages from one module: `/settings` (this browser and your own account) and `/admin` (the admin panel: libraries, access and accounts, API keys, folders and naming, qBittorrent, VPN, storage, backups, system). Switches save as they change; forms have their own Save button. | `SECTIONS`, `section(id)` and one function per section, `patch(name, value)`, `onClick`, `attention()` (what the badge counts) |
| `setup.js` | First run: who it is for (mode and admin account), folders, qBittorrent, summary. Nothing is saved until "Let's go". | `stepHtml`, `onClick`, `partial()` |
| `verify.js` | The Verify view: the server's own browser shown as pictures so a person can pass a site's human check (Anna's Archive, Z-Library) from any device. Clicks and keys are sent back. RaveBSD never solves checks itself. | `openVerify(onDone, site)` |

`/js/rename.js` is served from `src/rename.js` (naming previews use the server's own code).

## Live events

`app.js` opens `/events` (server-sent events) once. Each message is re-dispatched on `bus` by its `type`:
`hello` and `jobs` (download list), `done`, `failed`, `shelf` (something changed), `vpn`, `status`, `lowSpace`. Pages listen with `bus.addEventListener(type, ...)` and remove their listeners in `unmount()`.

## Patterns

- Text from search results goes into HTML through `esc()`.
- The page never sends the server a URL to fetch. Downloads go by result id (`/api/downloads`), files and covers by shelf id (`/files/<id>`, `/cover?shelf=`).
- Admin-only controls check `isAdmin()`; the server enforces the same thing, so hiding a button is only for tidiness.
- Anything redrawn by a live event (jobs, status, banners, nav) goes through `patchHtml`, not `innerHTML`, so keyboard focus, hover and the progress stripes carry on.
- Phone and desktop share the same functions, which branch on `isPhone()` inside.
- `npm test` checks that every file here parses (`test/syntax.test.mjs`).
