# scripts/ : install helpers

| File | What it does |
| --- | --- |
| `setup-browser.mjs` | Runs after `npm install` (the `postinstall` script in `package.json`). Calls `ensureBrowser()` from `src/browser.js`, which downloads Playwright's Chromium if it is missing, so a plain `npm install && npm start` gets the background browser without extra steps. It never fails the install, and the server tries again on first start. |

The Docker image installs Chromium in its own build step (`Dockerfile`) and runs `npm ci --ignore-scripts`, so this script does nothing there.

Scripts in this folder run on people's machines during install, so they are small, dependency-free and safe to run twice.
