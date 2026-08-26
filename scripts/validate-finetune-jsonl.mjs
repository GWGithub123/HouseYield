import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const file = process.argv[2] || path.resolve(process.cwd(), 'real-estate-finetuning-examples.plus70.jsonl');

const rl = readline.createInterface({
  input: fs.createReadStream(file, { encoding: 'utf8' }),
  crlfDelay: Infinity
});

let idx = 0;
let ok = 0;
let bad = 0;
let schemaErr = 0;
const issues = [];

function wc(s){
  return (s||'').trim().split(/\s+/).filter(Boolean).length;
}

rl.on('line', (line) => {
  idx++;
  if (!line.trim()) return;
  try {
    const obj = JSON.parse(line);
    if (!obj || !obj.messages || !Array.isArray(obj.messages) || obj.messages.length !== 3) {
      schemaErr++;
      issues.push({ line: idx, error: 'Invalid messages array' });
      return;
    }
    const [sys, user, assistant] = obj.messages;
    if (sys.role !== 'system' || user.role !== 'user' || assistant.role !== 'assistant') {
      schemaErr++;
      issues.push({ line: idx, error: 'Roles incorrect' });
      return;
    }
    const words = wc(assistant.content);
    if (words < 1350 || words > 1550) {
      bad++;
      issues.push({ line: idx, error: `Assistant word count ${words}` });
    } else {
      ok++;
    }
  } catch (e) {
    bad++;
    issues.push({ line: idx, error: 'JSON parse error' });
  }
});

rl.on('close', () => {
  console.log(JSON.stringify({ file, total: idx, ok, bad, schemaErr, sampleIssues: issues.slice(0, 5) }, null, 2));
});
