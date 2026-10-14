// Every page script parses: the server only serves them, so a typo would otherwise first show up in a browser.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
for (const dir of ['public/js', 'src']) for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) execFileSync(process.execPath, ['--check', `${dir}/${f}`]);
console.log('syntax: ok');
