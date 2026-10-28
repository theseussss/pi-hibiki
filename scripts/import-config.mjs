import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Explicit, non-destructive flag conversion only; never infer a real profile path. */
export function importLegacyFast(from, to) {
  if (!from || !to) throw new Error('Both --from and --to are required');
  from = path.resolve(from); to = path.resolve(to);
  const parent = path.dirname(to);
  for (let dir = parent;; dir = path.dirname(dir)) {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe output directory');
    if (dir === path.dirname(dir)) break;
  }
  const source = fs.lstatSync(from);
  if (!source.isFile() || source.isSymbolicLink() || source.nlink !== 1 || source.size > 65536) throw new Error('Unsafe legacy config');
  const fd = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let data;
  try {
    const current = fs.fstatSync(fd);
    if (current.dev !== source.dev || current.ino !== source.ino || current.nlink !== 1 || current.size > 65536) throw new Error('Legacy config changed');
    try { data = JSON.parse(fs.readFileSync(fd, 'utf8')); }
    catch { throw new Error('Legacy config is not valid JSON'); }
  } finally { fs.closeSync(fd); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => key !== 'enableUltrafast') || (data.enableUltrafast !== undefined && typeof data.enableUltrafast !== 'boolean')) throw new Error('Expected only the legacy enableUltrafast boolean');
  const config = { fast: { enableUltrafast: data.enableUltrafast === true } };
  const temp = path.join(parent, `.hibiki-import-${randomUUID()}.tmp`);
  let temporary = false;
  try {
    const output = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    temporary = true;
    try { fs.fchmodSync(output, 0o600); fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n'); fs.fsyncSync(output); }
    finally { fs.closeSync(output); }
    // Atomic no-clobber publication. Existing files/links are never overwritten.
    fs.linkSync(temp, to);
    fs.unlinkSync(temp); temporary = false;
    const directory = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { if (temporary) fs.unlinkSync(temp); }
  return { path: to, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2); const flags = new Map();
    if (args.length !== 4) throw new Error('Usage: node scripts/import-config.mjs --from <legacy-json> --to <new-json>');
    for (let i = 0; i < args.length; i += 2) {
      if (!['--from', '--to'].includes(args[i]) || flags.has(args[i]) || args[i + 1].startsWith('--')) throw new Error('Invalid explicit import arguments');
      flags.set(args[i], args[i + 1]);
    }
    console.log(JSON.stringify(importLegacyFast(flags.get('--from'), flags.get('--to'))));
  } catch (error) { console.error(`Hibiki config import not confirmed: ${error.message}`); process.exitCode = 1; }
}
