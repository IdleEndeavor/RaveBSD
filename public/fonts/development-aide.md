# public/fonts/ : self-hosted fonts

The page never calls Google or any other font service; these files are served by the RaveBSD server itself.

| Family | Files | Used for |
| --- | --- | --- |
| Bricolage Grotesque (variable, 400 to 800) | `bricolage-grotesque-normal-400-800-*.woff2` | All interface text and headings |
| Instrument Serif (regular and italic) | `instrument-serif-*.woff2` | The serif accent words in headings (`.serif`) |
| DM Mono (400, 500) | `dm-mono-*.woff2` | Sizes, file paths, chips, labels |

Each family comes as a `latin` and a `latin-ext` subset; `public/css/fonts.css` picks them with `unicode-range`, so most pages only download the `latin` files. The main Bricolage file is preloaded in `index.html`.

All three are under the SIL Open Font License 1.1, in `OFL.txt` next to the fonts with each project's copyright line. Every font has its `@font-face` rule in `fonts.css`.
