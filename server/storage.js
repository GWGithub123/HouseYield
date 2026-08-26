import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILE = path.join(__dirname, 'subscriptions.json');

function readAll() {
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function writeAll(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function upsert(sub) {
  const list = readAll();
  const i = list.findIndex((x) => x.endpoint === sub.endpoint);
  if (i >= 0) list[i] = sub; else list.push(sub);
  writeAll(list);
  return sub;
}

function remove(sub) {
  const list = readAll();
  const next = list.filter((x) => x.endpoint !== sub.endpoint);
  writeAll(next);
  return list.length !== next.length;
}

export { readAll, writeAll, upsert, remove };
