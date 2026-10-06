// The artifact host wraps pages in its own <html>/<head>/<body> skeleton.
// Writes dist/twin-relay.html: the single-file build with those outer tags removed.
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const out = html
  .replace(/<!doctype html>/i, '')
  .replace(/<\/?html[^>]*>/gi, '')
  .replace(/<\/?head>/gi, '')
  .replace(/<\/?body>/gi, '')
  .replace(/<meta charset="UTF-8"\s*\/?>/i, '')
  .replace(/<meta name="viewport"[^>]*>/i, '')
  .trim();
writeFileSync('dist/twin-relay.html', `${out}\n`);
console.log(`dist/twin-relay.html  ${(out.length / 1024).toFixed(1)} KiB`);
