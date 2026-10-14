# test/ : checks

Plain Node scripts using `node:assert`. No test framework, no network (the access test starts throwaway local servers on spare ports with their own data folders). `npm test` runs them all in order and stops at the first failure; the GitHub workflow runs `npm test` before every image build.

| File | What it checks |
| --- | --- |
| `syntax.test.mjs` | Every file in `public/js/` and `src/` parses (`node --check`). The server serves page scripts as they are, so this catches typos before a browser does. |
| `sources.test.mjs` | Pure helpers in `src/sources.js`: size parsing (including RoyalLib's Cyrillic units), relevance and ranking with author words, mirror ordering and hedged mirror fetches, timeouts and caching, User-Agent mode, advanced search options. |
| `rename.test.mjs` | Naming templates in `src/rename.js`: tokens, empty tokens dropping their brackets, author name order, junk tags, unsafe characters and path climbing. |
| `slum.test.mjs` | Reading SLUM's status page and ordering mirrors by it (`src/slum.js`). |
| `netguard.test.mjs` | Private, loopback, link-local, carrier-grade NAT and IPv6 forms are refused; public addresses pass (`src/netguard.js`). |
| `zip.test.mjs` | A folder zipped by `zipFolder` unpacks with `extractZip`, and an entry naming a path outside the folder is skipped (`src/zip.js`). |
| `access.test.mjs` | The three access modes end to end: who may reach which route, sign-in, visitors' own shelves, shared copies, quotas and expiry. |

## How the tests are written

- One file per module, named `<module>.test.mjs`, each listed in the `test` script in `package.json`.
- Pure functions are tested directly. Scraper tests hold a small sample of the site's HTML and check what the parser returns, so no test calls a live site.
- Tests that touch settings or the shelf set `DATA_DIR` to a fresh temporary folder before importing `src/` modules, as `access.test.mjs` does.
