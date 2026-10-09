// Runs after `npm install`: downloads the background browser (Chromium) so every feature works.
// Never fails the install; the server also retries this on first start.
import { ensureBrowser } from '../src/browser.js';
ensureBrowser().catch(() => {}).finally(() => process.exit(0));
