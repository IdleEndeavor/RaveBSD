# public/ : the page

The whole interface: one HTML page, plain ES modules and CSS, no framework and no build step. `src/server.js` serves this folder as it is (in memory, with ETags and gzip), so editing a file and reloading the browser is the whole workflow.

## Files and folders

| Path | What it is |
| --- | --- |
| `index.html` | The only HTML page: `#bg` (page glow), `#topnav` (desktop nav), `#app` (the current page), `#tabbar` (phone tab bar). Loads `js/app.js`. |
| `sw.js` | A service worker that caches nothing. It only exists so notifications work on Android. |
| `robots.txt` | Disallows everything, since instances are personal. |
| `js/` | The page code. Described in `js/development-aide.md`. |
| `css/` | Tokens, components and page layouts. Described in `css/development-aide.md`. |
| `fonts/` | Self-hosted fonts, so pages never call Google. Described in `fonts/development-aide.md`. |
| `img/` | Logo, favicon and lockups. Described in `img/development-aide.md`. |

`/js/rename.js` is not in this folder: the server answers it with `src/rename.js`, so the server and the page name files with the same code.

## Routing

Every path without a file extension (`/`, `/results`, `/shelf`, `/shelf/stats`, `/settings`, `/admin`) gets `index.html`. `js/app.js` reads the address and loads the page module from its `ROUTES` table.

## Conventions

- Colours and other values come from the design tokens in `css/app.css` (`--yellow`, `--ink`, `--paper`, and so on).
- Phone layout is below 900px (`isPhone()` in `js/ui.js`, `@media (max-width: 899px)` in CSS).
- Anything that shows folders, account names or addresses goes through `priv()` / `privPath()` in `js/ui.js`, so it is blurred until clicked (and always blurred on public instances).
- Settings > This browser > Animations off sets `html[data-still]`.
