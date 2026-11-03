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
  const module=loadTypeScript(source,{'node:fs':new Proxy({constants:fs.constants},{get(target,key){return key in target?target[key]:fail;}}),'node:os':{homedir:()=>'/home/ordinary-synthetic-user'},'@earendil-works/pi-coding-agent':{getAgentDir:fail},'@earendil-works/pi-tui':tui,'@earendil-works/pi-ai/providers/all':{getBuiltinProviders:fail},'../lib/model-pick/protection.js':{createRecordProtection:fail}}, {process:{pid:1,env:{},getuid:()=>1000},fetch:fail});
  module.default({registerCommand:(name,command)=>registrations.push({name,command}),registerShortcut:(name,shortcut)=>registrations.push({name,shortcut}),on:(name,handler)=>{hooks.push({name,handler});return ()=>{};}});
  return {registrations,hooks};
}
test('public production factory is lazy and registers only branded contracts with one Fast policy',()=>{
  const p=factory(path.join(variantRoots().productionRoot,'extensions/hibiki-models.ts'));
  assert.deepEqual(p.registrations.map(r=>r.name),['fast','models','ctrl+l','hibiki']);
  for(const item of p.registrations.filter(r=>r.name!=='fast'))assert.match((item.command??item.shortcut).description,/Hibiki · (?:模型工作台|打开模型矩阵)/);
  assert.equal(p.hooks.filter(h=>h.name==='session_start').length,2);
  assert.equal(p.hooks.filter(h=>h.name==='before_provider_request').length,1);assert.equal(p.hooks.filter(h=>h.name==='provider_stream_event').length,1);
});
test('one declared public entry and no metadata/storage rename masquerading as branding',()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));assert.equal(pkg.name,'pi-hibiki');assert.equal(pkg.private,true);assert.deepEqual(pkg.pi.extensions,['./extensions/hibiki-models.ts']);
  const picker=fs.readFileSync(path.join(root,'extensions/model-pick.ts'),'utf8');
  for(const name of ['order','favorites','theme'])assert.ok(picker.includes(`ancillary('${name}')`));
  assert.ok(picker.includes('settings.json'));assert.ok(picker.includes('.bak-model-pick.sealed'));
  assert.ok(picker.includes('protectedProviders'));assert.doesNotMatch(picker,/Key\.alt\("f"\)/);
  assert.ok(!fs.existsSync(path.join(root,'models.json')));assert.ok(!fs.existsSync(path.join(root,'auth.json')));
});
test('unknown SDK session startup never reads default HOME and rejects restored or requested Ultrafast', async()=>{
  const p=factory(path.join(variantRoots().productionRoot,'extensions/hibiki-models.ts'));
  const statuses=new Map(),notices=[];
  const ctx={modelRegistry:{},model:{provider:'clf-responses',api:'openai-responses',id:'gpt-6-astra'},sessionManager:{getBranch:()=>[{type:'custom',customType:'gpt-fast-mode-state',data:{version:2,tier:'ultrafast'}}]},ui:{setStatus:(key,value)=>statuses.set(key,value),notify:message=>notices.push(message)}};
  const startups=p.hooks.filter(h=>h.name==='session_start');assert.equal(startups.length,2);
  for(const h of startups)await h.handler({type:'session_start',reason:'startup'},ctx);
  assert.equal(statuses.get('gpt-fast-mode'),undefined);
  const payload={model:'gpt-6-astra',input:'synthetic only'};
  const result=await p.hooks.find(h=>h.name==='before_provider_request').handler({payload},ctx);
  assert.equal(result.service_tier,undefined);
  await p.registrations.find(r=>r.name==='fast').command.handler('ultrafast',ctx);
  assert.match(notices.at(-1),/Ultrafast 默认禁用/);
});
test('branded help/status/completions stay headless and expose accepted controls without old menus',async()=>{
  const p=factory(path.join(variantRoots().productionRoot,'extensions/hibiki-models.ts'));
  const notices=[],command=p.registrations.find(r=>r.name==='hibiki').command;
  assert.deepEqual(Array.from(command.getArgumentCompletions('p'),x=>x.value),['providers']);
  const ctx={hasUI:false,mode:'rpc',modelRegistry:{},sessionManager:{getBranch:()=>[]},ui:{notify:message=>notices.push(message)}};
  await command.handler('help',ctx);assert.match(notices.at(-1),/Tab\/Shift\+Tab.*对象.*动作/);assert.match(notices.at(-1),/Alt\+1 收藏/);assert.doesNotMatch(notices.at(-1),/Tab.*收藏|更多…/);
  await command.handler('status',ctx);assert.match(notices.at(-1),/当前\/默认模型.*候选/);
  await command.handler('invalid',ctx);assert.match(notices.at(-1),/用法/);
  for(const action of ['', 'manage', 'providers', 'fast']){await command.handler(action,ctx);assert.match(notices.at(-1),/需要交互模式/);}
});
