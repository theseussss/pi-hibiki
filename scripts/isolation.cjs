'use strict';
// Defense in depth for synthetic Node children, NOT an OS/container sandbox.
// Native DPAPI's reviewed static helper remains explicitly permitted by tests.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const roots = [process.env.HIBIKI_PACKAGE_ROOT, process.env.HIBIKI_PI_ROOT,
  process.env.HIBIKI_TYPESCRIPT_ROOT, path.resolve(path.dirname(process.execPath), '..')].filter(Boolean).map(p => path.resolve(p));
const native = '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
const inside = (p, r) => p === r || p.startsWith(r + path.sep);
function allowed(file, metadata = false, write = false) {
  if (typeof file === 'number') return; // Fixture adapters own descriptors.
  if (file instanceof URL) file = fileURLToPath(file);
  if (Buffer.isBuffer(file)) file = file.toString();
  if (typeof file !== 'string') return;
  const p = path.resolve(file);
  if (p === '/dev/null' || (metadata && p === native)) return;
  if (/^\/tmp\/model-pick-[^/]+(?:\/|$)/.test(p)) return;
  if (process.env.HIBIKI_PACKAGE_ROOT && inside(p, path.join(process.env.HIBIKI_PACKAGE_ROOT, '.cache'))) return;
  if (!write && roots.some(r => inside(p, r) || (metadata && inside(r, p)))) return;
  if (metadata && (p === '/tmp' || p === path.parse(p).root)) return; // Root-directory metadata only, never content access.
  throw new Error(`Synthetic verification filesystem boundary: ${p}`);
}
for (const method of ['readFileSync', 'readFile', 'createReadStream', 'readdirSync', 'readdir', 'readlinkSync', 'readlink', 'realpathSync', 'realpath', 'statSync', 'stat', 'lstatSync', 'lstat', 'existsSync', 'accessSync', 'access']) {
  const original = fs[method];
  const metadata = /stat|exists|access|realpath/.test(method);
  fs[method] = function(file, ...args) { allowed(file, metadata); return original.call(this, file, ...args); };
}
for (const method of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'rmSync', 'rm', 'rmdirSync', 'rmdir', 'unlinkSync', 'unlink', 'chmodSync', 'chmod', 'createWriteStream', 'mkdtempSync', 'mkdtemp']) {
  const original = fs[method];
  fs[method] = function(file, ...args) { allowed(file, false, true); return original.call(this, file, ...args); };
}
for (const method of ['renameSync', 'rename', 'copyFileSync', 'copyFile', 'linkSync', 'link', 'symlinkSync', 'symlink']) {
  const original = fs[method];
  fs[method] = function(from, to, ...args) { allowed(from, false, true); allowed(to, false, true); return original.call(this, from, to, ...args); };
}
for (const method of ['openSync', 'open']) {
  const original = fs[method];
  fs[method] = function(file, flags, ...args) { allowed(file, false, typeof flags === 'string' ? /[wa+]/.test(flags) : flags !== 0); return original.call(this, file, flags, ...args); };
}
// Promise fs methods do not delegate to the patched callback facade.
for (const method of ['readFile', 'readdir', 'readlink', 'realpath', 'stat', 'lstat', 'access', 'open', 'writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'chmod', 'mkdtemp', 'rename', 'copyFile', 'link', 'symlink']) {
  const original = fs.promises[method];
  fs.promises[method] = function(file, ...args) {
    const write = ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'chmod', 'mkdtemp', 'rename', 'copyFile', 'link', 'symlink'].includes(method) || (method === 'open' && args[0] !== 'r' && args[0] !== 0);
    allowed(file, /stat|access|realpath/.test(method), write);
    if (['rename', 'copyFile', 'link', 'symlink'].includes(method)) allowed(args[0], false, true);
    return original.call(this, file, ...args);
  };
}
const denyNetwork = () => { throw new Error('Network forbidden in synthetic Hibiki verification'); };
for (const mod of [require('node:http'), require('node:https')]) for (const method of ['request', 'get']) mod[method] = denyNetwork;
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:dgram').createSocket = denyNetwork;
require('node:dns').lookup = denyNetwork;
globalThis.fetch = denyNetwork;
syncBuiltinESMExports();
