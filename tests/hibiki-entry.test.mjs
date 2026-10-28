import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
import { root, piRoot, variantRoots } from '../scripts/tooling.mjs';
const tui=await import(pathToFileURL(path.join(piRoot(),'node_modules/@earendil-works/pi-tui/dist/index.js')));
function factory(source){
  const registrations=[],hooks=[];
  const fail=()=>{throw new Error('public factory must not access profile, credentials, registry or network');};
  const module=loadTypeScript(source,{'node:fs':new Proxy({constants:fs.constants},{get(target,key){return key in target?target[key]:fail;}}),'node:os':{homedir:()=>'/home/ordinary-synthetic-user'},'@earendil-works/pi-tui':tui,'@earendil-works/pi-ai/providers/all':{getBuiltinProviders:fail},'../lib/model-pick/protection.js':{createRecordProtection:fail}}, {process:{pid:1,env:{},getuid:()=>1000},fetch:fail});
  module.default({registerCommand:(name,command)=>registrations.push({name,command}),registerShortcut:(name,shortcut)=>registrations.push({name,shortcut}),on:(name,handler)=>{hooks.push({name,handler});return ()=>{};}});
  return {registrations,hooks};
}
test('public production factory is lazy and registers only branded contracts with one Fast policy',()=>{
  const p=factory(path.join(variantRoots().productionRoot,'extensions/hibiki-models.ts'));
  assert.deepEqual(p.registrations.map(r=>r.name),['fast','models','ctrl+l','hibiki']);
  for(const item of p.registrations.filter(r=>r.name!=='fast'))assert.match((item.command??item.shortcut).description,/Hibiki · 模型工作台/);
  assert.equal(p.hooks.filter(h=>h.name==='before_provider_request').length,1);assert.equal(p.hooks.filter(h=>h.name==='provider_stream_event').length,1);
});
test('one declared public entry and no metadata/storage rename masquerading as branding',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));assert.equal(pkg.name,'pi-hibiki');assert.equal(pkg.private,true);assert.deepEqual(pkg.pi.extensions,['./extensions/hibiki-models.ts']);
  const picker=fs.readFileSync(path.join(root,'extensions/model-pick.ts'),'utf8');
  for(const name of ['model-pick-order.json','model-pick-favorites.json','model-pick-theme.json','settings.json.bak-model-pick.sealed'])assert.ok(picker.includes(name));
  assert.ok(picker.includes('官方')||picker.includes('原生'));assert.doesNotMatch(picker,/Key\.alt\("f"\)/);
  assert.ok(!fs.existsSync(path.join(root,'models.json')));assert.ok(!fs.existsSync(path.join(root,'auth.json')));
});
