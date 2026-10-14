# public/css/ : styles

Three stylesheets, loaded in this order by `index.html`. No preprocessor; plain CSS with custom properties.

| File | What it holds |
| --- | --- |
| `fonts.css` | `@font-face` rules for Bricolage Grotesque (UI), Instrument Serif (the italic accents in headings) and DM Mono (sizes, paths, chips). The files are in `../fonts/`. |
| `app.css` | Design tokens on `:root` (colours, glows, easing), then the shared components: top nav, phone tab bar, type (`.h-hero`, `.h-sec`, `.label`, `.lede`, `.serif`), buttons (`.btn` with `.yellow`, `.dark`, `.outline`, `.pink`, `.cyan`, `.danger`, sizes `.xs` `.sm` `.lg`), segmented controls (`.seg`), switches, inputs (`.input`), cards and setting rows (`.card`, `.row`), pills and chips, menus, toast, banners, progress stripes, logo lockups, phone overrides, and private-detail blur (`.priv`). |
| `pages.css` | One block per page: Discover, Results (shelf of spines, cassettes, the pulled-out book, result card, list view, phone results), Shelf and Stats, Settings and the admin panel, Verify view, Setup and sign-in. |

## Conventions

- Colours come from the tokens (`var(--yellow)`, `var(--ink)`, `var(--paper)`, `var(--card)`, ...). Pastel accents for cards and spines are listed in `public/js/ui.js` (`PALETTES`, `SPINES`).
- Phone layout is `@media (max-width: 899px)`. Tap targets there are at least 44px high.
- `html[data-still]` (Settings > This browser > Animations off) stops animations and transitions.
- `html[data-show-private]` reveals `.priv` blurred details; public instances never set it.
- Focus is a visible 3px ring (paper on dark surfaces, ink on paper surfaces).
- Each block starts with a `/* ── Name ── */` comment, so searching for a page or component name finds it.
