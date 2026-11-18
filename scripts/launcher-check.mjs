#!/usr/bin/env node
// Used by Neo-Commander.cmd / neo-commander.sh.
//   node scripts/launcher-check.mjs node      -> exit 0 if Node >= 22.12
//   node scripts/launcher-check.mjs status    -> prints install | build | ok
//   node scripts/launcher-check.mjs stamp     -> records package-lock hash after a successful install
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stampFile = join(root, 'node_modules', '.neo-lock-hash');
const lockHash = () => {
  const p = join(root, 'package-lock.json');
  return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'nolock';
};

function newestMtime(dir) {
  let newest = 0;
  if (!existsSync(dir)) return 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

const cmd = process.argv[2];
if (cmd === 'node') {
  const [maj, min] = process.versions.node.split('.').map(Number);
  process.exit(maj > 22 || (maj === 22 && min >= 12) ? 0 : 1);
} else if (cmd === 'stamp') {
  writeFileSync(stampFile, lockHash());
} else if (cmd === 'status') {
  const needInstall = !existsSync(join(root, 'node_modules', '@modelcontextprotocol')) ||
    !existsSync(stampFile) || readFileSync(stampFile, 'utf8').trim() !== lockHash();
  const dist = join(root, 'dist', 'index.js');
  const srcNewest = Math.max(newestMtime(join(root, 'src')), statSync(join(root, 'package.json')).mtimeMs);
  const needBuild = !existsSync(dist) || statSync(dist).mtimeMs < srcNewest;
  console.log(needInstall ? 'install' : needBuild ? 'build' : 'ok');
} else {
  console.error('usage: launcher-check.mjs node|status|stamp');
  process.exit(2);
}
