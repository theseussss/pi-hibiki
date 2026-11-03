/** Hibiki host: real registry, durable matrix state and task effects.
 * The V10-derived PickerComponent is the sole renderer/input owner. */
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { fuzzyFilter, parseColor } from '@earendil-works/pi-tui';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FastController } from '../lib/fast.js';
import { PickerComponent } from '../lib/model-pick/component.js';
import { PickerActions, type ActionTarget, type ModelLimitsHost } from '../lib/model-pick/panel.js';
import { PickerStore, StoreError, type Guard } from '../lib/model-pick/store.js';
import { isVirtualLimitTarget, limitPair, readLimitCatalog } from '../lib/model-pick/limit-catalog.js';
import { PickerRecords } from '../lib/model-pick/records.js';
import { createRecordProtection, type RecordProtection } from '../lib/model-pick/protection.js';
import { createProviderCommitBackend, type ProviderCommitBackend } from '../lib/model-pick/provider-commit.js';
import { resolvePickerStorage, type StorageBinding } from '../lib/model-pick/storage-context.js';
import { ProbeError, validateEndpoint } from '../lib/model-pick/probe.js';
import { copyThinkingLevelMap } from '../lib/model-pick/reference.js';
import { mergeVisibleOrder } from '../lib/model-pick/order.js';
import type { MatrixSnapshot, MatrixModel, MatrixProvider, ModelParameters, ModelRef, PickerAction, PickerActionId,
  PickerCommand, PickerPalette, PickerSelection, PickerTarget, PickerTaskSnapshot, PickerWorkspace } from '../lib/model-pick/workspace.js';

export interface PickerHostOptions { fast?: FastController; storageOverride?: StorageBinding }
interface Row { model: Model<Api>; provider: string; id: string; name: string; fullId: string; available: boolean }
interface Group { provider: string; models: Row[] }
interface OrderConfig { providers?: string[]; models?: Record<string,string[]>; [key: string]: unknown }
interface UsageStat { count: number; lastUsed: number }
const clean = (v: unknown): string => String(v ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
const sameRef = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) => a?.provider === b?.provider && a?.id === b?.id;
const refOf = (model: Model<Api> | undefined): ModelRef | null => model ? { provider: String(model.provider), id: model.id } : null;
const fid = (r: ModelRef) => `${r.provider}/${r.id}`;
const object = (v: unknown): v is Record<string,any> => !!v && typeof v === 'object' && !Array.isArray(v);
function readText(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('Unsafe file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const now = fs.fstatSync(fd); if (stat.dev !== now.dev || stat.ino !== now.ino || now.nlink !== 1 || now.size > 16 * 1024 * 1024) throw new Error('Changed file'); return fs.readFileSync(fd,'utf8'); }
  finally { fs.closeSync(fd); }
}
function readJson(file:string): any { return JSON.parse(readText(file)); }
/** Small ancillary files; never repair an unreadable/unsafe existing file. */
function writeJson(file: string, value: unknown, beforeRename?: () => boolean): void {
  const dir = path.dirname(file), parent = fs.lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe directory');
  try { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('Unsafe file'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value,null,2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (beforeRename && !beforeRename()) throw new Error('State changed');
    fs.renameSync(temp,file);
    const d = fs.openSync(dir,fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
function readDefaultState(storage: StorageBinding | null): { known: boolean; ref: ModelRef | null } {
  if (!storage) return { known:false,ref:null };
  try {
    const raw = readJson(path.join(storage.agentDir,'settings.json'));
    if (!object(raw)) return {known:false,ref:null};
    if (raw.defaultProvider === undefined && raw.defaultModel === undefined) return {known:true,ref:null};
    if (typeof raw.defaultProvider === 'string' && raw.defaultProvider && typeof raw.defaultModel === 'string' && raw.defaultModel) return {known:true,ref:{provider:raw.defaultProvider,id:raw.defaultModel}};
  } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {known:true,ref:null}; }
  return {known:false,ref:null};
}
/** Protected rolling backup, unknown settings preserved, expected-default CAS.
 * Per-file rename is atomic, not a claim of a multi-file transaction. */
function writeDefaultModel(storage: StorageBinding, ref: ModelRef, protection: RecordProtection,
  expected: ModelRef | null, canCommit: () => boolean): boolean {
  const file = path.join(storage.agentDir,'settings.json'), backup = `${file}.bak-model-pick.sealed`;
  try {
    const load = (): string | null => { try { return readText(file); } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
    if (!canCommit()) return false;
    const before = load(), raw = before === null ? {} : JSON.parse(before);
    if (!object(raw) || !sameRef(readDefaultState(storage).ref,expected) || !readDefaultState(storage).known) return false;
    raw.defaultProvider = ref.provider; raw.defaultModel = ref.id;
    const sealed = protection.seal({version:1,kind:'model-pick-settings-backup',when:Date.now(),before:before ?? '{}'},'settings');
    if (!canCommit() || load() !== before) return false;
    writeJson(backup,sealed,()=>canCommit()&&load()===before);
    if (!canCommit() || load() !== before) return false;
    writeJson(file,raw,()=>canCommit()&&load()===before); return true;
  } catch { return false; }
}
/** Runtime capability preserved; development tests inject synthetic profile files.
 * Only this verified profile's most recent 60 files contribute, never HOME. */
function collectUsage(agentDir: string): Map<string,UsageStat> {
  const stats = new Map<string,UsageStat>(), files: string[] = [];
  try {
    const dir = path.join(agentDir,'sessions');
    for (const sub of fs.readdirSync(dir)) {
      const child = path.join(dir,sub);
      try { if (!fs.lstatSync(child).isDirectory() || fs.lstatSync(child).isSymbolicLink()) continue;
        for (const name of fs.readdirSync(child)) if (name.endsWith('.jsonl')) files.push(path.join(child,name));
      } catch {}
    }
    files.sort((a,b)=>path.basename(b).localeCompare(path.basename(a)));
    for (const file of files.slice(0,60)) {
      try {
        const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64*1024*1024) continue;
        for (const line of fs.readFileSync(file,'utf8').split('\n')) {
          if (!line.includes('assistant')) continue;
          try { const e = JSON.parse(line), msg = e.message ?? e;
            if (msg.role !== 'assistant' || typeof msg.provider !== 'string') continue;
            const id = typeof msg.model === 'string' ? msg.model : msg.model?.id; if (typeof id !== 'string') continue;
            const key = `${msg.provider}/${id}`, s = stats.get(key) ?? {count:0,lastUsed:0};
            s.count++; s.lastUsed = Math.max(s.lastUsed,Date.parse(e.timestamp ?? msg.timestamp ?? '') || 0); stats.set(key,s);
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return stats;
}

// Original six complete palettes; concrete colors pass through public theme.style.
interface Palette { key:string; name:string; cur:string; def:string; fav:string; sel:string; text:string; dim:string; accent:string; stops:string[]; steps?:boolean }
const PALETTES: readonly Palette[] = [
  {key:'sakura',name:'樱花马卡龙',cur:'#e85d9e',def:'#f2a7c6',fav:'#c7b8f5',sel:'#7fc4e8',text:'#f5ebf0',dim:'#97808e',accent:'#efc3e6',stops:['#f2a7c6','#fcc9b9','#efc3e6','#c7b8f5','#9fd3f2']},
  {key:'dusk',name:'黄昏',cur:'#f8b500',def:'#e16b5b',fav:'#8fb8d8',sel:'#b8a9d9',text:'#f2ede4',dim:'#8d8578',accent:'#f08300',stops:['#f8b500','#e16b5b','#7b5ea7','#2e3a59']},
  {key:'rainbow',name:'彩虹',cur:'#ffd93d',def:'#ff6fb5',fav:'#3dc1d3',sel:'#ffffff',text:'#f0f0f5',dim:'#9aa0a8',accent:'#ff9f43',stops:['#ff5a5a','#ff9f43','#ffd93d','#6bcb3d','#3dc1d3','#4b7bff','#a55ef2']},
  {key:'cyberpunk',name:'赛博朋克',cur:'#fcee0c',def:'#ff2e88',fav:'#00e5ff',sel:'#b537f2',text:'#e8f6ff',dim:'#5e6b8a',accent:'#00ff9c',stops:['#ff2e88','#b537f2','#3b82f6','#00e5ff']},
  {key:'pixel',name:'像素',cur:'#ffd800',def:'#ff4040',fav:'#3dd68c',sel:'#4a90d9',text:'#f0f0e8',dim:'#7a7a8c',accent:'#ff8c42',stops:['#ff4040','#ff8c42','#ffd800','#3dd68c','#4a90d9','#7454e8'],steps:true},
  {key:'mono',name:'原生单色',cur:'#ffb000',def:'#d8d8d8',fav:'#a8a8a8',sel:'#ffffff',text:'#e0e0e0',dim:'#808080',accent:'#c0c0c0',stops:['#6e6e6e','#919191','#b4b4b4','#cdcdcd']},
];
function palette(index:number, light:boolean): PickerPalette {
  const p = PALETTES[index]!;
  return {id:p.key,name:p.name,colors:{current:p.cur,default:p.def,favorite:p.fav,selection:p.sel,text:light?'#302830':p.text,dim:light?'#756675':p.dim,accent:p.accent,blue:p.sel,success:light?'#267246':'#a1d6b5',warning:light?'#8a5c08':'#edcb8d',error:light?'#a22a42':'#f3a7a7'},gradient:[...p.stops],stepped:!!p.steps};
}
function parameters(m: any = {}): ModelParameters {
  const map = copyThinkingLevelMap(m.thinkingLevelMap);
  return { ...(typeof m.name === 'string' ? {name:clean(m.name)} : {}),
    contextWindow:Number.isSafeInteger(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : 128000,
    maxTokens:Number.isSafeInteger(m.maxTokens) && m.maxTokens > 0 ? m.maxTokens : 8192,
    reasoning:m.reasoning === true,
    input:Array.isArray(m.input) ? m.input.filter((x:unknown)=>x==='text'||x==='image') : ['text'],
    ...(map ? {thinkingLevelMap:Object.fromEntries(Object.entries(map).map(([k,v])=>[k,typeof v==='string'?clean(v):v]))} : {}) };
}

export async function openPicker(pi: ExtensionAPI, ctx: ExtensionContext, initialActions = false, initialProviderFocus = false,
  fast?: FastController, initialFast = false, storageOverride?: StorageBinding): Promise<void> {
  if (!ctx.hasUI || (ctx.mode && ctx.mode !== 'tui')) { ctx.ui.notify('模型选择器需要交互模式','error'); return; }
  const registry = ctx.modelRegistry;
  try { await registry.refresh?.({allowNetwork:false}); } catch {}
  const storage = await resolvePickerStorage(registry,storageOverride);
  const protectedProviders = new Set<string>([...getBuiltinProviders(),'radius',...(registry.getRegisteredProviderIds?.() ?? [])]);
  const protection = createRecordProtection();
  const store = storage ? new PickerStore(storage.agentDir,protectedProviders,protection,storage.modelsPath) : undefined;
  const records = storage ? new PickerRecords(storage.agentDir,protection) : undefined;
  const guardSnapshot = (): Guard => {
    const defaults = readDefaultState(storage);
    return {current:refOf(ctx.model) ?? undefined,default:defaults.ref ?? undefined,defaultUnknown:!defaults.known,busy:!ctx.isIdle()};
  };
  const binding = store ? await createProviderCommitBackend({modelRegistry:registry,storageOverride:storage!,store,getGuard:guardSnapshot}) : null;
  const writable = binding?.writable === true;
  const backend: ProviderCommitBackend | undefined = binding?.writable ? binding.backend : undefined;
  let all = registry.getAvailable();
  let custom: ReturnType<PickerStore['snapshot']>['providers'] = [], configReadable = !!store;
  if (store) try { custom = store.snapshot().providers; } catch { configReadable = false; }
  let order: OrderConfig = {}, favorites = new Set<string>(), orderReadable = true, favoritesReadable = true, themeReadable = true, paletteIndex = 0;
  const ancillary = (name:string) => path.join(storage!.agentDir,`model-pick-${name}.json`);
  if (storage) {
    try { const raw = readJson(ancillary('order')); if (!object(raw)) throw new Error(); order = {...raw};
      if (raw.providers !== undefined && (!Array.isArray(raw.providers) || raw.providers.some((x:unknown)=>typeof x!=='string'))) throw new Error();
      if (raw.models !== undefined && (!object(raw.models) || Object.values(raw.models).some(x=>!Array.isArray(x)||x.some(y=>typeof y!=='string')))) throw new Error();
    } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') orderReadable = false; order = {}; }
    try { const raw = readJson(ancillary('favorites')); if (!Array.isArray(raw)||raw.some(x=>typeof x!=='string')) throw new Error(); favorites = new Set(raw); }
    catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') favoritesReadable = false; }
    try { const raw = readJson(ancillary('theme')); if (!object(raw)) throw new Error(); paletteIndex = Math.max(0,PALETTES.findIndex(p=>p.key===raw?.theme)); }
    catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') themeReadable = false; }
  }
  const usage = storage ? collectUsage(storage.agentDir) : new Map<string,UsageStat>();
  let defaults = readDefaultState(storage), rows: Row[] = [], browse: Group[] = [], visible: Group[] = [];
  let query = '', selected: PickerSelection = {kind:'none'}, locate: PickerTarget | null = null;
  let disposed = false, switching = false, isLightTheme = () => false, message = '', error = '';
  const viewId = randomUUID(), listeners = new Set<()=>void>(), credentialSalt = randomBytes(32);
  const credentialVersions = new Map<string,{signature:string;version:string}>();
  let actions: PickerActions | undefined, localTask: PickerTaskSnapshot | null = null;
  let close: (value: ModelRef | null) => void = () => {};
  const changed = () => { if (!disposed) for (const listener of [...listeners]) listener(); };
  const feedback = (text:string, failed = false) => { message = failed ? '' : clean(text); error = failed ? clean(text) : ''; changed(); };
  function refreshRows() {
    const seen = new Set<string>(); rows = [];
    for (const m of all) { const fullId = `${m.provider}/${m.id}`; if (seen.has(fullId)) continue; seen.add(fullId);
      const name = (m.name || m.id).replace(/\s*\([^)]*\)\s*$/, '').trim() || m.name || m.id;
      rows.push({model:m,provider:String(m.provider),id:m.id,name:clean(name),fullId,available:true});
    }
    for (const p of custom) for (const m of p.models) {
      const fullId = `${p.id}/${m.id}`; if (seen.has(fullId)) continue; seen.add(fullId);
      // Display-only unavailable rows are never switch payloads or probe templates.
      const model = registry.find(p.id,m.id) ?? {...m,provider:p.id,name:m.name||m.id,api:p.api} as Model<Api>;
      rows.push({model,provider:p.id,id:m.id,name:clean(m.name||m.id),fullId,available:false});
    }
    const providers = [...new Set([...(order.providers ?? []),...rows.map(r=>r.provider),...custom.map(p=>p.id)])];
    const configRank = new Map(rows.map((r,i)=>[r.fullId,i]));
    const compare = (a:Row,b:Row):number => {
      const seq = order.models?.[a.provider] ?? [], ai = seq.indexOf(a.id), bi = seq.indexOf(b.id);
      if (ai >= 0 || bi >= 0) return ai < 0 ? 1 : bi < 0 ? -1 : ai-bi;
      const ad = sameRef(a,defaults.ref), bd = sameRef(b,defaults.ref); if (ad!==bd) return ad ? -1 : 1;
      const af = favorites.has(a.fullId), bf = favorites.has(b.fullId); if (af!==bf) return af ? -1 : 1;
      const au = usage.get(a.fullId), bu = usage.get(b.fullId);
      return (bu?.count??0)-(au?.count??0) || (bu?.lastUsed??0)-(au?.lastUsed??0) || (configRank.get(a.fullId)??0)-(configRank.get(b.fullId)??0);
    };
    browse = providers.flatMap(provider=>{
      const models = rows.filter(r=>r.provider===provider).sort(compare);
      return models.length || custom.some(p=>p.id===provider) ? [{provider,models}] : [];
    });
    filter();
  }
  const providerLabel = (id:string) => clean(custom.find(p=>p.id===id)?.name || id);
  function filter() {
    if (!query.trim()) visible = browse;
    else {
      const hits = fuzzyFilter(browse.flatMap(p=>p.models),query,r=>`${r.name} ${r.id} ${r.provider} ${providerLabel(r.provider)}`), groups = new Map<string,Row[]>();
      for (const hit of hits) { if (!groups.has(hit.provider)) groups.set(hit.provider,[]); groups.get(hit.provider)!.push(hit); }
      for (const p of fuzzyFilter(browse.filter(p=>!p.models.length),query,p=>`${p.provider} ${providerLabel(p.provider)}`)) groups.set(p.provider,[]);
      visible = [...groups].map(([provider,models])=>({provider,models}));
    }
    const provider = selected.kind==='model' ? selected.ref.provider : selected.kind==='provider' ? selected.provider : '';
    const group = visible.find(p=>p.provider===provider);
    if (group && (selected.kind!=='model' || group.models.some(m=>m.id===(selected as {kind:'model';ref:ModelRef}).ref.id))) return;
    const first = group ?? visible[0];
    selected = first ? (selected.kind==='provider' || !first.models.length ? {kind:'provider',provider:first.provider} : {kind:'model',ref:{provider:first.provider,id:first.models[0]!.id}}) : {kind:'none'};
  }
  refreshRows();
  const current = refOf(ctx.model);
  if (current && rows.some(r=>sameRef(r,current))) selected = initialProviderFocus ? {kind:'provider',provider:current.provider} : {kind:'model',ref:current};
  else if (browse[0]) selected = initialProviderFocus || !browse[0].models.length ? {kind:'provider',provider:browse[0].provider} : {kind:'model',ref:{provider:browse[0].provider,id:browse[0].models[0]!.id}};
  // Retain archived/temporarily unavailable identities. Cleanup is fail-closed.
  if (storage && store && writable && configReadable && orderReadable && favoritesReadable) {
    try {
      const retained = store.retained(), liveP = new Set([...browse.map(p=>p.provider),...retained.providers]), liveM = new Set([...rows.map(r=>r.fullId),...retained.models]);
      try { const catalog = readJson(path.join(storage.agentDir,'models-store.json'));
        for (const [p,cfg] of Object.entries(catalog ?? {})) { liveP.add(p); for (const m of Array.isArray((cfg as any)?.models) ? (cfg as any).models : []) { const id = typeof m==='string'?m:m?.id; if (typeof id==='string') liveM.add(`${p}/${id}`); } }
      } catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
      const beforeOrder = JSON.stringify(order), beforeFav = JSON.stringify([...favorites]);
      if (order.providers) order.providers = order.providers.filter(p=>liveP.has(p));
      if (order.models) order.models = Object.fromEntries(Object.entries(order.models).filter(([p])=>liveP.has(p)).map(([p,ids])=>[p,ids.filter(id=>liveM.has(`${p}/${id}`))]));
      favorites = new Set([...favorites].filter(id=>liveM.has(id)));
      if (JSON.stringify(order)!==beforeOrder) writeJson(ancillary('order'),order);
      if (JSON.stringify([...favorites])!==beforeFav) writeJson(ancillary('favorites'),[...favorites]);
      refreshRows();
    } catch { /* Retention/config trouble must not trigger destructive cleanup. */ }
  }
  const target = (): ActionTarget => selected.kind==='model' ? {kind:'model',provider:selected.ref.provider,modelId:selected.ref.id} : selected.kind==='provider' ? {kind:'provider',provider:selected.provider} : {};
  const pending = () => { if (!store) return false; try { return store.hasPending(); } catch { return true; } };
  // Rendering/fuzzy search consume cached metadata. Durable guards below still
  // read/recheck live files immediately before every effect.
  let pendingView = pending();
  const liveCandidate = (ref:ModelRef): Model<Api> | undefined => {
    if (pending()) return undefined;
    const m = registry.getAvailable().find(m=>String(m.provider)===ref.provider&&m.id===ref.id);
    if (!m) return undefined;
    if (!store || protectedProviders.has(ref.provider)) return m;
    try { return store.snapshot().providers.some(p=>p.id===ref.provider&&p.models.some(m=>m.id===ref.id)) ? m : undefined; } catch { return undefined; }
  };
  const canWrite = () => !disposed && writable && configReadable && !guardSnapshot().busy && !pending();
  // Connection protection remains intact. Only exact physical chat targets may
  // acquire this narrower, metadata-only capability; rendering does no IO/auth.
  const limitEligible = (provider:string,modelId:string) => !disposed&&writable&&configReadable&&protectedProviders.has(provider)
    &&!isVirtualLimitTarget(registry,provider,modelId,VERSION);
  const cacheLimitRefs = () => new Set(writable?registry.getAll().filter(m=>protectedProviders.has(String(m.provider))
    &&((m as any).type===undefined||(m as any).type==='chat')&&limitPair(m)!==null
    &&!isVirtualLimitTarget(registry,String(m.provider),m.id,VERSION)).map(m=>fid({provider:String(m.provider),id:m.id})):[]);
  // Materialize only at explicit open/refresh boundaries. SDK getAll() calls
  // provider getModels/projection callbacks; it must never run from paint.
  let knownLimitRefs=cacheLimitRefs();
  const limitTarget = (provider:string,modelId:string): Model<Api> | undefined => {
    if(!limitEligible(provider,modelId))return undefined;
    const m=registry.find(provider,modelId);
    return m&&String(m.provider)===provider&&m.id===modelId
      &&((m as any).type===undefined||(m as any).type==='chat')&&limitPair(m)!==null?m:undefined;
  };
  const requireLimitTarget = (provider:string,modelId:string): Model<Api> => {
    const model=limitTarget(provider,modelId);if(!model)throw new StoreError('PROTECTED');return model;
  };
  const modelLimits: ModelLimitsHost | undefined = store&&writable ? {
    canEdit:(provider,modelId)=>limitEligible(provider,modelId)&&knownLimitRefs.has(fid({provider,id:modelId})),
    read:(provider,modelId)=>{
      const effective=limitPair(requireLimitTarget(provider,modelId))!;
      const saved=store.modelLimitsOverride(provider,modelId), config=store.snapshot();
      if(config.revision!==saved.revision)throw new StoreError('CONFLICT');
      const local=config.providers.some(p=>p.id===provider&&p.models.some(m=>m.id===modelId));
      return {revision:saved.revision,effective,overrides:{...saved.values},...readLimitCatalog(registry,provider,modelId,VERSION,local)};
    },
    commit:(provider,modelId,patch,revision)=>{
      const state=modelLimits!.read(provider,modelId), expected={...state.effective};
      if(state.revision!==revision)throw new StoreError('CONFLICT');
      const preview: Record<string,number|undefined>={};
      for(const key of ['contextWindow','maxTokens'] as const){
        const next=Object.hasOwn(patch,key)?patch[key]:state.overrides[key];
        preview[key]=next??state.catalog?.[key]??(state.overrides[key]===undefined?state.effective[key]:undefined);
      }
      if(preview.contextWindow!==undefined&&preview.maxTokens!==undefined&&preview.maxTokens>preview.contextWindow)throw new StoreError('INVALID_INPUT');
      const check=()=>{
        const now=limitPair(requireLimitTarget(provider,modelId))!;
        if(now.contextWindow!==expected.contextWindow||now.maxTokens!==expected.maxTokens)throw new StoreError('CONFLICT');
      };
      store.putModelLimitsOverride(provider,modelId,patch,revision,{...guardSnapshot(),recheck:guardSnapshot},check);
    },
  } : undefined;
  function publicInfo(title:string, lines:string[]) {
    localTask = {kind:'info',purpose:'details',title,viewId:randomUUID(),flowId:randomUUID(),reviewToken:null,
      content:{stage:'',title,sections:[{lines:lines.map(clean)}]},actions:[{id:'close-info',identity:'close-info',label:'返回',disabled:false,digit:'0'}]}; changed();
  }
  const credentialVersion = (provider:string,headers:Record<string,string>) => {
    const signature = createHmac('sha256',credentialSalt).update(JSON.stringify(headers)).digest('hex');
    let entry = credentialVersions.get(provider);
    if (!entry || entry.signature!==signature) { entry = {signature,version:randomUUID()}; credentialVersions.set(provider,entry); }
    return `${store!.snapshot().revision}:${entry.version}`;
  };
  const workspace: PickerWorkspace = {
    snapshot: () => ({matrix:matrixSnapshot(),task:localTask ?? actions?.taskSnapshot() ?? null}),
    subscribe: listener => { if (disposed) return () => {}; listeners.add(listener); return () => {listeners.delete(listener);}; },
    formFields: id => actions?.formFields(id),
    dispatch: async command => {
      if (disposed) return;
      if (localTask && command.viewId===localTask.viewId) { if (command.type==='activate' && ['back','cancel-task','close-info'].includes(command.id)) {localTask=null;changed();} return; }
      if (command.viewId!==viewId) { await actions?.dispatch(command); return; }
      if (command.type==='matrix-query') { if (!actions?.active) { query=command.query.slice(0,8192); filter(); changed(); } return; }
      if (command.type==='matrix-select') {
        if (actions?.active) return;
        const s = command.selection;
        if (s.kind==='none') { if (!visible.length) selected=s; }
        else if (s.kind==='provider' ? visible.some(p=>p.provider===s.provider) : visible.some(p=>p.provider===s.ref.provider&&p.models.some(m=>m.id===s.ref.id))) selected = s.kind==='model'?{kind:'model',ref:{...s.ref}}:{...s};
        changed(); return;
      }
      if (command.type!=='activate') return;
      const action = matrixSnapshot().actions.find(a=>a.id===command.id&&a.identity===command.identity);
      if (!action || action.disabled || (actions?.active && action.id!=='cycle-palette')) return;
      try { await activate(command); } catch { feedback('操作未确认完成；请重新核对当前状态。',true); }
    },
    dispose: () => {
      if (disposed) return; disposed=true; unsubscribeActions?.(); unsubscribeFast?.(); actions?.dispose(); listeners.clear();
      credentialSalt.fill(0); credentialVersions.clear(); store?.lock(); protection.clear();
    },
  };
  let unsubscribeActions: (()=>void) | undefined, unsubscribeFast: (()=>void) | undefined;
  function matrixSnapshot(): MatrixSnapshot {
    const cur = refOf(ctx.model), selectedProvider = selected.kind==='model'?selected.ref.provider:selected.kind==='provider'?selected.provider:'';
    const selectedRef = selected.kind==='model' ? selected.ref : null;
    const group = browse.find(p=>p.provider===selectedProvider), row = selectedRef?group?.models.find(m=>sameRef(m,selectedRef)):undefined;
    const guard: Guard = {current:cur??undefined,default:defaults.ref??undefined,defaultUnknown:!defaults.known,busy:!ctx.isIdle()};
    const blocked = disposed||!writable||!configReadable||!!guard.busy||pendingView, mutable = !!group&&!protectedProviders.has(group.provider)&&custom.some(p=>p.id===group.provider);
    const index = row ? group!.models.indexOf(row) : -1, pi = group?browse.indexOf(group):-1;
    const list: PickerAction[] = [];
    const add = (id:PickerActionId,label:string,disabled=false,digit?:PickerAction['digit'],extra:Partial<PickerAction>={}) => list.push({id,identity:id,label,disabled,...(digit?{digit}:{}),...extra});
    if (row) {
      add('switch',sameRef(row,cur)?'使用中':'切换',guard.busy||switching||!row.available||pendingView,undefined,{shortcut:'Enter',primary:true});
      add('favorite',favorites.has(row.fullId)?'取消收藏':'收藏',blocked||!favoritesReadable,'1');
      add('edit-model',mutable&&writable||modelLimits?.canEdit(row.provider,row.id)?'编辑':'查看参数',false,'2');
      add('inspect','检查',!store||guard.busy||pendingView,'3');
      add('default',sameRef(row,defaults.ref)?'默认':'设为默认',blocked||!defaults.known||sameRef(row,defaults.ref)||!row.available,'4');
      add('move-left','前移',blocked||!orderReadable||!!query.trim()||index<=0,'5');
      add('move-right','后移',blocked||!orderReadable||!!query.trim()||index>=group!.models.length-1,'6');
      add('remove-model','移除',blocked||!mutable,'8',{danger:true});
    }
    if (group) {
      // Hidden in the model template, retained for legacy Alt+Up/Down shortcuts.
      add('edit-provider','编辑连接',!mutable||blocked,'2');
      add('provider-up','上移',blocked||!orderReadable||!!query.trim()||pi<=0,'5');
      add('provider-down','下移',blocked||!orderReadable||!!query.trim()||pi>=browse.length-1,'6');
      add('add-model','添加模型',blocked||!mutable,'7');
      add('remove-provider','移除供应商',blocked||!mutable,'8',{danger:true});
    }
    add('new-provider','添加供应商',blocked,'9'); add('archives','已移除',!store,'0');
    add('undo','撤销',blocked||!actions?.undoLabel,undefined,{shortcut:'Alt Z'}); add('locate','定位',!locate,undefined,{shortcut:'Alt L'});
    const session = fast?.snapshot(ctx);
    if (row && sameRef(row,cur) && session?.supported) add('fast',session.active?'关闭会话 Fast':'开启会话 Fast',guard.busy);
    add('cycle-palette','配色',false,undefined,{shortcut:'Alt T'}); add('help','帮助');
    const providers: MatrixProvider[] = browse.map(p=>{
      const saved = custom.find(c=>c.id===p.provider);
      return {id:clean(p.provider),name:providerLabel(p.provider),readonly:!writable||protectedProviders.has(p.provider),
        ...(saved?{endpoint:clean(saved.endpoint),api:clean(saved.api)}:{}),models:p.models.map((r):MatrixModel=>({ref:{provider:r.provider,id:r.id},name:r.name,parameters:parameters(r.model),favorite:favorites.has(r.fullId),readonly:!writable||protectedProviders.has(r.provider),limitsEditable:!!modelLimits?.canEdit(r.provider,r.id),availability:r.available?'ready':'unavailable',...(!r.available?{unavailableReason:'未就绪；请检查凭据或连接'}:{})}))};
    });
    return {kind:'matrix',viewId,reviewToken:null,providers,visible:visible.map(p=>({provider:p.provider,modelIds:p.models.map(m=>m.id)})),query,selected,current:cur,default:defaults.ref,defaultKnown:defaults.known,busy:!!guard.busy,configReadable,
      palette:palette(paletteIndex,isLightTheme()),fast:{current:cur,modelLabel:clean(session?.modelLabel??(cur?fid(cur):'未选择模型')),tier:session?.tier??'off',supported:session?.supported??false,active:session?.active??false,ultrafastEnabled:session?.ultrafastEnabled??false},
      undo:actions?.undoLabel?{identity:'undo',label:clean(actions.undoLabel)}:null,locate,actions:list,message:message||(!storage?'无法验证此 SDK 的存储绑定：仅查看/切换；未读取默认 profile。':!writable?'存储兼容性未确认：修改已禁用。':undefined),error:error||undefined};
  }
  async function activate(command: Extract<PickerCommand,{type:'activate'}>) {
    const t = target(), ref = selected.kind==='model'?{...selected.ref}:null;
    const expectedPayload = 'payload' in command ? command.payload : undefined;
    if (ref && ['switch','favorite','default','edit-model','inspect','move-left','move-right','remove-model'].includes(command.id) && (!expectedPayload || !sameRef(expectedPayload as ModelRef,ref))) return;
    if (['add-model','edit-provider','provider-up','provider-down','remove-provider'].includes(command.id) && (!expectedPayload || (expectedPayload as {provider:string}).provider!==t.provider)) return;
    if (command.id==='switch' && ref) {
      switching=true; changed();
      try { await registry.refresh?.({allowNetwork:false}); if (disposed||guardSnapshot().busy||!liveCandidate(ref)) { feedback('模型或凭据已变化，未切换。',true); return; } close(ref); }
      finally {switching=false;changed();} return;
    }
    if (command.id==='cycle-palette') {
      paletteIndex=(paletteIndex+1)%PALETTES.length;
      if (storage&&writable&&themeReadable) try { const file=ancillary('theme'); let raw:Record<string,unknown>={}; try {const data=readJson(file);if(object(data))raw=data;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;} writeJson(file,{...raw,theme:PALETTES[paletteIndex]!.key}); }
      catch {feedback('配色已临时切换；保存失败。',true);return;}
      feedback(`配色 → ${PALETTES[paletteIndex]!.name}`); return;
    }
    if (command.id==='help') { if(actions) actions.openHelp(); else publicInfo('快捷键',['Tab/Shift+Tab 切换对象与动作；Alt+数字执行可见动作。','Enter 切换；Alt+T 六套配色；F1/Alt+H 帮助。','未知存储绑定仅支持查看和切换；不会读取或改写默认 profile。']); return; }
    if (command.id==='edit-model' && ref && !actions) { const row=rows.find(m=>sameRef(m,ref));publicInfo('模型参数',[fid(ref),...Object.entries(parameters(row?.model)).map(([k,v])=>`${k}：${JSON.stringify(v)}`)]);return; }
    if (command.id==='favorite' && ref && canWrite() && favoritesReadable) {
      const next=new Set(favorites); if(next.has(fid(ref)))next.delete(fid(ref));else next.add(fid(ref));
      writeJson(ancillary('favorites'),[...next]); favorites=next;refreshRows();changed();return;
    }
    if (command.id==='default' && ref && storage && canWrite()) {
      const before=readDefaultState(storage); if (!before.known) return;
      if(writeDefaultModel(storage,ref,protection,before.ref,()=>canWrite()&&!!liveCandidate(ref))) {defaults=readDefaultState(storage);refreshRows();feedback(`默认 → ${fid(ref)}`);}
      else feedback('默认设置未确认完成；请重新打开核对。',true);return;
    }
    if (['move-left','move-right','provider-up','provider-down'].includes(command.id) && canWrite() && orderReadable && !query.trim()) {
      const group=browse.find(p=>p.provider===t.provider); if(!group)return;
      const next:OrderConfig={...order,models:{...order.models}};
      if (command.id==='move-left'||command.id==='move-right') {
        const list=[...group.models], at=list.findIndex(m=>m.id===t.modelId), to=at+(command.id==='move-left'?-1:1);if(at<0||to<0||to>=list.length)return;
        [list[at],list[to]]=[list[to]!,list[at]!];next.models![group.provider]=mergeVisibleOrder(order.models?.[group.provider]??[],list.map(m=>m.id));
      } else { const list=[...browse], at=list.indexOf(group), to=at+(command.id==='provider-up'?-1:1);if(to<0||to>=list.length)return;
        [list[at],list[to]]=[list[to]!,list[at]!];next.providers=mergeVisibleOrder(order.providers??[],list.map(p=>p.provider)); }
      writeJson(ancillary('order'),next);order=next;refreshRows();changed();return;
    }
    if (command.id==='locate' && locate) { const loc=locate;query='';selected=loc.kind==='model'?{kind:'model',ref:{...loc.ref}}:{...loc};locate=null;filter();changed();return; }
    if (command.id==='fast' && fast && ref && sameRef(ref,refOf(ctx.model)) && fast.snapshot(ctx).supported) {fast.setTier(fast.snapshot(ctx).active?'off':'priority',ctx);changed();return;}
    if (!actions) return;
    switch(command.id) {
      case 'edit-model':case 'edit-provider':actions.open(t,'edit');break;
      case 'inspect':actions.open(t,'inspect');break;
      case 'add-model':actions.open({kind:'provider',provider:t.provider},'add');break;
      case 'remove-model':actions.open(t,'remove');break;
      case 'remove-provider':actions.open({kind:'provider',provider:t.provider},'remove');break;
      case 'new-provider':actions.open({},'new-provider');break;
      case 'archives':actions.open({},'archives');break;
      case 'undo':actions.undoLast();break;
      case 'recover':actions.open({},'recover');break;
    }
  }
  let component: PickerComponent | undefined;
  try {
    const picked = await ctx.ui.custom<ModelRef|null>((tui,theme,_kb,done)=>{
      let completed = false;
      close=value=>{if(!completed){completed=true;done(value);}};
      isLightTheme = () => theme.appearance === 'light';
      if (store&&records) {
        actions = new PickerActions({store,records,providerCommit:backend,storageWritable:writable,modelLimits,
          catalog:()=>registry.getAll(),available:()=>registry.getAvailable(),providerLabel,isProtected:p=>protectedProviders.has(p),guard:()=>({...guardSnapshot(),recheck:guardSnapshot}),
          fast:fast?{snapshot:()=>fast.snapshot(ctx),setTier:t=>fast.setTier(t,ctx),describe:()=>fast.describe(ctx)}:undefined,
          feedback,storageStateChanged:()=>{pendingView=pending();changed();},requestRender:()=>{changed();if(!disposed)tui.requestRender();},flushRender:()=>{if(!disposed)(tui as any).renderNow?.();},
          viewport:()=>({width:tui.terminal.columns,height:tui.terminal.rows}),
          paint:(kind,text)=>{const p=PALETTES[paletteIndex]!;const colors:Record<string,string>={cur:p.cur,def:p.def,fav:p.fav,sel:p.sel,text:p.text,dim:p.dim,accent:p.accent};return colors[kind]?theme.style(text,{fg:parseColor(colors[kind]!)}):theme.fg(kind as 'error',text);},
          authStatus:provider=>{try{const status=registry.getProviderAuthStatus(provider);return !status?.configured?'未配置':status.source==='stored'?'已通过原生凭据库保存':status.source==='runtime'?'本次运行时参数':'环境变量或配置';}catch{return '未知';}},
          changed:async changedTarget=>{
            const previous=new Set(rows.map(r=>r.fullId)), oldCurrent=ctx.model;
            let failure=false;
            try {await registry.refresh?.({allowNetwork:false});}catch{failure=true;}
            if(disposed)return;
            try{custom=store.snapshot().providers;configReadable=true;}catch{configReadable=false;failure=true;}
            all=registry.getAvailable();knownLimitRefs=cacheLimitRefs();defaults=readDefaultState(storage);pendingView=pending();refreshRows();
            // Parameter edits on the current same-ID object must rebind the canonical
            // registry object. Provider connection/key changes are refused by backend.
            if(changedTarget?.modelId&&oldCurrent&&String(oldCurrent.provider)===changedTarget.provider&&oldCurrent.id===changedTarget.modelId
              &&sameRef(refOf(ctx.model),{provider:changedTarget.provider,id:changedTarget.modelId})){
              const canonical=registry.find(changedTarget.provider,changedTarget.modelId);
              if(!canonical||guardSnapshot().busy)failure=true;
              // A refresh can await while another trusted host action switches the
              // session. A metadata save must never switch it back to an old ref.
              else if(sameRef(refOf(ctx.model),{provider:changedTarget.provider,id:changedTarget.modelId})&&canonical!==ctx.model){try{if(!(await pi.setModel(canonical)))failure=true;}catch{failure=true;}}
            }
            const added=rows.find(r=>!previous.has(r.fullId));
            if(changedTarget&&browse.some(p=>p.provider===changedTarget.provider)) locate=changedTarget.modelId?{kind:'model',ref:{provider:changedTarget.provider,id:changedTarget.modelId}}:{kind:'provider',provider:changedTarget.provider};
            else if(added)locate={kind:'model',ref:{provider:added.provider,id:added.id}};
            changed();if(failure)throw new Error('SAVED_REFRESH_FAILED');
          },
          replace:async(ref,targets,expected=guardSnapshot())=>{
            const before=guardSnapshot();if(!canWrite()||before.defaultUnknown||(targets.current&&!sameRef(before.current,expected.current))||(targets.default&&!sameRef(before.default,expected.default)))throw new Error('Replacement unavailable');
            const candidate=liveCandidate(ref);if(!candidate)throw new Error('Replacement unavailable');
            if(targets.default)protection.seal({kind:'model-pick-default-preflight',version:1},'settings');
            if(targets.current&&!(await pi.setModel(candidate)))throw new Error('Replacement unavailable');
            const after=guardSnapshot();if(!canWrite()||after.defaultUnknown||!liveCandidate(ref)||(targets.current&&!sameRef(after.current,ref))||(targets.default&&!sameRef(after.default,expected.default)))throw new Error('Replacement partially applied');
            if(targets.default&&!writeDefaultModel(storage!,ref,protection,expected.default??null,()=>canWrite()&&!!liveCandidate(ref)))throw new Error('Replacement partially applied');
            defaults=readDefaultState(storage);refreshRows();changed();
          },
          authDraft:async(provider,modelId,key)=>{
            if(disposed||pending())throw new ProbeError('cancelled');validateEndpoint(provider.endpoint);
            if(!key&&(!provider.envVar||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(provider.envVar)))throw new ProbeError('auth');
            const value=key??process.env[provider.envVar!];if(!value)throw new ProbeError('auth');
            const headers:Record<string,string>=provider.api==='anthropic-messages'?{'x-api-key':value}:provider.api==='google-generative-ai'?{'x-goog-api-key':value}:{authorization:`Bearer ${value}`};
            return {scope:{provider:provider.id,modelId,endpoint:provider.endpoint,api:provider.api,credentialVersion:credentialVersion(provider.id,headers)},headers};
          },
          auth:async(provider,modelId)=>{
            if(disposed||pending())throw new ProbeError('cancelled');
            // Discovery belongs to the supplier endpoint, not whichever model
            // happens to be first (that model may have its own endpoint/API).
            const p=store.snapshot().providers.find(p=>p.id===provider),m=modelId?registry.find(provider,modelId):undefined;
            const endpoint=m?.baseUrl||p?.endpoint,api=m?.api||p?.api;if(!endpoint)throw new ProbeError('protocol');validateEndpoint(endpoint);
            if(!api||!['openai-completions','openai-responses','anthropic-messages','google-generative-ai'].includes(api))throw new ProbeError('unsupported');
            const result=await registry.getApiKeyAndHeaders({...m,provider,id:modelId||m?.id||'catalog',api,baseUrl:endpoint} as Model<Api>);
            if(disposed||pending())throw new ProbeError('cancelled');if(!result?.ok)throw new ProbeError('auth');
            if(result.baseUrl&&validateEndpoint(result.baseUrl).toString()!==validateEndpoint(endpoint).toString())throw new ProbeError('protocol');
            const headers:Record<string,string>=Object.fromEntries(Object.entries(result.headers??{}).filter((entry): entry is [string,string]=>typeof entry[1]==='string')),has=(k:string)=>Object.keys(headers).some(h=>h.toLowerCase()===k);
            if(result.apiKey){if(api==='anthropic-messages'&&!has('x-api-key')&&!has('authorization'))headers['x-api-key']=result.apiKey;
              else if(api==='google-generative-ai'&&!has('x-goog-api-key'))headers['x-goog-api-key']=result.apiKey;
              else if(!has('authorization')&&api!=='anthropic-messages'&&api!=='google-generative-ai')headers.authorization=`Bearer ${result.apiKey}`;}
            return {scope:{provider,modelId:modelId||m?.id||'catalog',endpoint,api,credentialVersion:credentialVersion(provider,headers)},headers};
          },
        });
        unsubscribeActions=actions.subscribe(changed);
      }
      unsubscribeFast=fast?.subscribe(()=>{if(!disposed){actions?.refreshFast();changed();}});
      if(initialFast&&actions&&fast)actions.openFast();
      else if(initialFast&&!actions)publicInfo('会话 Fast',[fast?.describe(ctx)??'Fast 未启用。']);
      component=new PickerComponent(workspace,tui,theme,()=>close(null));
      // Initial manage/providers enters visible actions, not an obsolete root menu.
      // The component applies focus once on its first render (no second input owner).
      if(initialActions)component.focusActions();
      return component;
    },{overlay:true,overlayOptions:{anchor:'bottom-center',width:'100%',maxHeight:'100%',margin:0}});
    if(picked){
      // Selection result is identity-only. Revalidate against the fresh registry;
      // never submit the stale display row after a task/credential edit.
      try {await registry.refresh?.({allowNetwork:false});const candidate=liveCandidate(picked);
        const ok=!!candidate&&!guardSnapshot().busy&&await pi.setModel(candidate);
        ctx.ui.notify(ok?`已切换到 ${clean(picked.provider)}/${clean(picked.id)}`:'切换失败；模型或凭据已变化。',ok?'info':'error');
      }catch{ctx.ui.notify('切换失败；请检查模型和凭据。','error');}
    }
  } finally {component?.dispose();workspace.dispose();}
}

export default function modelPickExtension(pi:ExtensionAPI,options:PickerHostOptions={}) {
  pi.registerCommand('models',{
    description:'Hibiki · 模型工作台：Tab 切换对象/动作；Alt+数字直达；Alt+T 配色',
    handler:async(args,ctx)=>{const action=args.trim().toLowerCase();if(action&&!['manage','providers','fast'].includes(action)){ctx.ui.notify('用法：/models [manage|providers|fast]','info');return;}
      await openPicker(pi,ctx,action==='manage'||action==='providers',action==='providers',options.fast,action==='fast',options.storageOverride);},
  });
  pi.registerShortcut('ctrl+l',{description:'Hibiki · 打开模型矩阵',handler:async ctx=>{await openPicker(pi,ctx,false,false,options.fast,false,options.storageOverride);}});
}
