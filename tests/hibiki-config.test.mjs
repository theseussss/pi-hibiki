import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadTypeScript } from './model-pick-loader.mjs';
import { importLegacyFast } from '../scripts/import-config.mjs';
const source = fileURLToPath(new URL('../lib/config.ts', import.meta.url));
const importer = fileURLToPath(new URL('../scripts/import-config.mjs', import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-hibiki-config-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const api = loadTypeScript(source, { 'node:fs': fs, 'node:os': { homedir: () => home } });
  const from = path.join(home, 'gpt-fast-mode.json'), to = path.join(home, 'pi-hibiki.json');
  return { home, api, from, to };
}
const enabled = (api, file) => api.readHibikiConfig(file).fast.enableUltrafast;

test('config has an own path, missing reads never create files or load the donor flag', (t) => {
  const f = fixture(t); assert.equal(f.api.getHibikiConfigPath(), path.join(f.home, '.pi/agent/pi-hibiki.json'));
  assert.equal(f.api.getHibikiConfigPath(f.home), f.to);
  fs.writeFileSync(f.from, '{"enableUltrafast":true}');
  assert.equal(enabled(f.api, f.to), false); assert.equal(fs.existsSync(f.to), false);
  assert.deepEqual(fs.readdirSync(f.home), ['gpt-fast-mode.json']);
});
for (const value of [{fast:{enableUltrafast:true}}, {fast:{enableUltrafast:false}}, {}, {fast:{enableUltrafast:'true'}}, {fast:{enableUltrafast:1}}, {fast:[]}, [], null, true, {enableUltrafast:true}]) {
  test(`strict opt-in config ${JSON.stringify(value)}`, (t) => {
    const f=fixture(t); const raw=JSON.stringify(value); fs.writeFileSync(f.to,raw);
    assert.equal(enabled(f.api,f.to), value?.fast?.enableUltrafast===true); assert.equal(fs.readFileSync(f.to,'utf8'),raw);
  });
}
test('damaged, oversized, symlinked and hardlinked config stays disabled without repair writes', (t) => {
  const f=fixture(t); fs.writeFileSync(f.to,'{broken'); assert.equal(enabled(f.api,f.to),false); assert.equal(fs.readFileSync(f.to,'utf8'),'{broken');
  fs.writeFileSync(f.to,JSON.stringify({fast:{enableUltrafast:true},padding:'x'.repeat(65536)})); assert.equal(enabled(f.api,f.to),false);
  fs.unlinkSync(f.to); fs.writeFileSync(f.from,'{"fast":{"enableUltrafast":true}}'); fs.symlinkSync(f.from,f.to); assert.equal(enabled(f.api,f.to),false);
  fs.unlinkSync(f.to); fs.linkSync(f.from,f.to); assert.equal(enabled(f.api,f.to),false);
});
for (const flag of [true,false,undefined]) {
  test(`explicit legacy import flag=${flag} creates only the own boolean config with 0600`, (t) => {
    const f=fixture(t); const before=JSON.stringify(flag===undefined?{}:{enableUltrafast:flag}); fs.writeFileSync(f.from,before);
    const result=importLegacyFast(f.from,f.to); assert.equal(result.path,f.to); assert.equal(enabled(f.api,f.to),flag===true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.to)),{fast:{enableUltrafast:flag===true}}); assert.equal(fs.statSync(f.to).mode&0o777,0o600);
    assert.equal(fs.statSync(f.to).nlink,1); assert.equal(fs.readFileSync(f.from,'utf8'),before);
    assert.deepEqual(fs.readdirSync(f.home).sort(),['gpt-fast-mode.json','pi-hibiki.json']);
  });
}
test('import rejects existing files, symlinks and identical input/output without clobbering', (t) => {
  const f=fixture(t); fs.writeFileSync(f.from,'{"enableUltrafast":true}'); fs.writeFileSync(f.to,'existing preferences');
  assert.throws(()=>importLegacyFast(f.from,f.to),{code:'EEXIST'}); assert.equal(fs.readFileSync(f.to,'utf8'),'existing preferences');
  fs.unlinkSync(f.to); fs.symlinkSync(f.from,f.to); assert.throws(()=>importLegacyFast(f.from,f.to),{code:'EEXIST'});
  assert.throws(()=>importLegacyFast(f.from,f.from),{code:'EEXIST'}); assert.equal(fs.readFileSync(f.from,'utf8'),'{"enableUltrafast":true}');
  assert.ok(fs.readdirSync(f.home).every(n=>!n.startsWith('.hibiki-import-')));
});
test('invalid legacy values are rejected rather than silently migrating credentials/unknown fields', (t) => {
  const f=fixture(t);
  for(const raw of ['{broken','null','[]','true','{"enableUltrafast":"true"}','{"apiKey":"SYNTHETIC-secret"}']) {
    fs.writeFileSync(f.from,raw); assert.throws(()=>importLegacyFast(f.from,f.to)); assert.equal(fs.existsSync(f.to),false); assert.equal(fs.readFileSync(f.from,'utf8'),raw);
  }
});
test('import rejects unsafe source and output directory', (t) => {
  const f=fixture(t); const actual=path.join(f.home,'actual'); fs.writeFileSync(actual,'{"enableUltrafast":true}'); fs.symlinkSync(actual,f.from);
  assert.throws(()=>importLegacyFast(f.from,f.to),/Unsafe legacy/); fs.unlinkSync(f.from); fs.linkSync(actual,f.from); assert.throws(()=>importLegacyFast(f.from,f.to),/Unsafe legacy/);
  fs.unlinkSync(f.from); fs.writeFileSync(f.from,'{"enableUltrafast":true}'); const dir=path.join(f.home,'dir'); fs.mkdirSync(dir); fs.symlinkSync(dir,path.join(f.home,'linked-dir'));
  assert.throws(()=>importLegacyFast(f.from,path.join(f.home,'linked-dir','new.json')),/Unsafe output/); assert.equal(fs.readdirSync(dir).length,0);
});
test('CLI requires both explicit paths; parse failures do not expose file contents', (t) => {
  const f=fixture(t); fs.writeFileSync(f.from,'SYNTHETIC-private-flag-file-garbage');
  const args=[[],['--from',f.from],['--from',f.from,'--to',f.to],['--from',f.from,'--from',f.to]];
  for(const input of args) {
    const r=spawnSync(process.execPath,[importer,...input],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:f.home}});
    assert.notEqual(r.status,0); assert.doesNotMatch(r.stderr,/SYNTHETIC-private/); assert.equal(fs.existsSync(f.to),false);
  }
});
