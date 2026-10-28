import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, direct, piRoot, typescript, runNode } from './tooling.mjs';

function worker() {
  const ts = typescript();
  const configPath = path.join(root, 'extensions/model-pick.tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const sdk = piRoot(), modules = path.join(sdk, 'node_modules');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), {
    baseUrl: modules,
    paths: {
      '@earendil-works/pi-ai': [path.join(modules, '@earendil-works/pi-ai/dist/index.d.ts')],
      '@earendil-works/pi-ai/*': [path.join(modules, '@earendil-works/pi-ai/dist/*')],
      '@earendil-works/pi-tui': [path.join(modules, '@earendil-works/pi-tui/dist/index.d.ts')],
      '@earendil-works/pi-coding-agent': [path.join(sdk, 'dist/index.d.ts')],
    },
    typeRoots: [path.join(modules, '@types')], types: ['node'], noEmit: true,
  }, configPath);
  // Include every runtime source, not only files reachable from the entry.
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (file.endsWith('.ts') && !parsed.fileNames.includes(file)) parsed.fileNames.push(file);
    }
  }
  walk(path.join(root, 'extensions')); walk(path.join(root, 'lib'));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: f => f, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
  console.log(JSON.stringify({ compiler: ts.version, files: parsed.fileNames.length, diagnostics: diagnostics.length }));
  assert.equal(diagnostics.length, 0, 'Typecheck failed');
}
export function typecheck() { return runNode('typecheck', [path.join(root, 'scripts/typecheck.mjs'), '--worker']); }
if (direct(import.meta.url)) { if (process.argv.includes('--worker')) worker(); else typecheck(); }
