import fs from 'node:fs';
import { typescriptPath } from '../scripts/tooling.mjs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require(typescriptPath());

/** Only source files are read here; runtime fs/os/network must be supplied explicitly. */
export function loadTypeScript(filename, modules = {}, globals = {}) {
  const cache = new Map();
  const context = vm.createContext({
    Buffer, URL, TextDecoder, TextEncoder, AbortController, AbortSignal,
    setTimeout, clearTimeout, Response, Headers, Request, performance,
    process: { pid: 1, getuid: () => process.getuid?.() ?? 1000 },
    fetch() { throw new Error('network forbidden in picker tests'); },
    ...globals,
  });
  function load(file) {
    file = file.endsWith('.js') ? file.slice(0, -3) + '.ts' : file;
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(file, 'utf8');
    const code = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    cache.set(file, module);
    const wrapper = vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename: file });
    wrapper((id) => {
      if (Object.hasOwn(modules, id)) return modules[id];
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id));
      if (['node:path', 'node:crypto', 'node:util'].includes(id)) return require(id);
      throw new Error(`unexpected runtime import: ${id}`);
    }, module, module.exports);
    return module.exports;
  }
  const exported = load(filename);
  const parse = vm.runInContext('(json) => JSON.parse(json)', context);
  Object.defineProperty(exported, '__json', { value: (value) => parse(JSON.stringify(value)) });
  return exported;
}
