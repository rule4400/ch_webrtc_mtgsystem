'use strict';

const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/check-inline-scripts.cjs <html> [...]');
  process.exit(2);
}

let checked = 0;
for (const input of files) {
  const filePath = path.resolve(input);
  const html = fs.readFileSync(filePath, 'utf8');
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
  let inlineIndex = 0;
  for (const match of scripts) {
    const attributes = match[1] || '';
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (/\btype\s*=\s*["']module["']/i.test(attributes)) continue;
    inlineIndex += 1;
    try {
      // Parse only. The script is never executed.
      // eslint-disable-next-line no-new-func
      new Function(match[2]);
    } catch (error) {
      console.error(`${input}: inline script ${inlineIndex}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (!inlineIndex) {
    console.error(`${input}: no classic inline script found`);
    process.exitCode = 1;
  }
  checked += inlineIndex;
}

if (!process.exitCode) console.log(`inline script syntax ok (${checked} scripts)`);
