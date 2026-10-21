#!/usr/bin/env node
// The words of a recording inside time windows, each with its start and end, to place a keep edge or check a retake.
//
//   node words.mjs <work folder> 12-20 [95.5-101]
import path from 'node:path';
import { readWords, die } from './lib.mjs';

const [work, ...wins] = process.argv.slice(2);
if (!work || !wins.length) die('Usage: node words.mjs <work folder> <from>-<to> [<from>-<to> ...]   (seconds of the raw recording)');
const W = readWords(path.join(path.resolve(work), 'words.json'));
if (!W.length) die('No words.json in ' + work + '. Run transcribe.mjs first.');
for (const win of wins) {
  const [a, b] = win.split('-').map(Number);
  if (!(b > a)) die(`"${win}" is not a window like 12-20`);
  console.log(`\n  ${a}-${b} s`);
  let last = null;
  W.filter(w => w.end > a && w.start < b).forEach(w => {
    const gap = last != null && w.start - last > 0.3 ? `   (${(w.start - last).toFixed(2)} s pause)` : '';
    console.log(`  ${w.start.toFixed(2).padStart(8)} ${w.end.toFixed(2).padStart(8)}  ${w.text}${gap}`);
    last = w.end;
  });
}
console.log('');
