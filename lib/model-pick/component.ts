import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  Input, SelectList, Key, matchesKey, isKeyRelease, isKeyRepeat, decodeKittyPrintable,
  visibleWidth, truncateToWidth, wrapTextWithAnsi, parseColor,
  type TUI, type Focusable, type TuiMouseEvent, type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import type {
  PickerWorkspace, PickerSnapshot, PickerTaskSnapshot, MatrixSnapshot, ModelRef, PickerSelection,
  PickerAction, PickerActionId, PickerActivation, PickerActionPayloads, PickerCommand,
  PrivateFormField, PrivateFormPort, ReviewProof, ModelParameters, FieldEvidence, ModelDiff,
} from './workspace.js';
import { actionTemplates, commandSlot, commandColumns, compactRows, safe, type ActionSlotSpec } from './layout.js';
import { homeColumns, homeWindow, homeRule, homeContext, middle } from './home-layout.js';
import { BRAND, ROLE, DISPLAY_NAME } from '../identity.js';

type View = MatrixSnapshot | PickerTaskSnapshot;
type Tone = keyof MatrixSnapshot['palette']['colors'];
type Zone = 'query' | 'candidates' | 'selected';
type Origin = 'matrix' | 'matrix-query' | 'form' | Zone | 'content';
type Hit = { x: number; w: number; run(event?: TuiMouseEvent): void };
type Row = { text: string; focus?: boolean; review?: boolean; hits?: Hit[] };
type Rect = { index: number; x: number; y: number; width: number; height: number };
type Slot = Omit<Rect, 'index'> & { key: string; actionIndex: number | null };
type Cell = Omit<Rect, 'index'> & { pid: string; mid: string };
type Field = PrivateFormField | { kind: 'advanced'; id: 'advanced'; label: string; readonly: false };
type Frame = { offset: number; actionMode: boolean; actionIdentity?: string; searching: boolean;
  zone: Zone; fieldIndex: number; candidateId?: string; selectedId?: string; candidateIndex: number;
  selectedIndex: number; advanced: boolean; origin: Origin; originOffset: number };
const digits = ['1','2','3','4','5','6','7','8','9','0'] as const;
const apis: Record<string,string> = { 'openai-responses':'OpenAI · Responses', 'openai-completions':'OpenAI · Chat Completions',
  'anthropic-messages':'Anthropic · Messages', 'google-generative-ai':'Google · Gemini' };
const sourceNames: Record<string,string> = { tested:'有效实测', manual:'人工配置', provider:'渠道参考', generic:'通用模板', default:'待确认' };
const fields: Record<string,string> = { name:'显示名称', contextWindow:'上下文窗口', maxTokens:'最大输出', reasoning:'思考能力', input:'输入类型', thinkingLevelMap:'推理映射' };
const fmt = (n: number | undefined) => n === undefined ? '未知' : n >= 1e6 ? `${n/1e6}M` : n >= 1e3 ? `${n/1e3}K` : String(n);
const date = (value: number): string => { const d=new Date(value);return Number.isFinite(d.getTime())?d.toISOString():'时间未知'; };
const same = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) => !!a && !!b && a.provider === b.provider && a.id === b.id;
const refLabel = (ref: ModelRef | null) => ref ? `${ref.provider}/${ref.id}` : '未选择';
const blankFrame = (): Frame => ({ offset:0, actionMode:false, searching:false, zone:'query', fieldIndex:0,
  candidateIndex:0, selectedIndex:0, advanced:false, origin:'content', originOffset:0 });
const reviewIds = new Set<PickerActionId>(['connect','run','reuse','commit','commit-limits','replacement','confirm-remove','apply-inspect','confirm-restore','confirm-recover','sync-reference']);

/** V10 view/navigation only. Real effects and all form codecs belong to the workspace. */
export class PickerComponent implements Focusable {
  private state!: PickerSnapshot;
  private view!: View;
  private viewId = '';
  private token: string | null = null;
  private unsubscribe: () => void;
  private disposed = false;
  private hasFocus = false;
  private frame = blankFrame();
  private frames = new Map<string,Frame>();
  private help = false;
  private helpFrame: Frame | null = null;
  private port?: PrivateFormPort;
  private form: Field[] = [];
  private actions: PickerAction[] = [];
  private matrixQuery = new Input({prompt:'› ',placeholder:'输入模型名或供应商名过滤…'});
  private basketQuery = new Input({prompt:'',placeholder:'筛选候选ID'});
  private leftArmed = false;
  private offsetReveal = true;
  private actionRects: Rect[] = [];
  private actionSlots: Slot[] = [];
  private matrixCells: Cell[] = [];
  private hits: Array<Hit & {y:number}> = [];
  private page = 1;
  private total = 0;
  private ready = false;
  private size = '';
  private renderedWidth = 0;
  private layoutId = 0;
  private renderEpoch = 0;
  private renderedViewId = '';
  private renderedToken: string | null = null;
  private required = new Set<number>();
  private seen = new Set<number>();
  private message = '';
  private pasting: Input | null = null;
  private pasteActive = false;
  private pasteTail = '';
  private pasteChanged?: () => void;
  constructor(private readonly workspace: PickerWorkspace, private readonly tui: Pick<TUI,'terminal'|'requestRender'>,
    private readonly theme: Theme, private readonly done: () => void) {
    this.sync();
    this.unsubscribe = workspace.subscribe(() => { if (!this.disposed) { this.sync(); this.redraw(); } });
  }
  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    if (!value) { this.leftArmed = false; this.finishPaste(); this.resetReview(); }
    this.syncFocus();
  }
  private redraw() { if (!this.disposed) this.tui.requestRender(); }
  private resetReview() { this.ready = false; this.seen.clear(); this.required.clear(); this.layoutId++; }
  invalidate(): void { this.resetReview(); this.offsetReveal = true; this.redraw(); }
  private dimensions() { return `${this.tui.terminal.columns}/${this.tui.terminal.rows}`; }
  private paint(tone: Tone, text: string, selected=false, bold=false) {
    return this.theme.style(text, {fg:parseColor(this.state.matrix.palette.colors[tone]),
      ...(bold?{bold:true}:{}),
      ...(selected&&this.frame.actionMode?{bg:parseColor(this.theme.appearance==='light'?'#e4e4e4':'#3a3a3a')}:{})});
  }
  private rootModel() {
    const sel = this.state.matrix.selected;
    return sel.kind === 'model' ? this.state.matrix.providers.find(p=>p.id===sel.ref.provider)?.models.find(m=>same(m.ref,sel.ref)) : undefined;
  }
  private rootProvider() {
    const sel = this.state.matrix.selected, id = sel.kind === 'model' ? sel.ref.provider : sel.kind === 'provider' ? sel.provider : '';
    return this.state.matrix.providers.find(p=>p.id===id);
  }
  private candidates() { const v=this.view; return v.kind==='basket' ? v.candidates.filter(m=>`${m.name} ${m.id}`.toLowerCase().includes(v.query.trim().toLowerCase())) : []; }
  private selectedModels() { return this.view.kind==='basket' ? this.view.selected : []; }
  private selectedIds(): string[] {
    return this.view.kind==='basket'?this.view.selected.map(m=>m.id):this.view.kind==='report'?this.view.models.map(m=>refLabel(m.ref)):
      this.view.kind==='confirm'?this.view.replacements.map(m=>refLabel(m.ref)):[];
  }
  private rememberIds() {
    this.frame.candidateId=this.candidates()[this.frame.candidateIndex]?.id;
    this.frame.selectedId=this.selectedIds()[this.frame.selectedIndex];
  }
  private sync() {
    const next=this.workspace.snapshot(), view=next.task??next.matrix, changedView=this.viewId!==view.viewId;
    if (this.viewId!==view.viewId) {
      if (this.viewId) {
        this.rememberIds(); this.frames.set(this.viewId,{...this.frame});
        for (const f of this.form) if (f.kind==='input') f.input.focused=false;
      }
      this.finishPaste(); this.help=false; this.helpFrame=null;
      this.frame={...(this.frames.get(view.viewId)??blankFrame())};
      this.viewId=view.viewId; this.message=''; this.leftArmed=false; this.offsetReveal=!this.frames.has(view.viewId);
      this.resetReview();
    }
    if (this.token!==view.reviewToken) { this.token=view.reviewToken; this.resetReview(); }
    this.state=next; this.view=view;
    this.port=this.workspace.formFields(view.viewId);
    this.rebuildFields();
    if (this.matrixQuery.getValue()!==next.matrix.query) this.matrixQuery.setValue(next.matrix.query);
    if (view.kind==='basket' && this.basketQuery.getValue()!==view.query) this.basketQuery.setValue(view.query);
    this.actions=this.getActions();
    if (!this.actions.some(a=>a.identity===this.frame.actionIdentity)) this.frame.actionIdentity=(this.actions.find(a=>a.primary&&!a.disabled)??this.actions[0])?.identity;
    if (view.kind==='basket') {
      const candidates=this.candidates(), selected=this.selectedModels();
      const ci=candidates.findIndex(m=>m.id===this.frame.candidateId), si=selected.findIndex(m=>m.id===this.frame.selectedId);
      this.frame.candidateIndex=Math.max(0,Math.min(ci>=0?ci:this.frame.candidateIndex,candidates.length-1));
      this.frame.selectedIndex=Math.max(0,Math.min(si>=0?si:this.frame.selectedIndex,selected.length-1));
      if ((this.frame.zone==='candidates'&&!candidates.length)||(this.frame.zone==='selected'&&!selected.length)) this.frame.zone='query';
      if (changedView&&view.focusAction) { this.frame.actionMode=true; this.frame.actionIdentity=view.focusAction; this.offsetReveal=true; }
      if (!view.candidates.length&&this.frame.zone==='query') {
        if (selected.length) this.frame.zone='selected';
        else { this.frame.actionMode=true; if (!this.actions.some(a=>a.identity===this.frame.actionIdentity&&!a.disabled)) this.frame.actionIdentity=this.actions.find(a=>a.primary&&!a.disabled)?.identity; }
      }
    }
    if(view.kind==='report'||view.kind==='confirm') {
      const ids=this.selectedIds(),index=ids.indexOf(this.frame.selectedId??'');
      this.frame.selectedIndex=Math.max(0,Math.min(index>=0?index:this.frame.selectedIndex,ids.length-1));
    }
    this.syncFocus();
  }
  private rebuildFields() {
    const all=this.port?.fields()??[], basic=all.filter(f=>!f.advanced);
    this.form=all.some(f=>f.advanced) ? [...basic,{kind:'advanced',id:'advanced',label:'推理映射',readonly:false},...(this.frame.advanced?all.filter(f=>f.advanced):[])] : [...all];
    this.frame.fieldIndex=Math.max(0,Math.min(this.frame.fieldIndex,this.form.length-1));
  }
  private currentInput(): Input | undefined {
    if (this.help||this.frame.actionMode) return;
    if (this.view.kind==='matrix') return this.matrixQuery;
    if (this.view.kind==='basket') return this.view.candidates.length&&this.frame.zone==='query'?this.basketQuery:undefined;
    const f=this.form[this.frame.fieldIndex];
    return f?.kind==='input'&&!f.readonly&&!(this.view.kind==='edit'&&this.view.readonly)?f.input:undefined;
  }
  private syncFocus() {
    this.matrixQuery.focused=false; this.basketQuery.focused=false;
    for (const f of this.port?.fields()??[]) if(f.kind==='input') f.input.focused=false;
    const current=this.currentInput(); if(current) current.focused=this.hasFocus;
  }
  private getActions(): PickerAction[] {
    if(this.help) return [{id:'close-help',identity:'local:close-help',label:'关闭帮助',disabled:false,digit:'0',primary:true}];
    const v=this.view, s=this.state.matrix;
    return [...v.actions].filter(a=> {
      if(v.kind!=='matrix') return true;
      if(a.id==='fast') return s.selected.kind==='model'&&same(s.selected.ref,s.current)&&same(s.fast.current,s.current)&&s.fast.supported;
      return true;
    });
  }
  private digit(a: PickerAction): string | undefined {
    if(this.help) return a.id==='close-help'?'0':undefined;
    const root: Partial<Record<PickerActionId,string>>={favorite:'1','edit-model':'2','edit-provider':'2',inspect:'3',default:'4','move-left':'5','provider-up':'5','move-right':'6','provider-down':'6','add-model':'7','remove-model':'8','remove-provider':'8','new-provider':'9',archives:'0'};
    if(this.view.kind==='matrix') {
      const provider=this.state.matrix.selected.kind==='provider';
      if((provider&&['favorite','edit-model','inspect','default','move-left','move-right','remove-model'].includes(a.id))||(!provider&&['edit-provider','provider-up','provider-down','remove-provider'].includes(a.id))) return;
      return root[a.id];
    }
    const maps: Record<string,Partial<Record<PickerActionId,string>>>={
      connection:{connect:'1','manual-connection':'2','cancel-task':'0',back:'0'},edit:{'save-form':'1','reset-limits':'2','add-ids':'1',back:'0'},
      basket:{'next-models':'1','read-list':'2','manual-id':'3','stop-read':'4',back:'0'},
      preflight:{run:'1',skip:'2',image:'3',reuse:'4',back:'0'},progress:{'cancel-checks':'1','stop-read':'1','cancel-task':'0'},
      report:{commit:'1','finish-inspect':'1',adjust:'2',recheck:'3',details:'4','apply-inspect':'5',back:'0'},
      confirm:{replacement:'1','confirm-remove':'1','confirm-restore':'1','confirm-recover':'1',commit:'1','commit-limits':'1','apply-inspect':'1','cancel-confirm':'0',back:'0'},
      archives:{back:'0'},fast:{'fast-off':'1','fast-priority':'2','fast-ultrafast':'3','fast-observations':'4',back:'0'},
      recovery:{'confirm-recover':'1',recover:'1',back:'0'},info:{connect:'1','read-list':'1',commit:'1','sync-reference':'1',back:'0','close-info':'0','close-help':'0'},
    };
    return maps[this.view.kind]?.[a.id]??a.digit;
  }
  private actionLabel(a: PickerAction): string {
    const v=this.view, m=this.rootModel();
    if(v.kind==='matrix') {
      const labels: Partial<Record<PickerActionId,string>>={switch:same(m?.ref,this.state.matrix.current)?'使用中':'切换',favorite:m?.favorite?'取消收藏':'收藏',
        'edit-model':m?.readonly&&!m.limitsEditable?'查看参数':'编辑',inspect:'检查',default:same(m?.ref,this.state.matrix.default)?'默认':'设为默认',
        'move-left':'前移','move-right':'后移','add-model':'添加模型','remove-model':'移除','new-provider':'添加供应商',archives:'已移除',undo:'撤销',locate:'定位',
        'edit-provider':'编辑连接','provider-up':'上移','provider-down':'下移','remove-provider':'移除供应商',fast:this.state.matrix.fast.active?'关闭会话 Fast':'开启会话 Fast'};
      return labels[a.id]??safe(a.label);
    }
    if(v.kind==='edit'&&v.purpose==='model-limits'&&a.id==='save-form')return '查看差异';
    if(a.id==='reset-limits')return '重置为继承';
    if(v.kind==='confirm'&&(a.id==='commit'||a.id==='commit-limits'))return safe(a.label);
    const labels: Partial<Record<PickerActionId,string>>={connect:'读取模型','manual-connection':'手输 ID','save-form':'保存',back:'返回','cancel-task':'取消',
      'next-models':`继续（${v.kind==='basket'?v.selected.length:0}）`,'read-list':v.kind==='basket'&&v.listStatus==='loaded'?'刷新模型清单':'读取模型清单','manual-id':'手动输入ID','add-ids':'加入已选','stop-read':'停止读取',
      run:'开始检查',skip:'跳过',image:`${v.kind==='preflight'&&v.plan.includeImage?'✓':'□'} 图片样例`,reuse:'复用报告','cancel-checks':'停止检查',
      commit:v.kind==='report'?`核对添加（${v.models.length}）`:'确认添加','finish-inspect':'完成',adjust:'调整参数',recheck:'重新检查',details:this.frame.advanced?'收起参数':'参数详情',
      'fast-off':'关闭','fast-priority':'Fast（priority）','fast-ultrafast':'Ultrafast','fast-observations':'发送与回显',recover:'确认完成','apply-inspect':'应用修改',replacement:'下一步','confirm-remove':'确认移除','cancel-confirm':'取消','confirm-restore':'确认恢复','confirm-recover':'确认完成','close-help':'关闭帮助'};
    return labels[a.id]??safe(a.label);
  }
  private isReview(a: PickerAction): boolean {
    return !!a.requiresReview||reviewIds.has(a.id)||(this.view.kind==='info'&&this.view.purpose==='discovery-consent'&&a.id==='read-list');
  }
  private disabled(a: PickerAction): boolean {
    if(a.disabled) return true;
    const v=this.view,s=this.state.matrix;
    if(v.kind==='edit'&&v.readonly&&a.id==='save-form') return true;
    if(v.kind==='preflight'&&((a.id==='run'&&!v.plan.capability.available)||(a.id==='reuse'&&!v.plan.reuse.available))) return true;
    if(v.kind==='fast'&&((a.id==='fast-ultrafast'&&!v.session.ultrafastEnabled)||(['fast-priority','fast-ultrafast'].includes(a.id)&&!v.session.supported))) return true;
    if(v.kind==='recovery'&&['recover','confirm-recover'].includes(a.id)&&!v.canRecover.available) return true;
    if(v.kind==='matrix') {
      if((['edit-provider','remove-provider','add-model'].includes(a.id)&&this.rootProvider()?.readonly)||(a.id==='remove-model'&&this.rootModel()?.readonly))return true;
      if(['switch','favorite','edit-model','inspect','default','move-left','move-right','remove-model'].includes(a.id)) {
        const m=this.rootModel(); if(!m||!s.visible.some(p=>p.provider===m.ref.provider&&p.modelIds.includes(m.ref.id))) return true;
        if((a.id==='switch'||a.id==='default')&&m.availability!=='ready') return true;
      }
      if(['move-left','move-right','provider-up','provider-down'].includes(a.id)&&s.query.trim()) return true;
    }
    return false;
  }
  private command(command: PickerCommand) {
    if(this.disposed) return;
    this.leftArmed=false; this.message='';
    try {
      const result=this.workspace.dispatch(command);
      if(result) void result.catch(()=>{if(!this.disposed){this.message='操作未完成，请核对当前状态';this.sync();this.redraw();}});
    } catch { this.message='操作未完成，请核对当前状态'; }
    this.ready=false;
    this.sync(); this.redraw();
  }
  private activation(a: PickerAction, review?: ReviewProof): PickerActivation | undefined {
    const base={type:'activate' as const,viewId:this.viewId,id:a.id,identity:a.identity,...(review?{review}:{})};
    const sel=this.state.matrix.selected,p=this.rootProvider();
    let payload: PickerActionPayloads[keyof PickerActionPayloads] | undefined;
    switch(a.id) {
      case 'switch':case 'favorite':case 'edit-model':case 'inspect':case 'default':case 'move-left':case 'move-right':case 'remove-model':
        if(sel.kind!=='model') return; payload=sel.ref; break;
      case 'add-model':case 'edit-provider':case 'provider-up':case 'provider-down':case 'remove-provider':
        if(!p) return; payload={provider:p.id}; break;
      case 'adjust': {
        const id=this.view.kind==='report'?this.view.models[this.frame.selectedIndex]?.ref.id:this.selectedModels()[this.frame.selectedIndex]?.id;
        if(!id) return; payload={modelId:id}; break;
      }
      case 'replacement': {
        const ref=this.view.kind==='confirm'?this.view.replacements[this.frame.selectedIndex]?.ref:undefined;
        if(!ref) return; payload=ref; break;
      }
      case 'restore': {
        const entry=this.view.kind==='archives'?this.view.entries.find(e=>a.identity===`restore:${e.id}`):undefined;
        if(!entry||!entry.restore.available) return; payload={archiveId:entry.id}; break;
      }
      case 'image': if(this.view.kind!=='preflight') return; payload={include:!this.view.plan.includeImage}; break;
      case 'run':case 'reuse': if(this.view.kind!=='preflight') return; payload={planId:this.view.plan.id}; break;
    }
    // One closed mapping from action ID to its typed payload; never a form-value bag.
    return {...base,...(payload?{payload}:{})} as PickerActivation;
  }
  private activate(a: PickerAction | undefined, mouse=false) {
    if(!a) return;
    this.sync();
    const matrixAlias=this.view.kind==='matrix'&&['provider-up','provider-down'].includes(a.id);
    const live=(a.id==='cycle-palette'||matrixAlias?this.state.matrix.actions:this.actions).find(item=>item.identity===a.identity&&item.id===a.id);
    if(!live)return;
    if(this.disabled(live)){if(live.disabledReason){this.message=live.disabledReason;this.redraw();}return;}
    const cancellation=['cancel-task','cancel-checks','stop-read','cancel-confirm','back','close-info'].includes(live.id);
    if(!cancellation&&(!this.ready||this.size!==this.dimensions()||this.renderedViewId!==this.viewId||this.renderedToken!==this.token)) {
      this.message='画面已更新，请再确认';this.redraw();return;
    }
    let proof: ReviewProof | undefined;
    if(this.isReview(live)) {
      if(!this.token||[...this.required].some(i=>!this.seen.has(i))) {this.message='还有未读内容 · PgDn';this.redraw();return;}
      proof={reviewToken:this.token,layoutId:String(this.layoutId),renderEpoch:this.renderEpoch,
        width:this.tui.terminal.columns,height:this.tui.terminal.rows,complete:true};
    }
    this.leftArmed=false;
    if(this.help||live.id==='close-help') {this.setHelp(false);return;}
    if(live.id==='help') {this.setHelp(true);return;}
    if(live.id==='details') {this.frame.advanced=!this.frame.advanced;this.rebuildFields();this.resetReview();this.redraw();return;}
    if(mouse&&this.view.kind==='matrix') this.enterActions(live.identity);
    if(this.frame.actionMode&&this.visibleActions().some(a=>a.identity===live.identity)) this.frame.actionIdentity=live.identity;
    const cmd=this.activation(live,proof); if(!cmd) return;
    this.ready=false; this.command(a.id==='cycle-palette'?{...cmd,viewId:this.state.matrix.viewId}:cmd);
  }
  private setHelp(value: boolean) {
    if(value===this.help) return;
    if(value) {this.helpFrame={...this.frame};this.frame=blankFrame();}
    else if(this.helpFrame) {this.frame=this.helpFrame;this.helpFrame=null;}
    this.help=value;this.actions=this.getActions();this.frame.actionIdentity=value?'local:close-help':this.frame.actionIdentity;
    this.resetReview();this.syncFocus();this.redraw();
  }
  private wrap(rows: Row[], value: string, width: number, tone: Tone='text', review=false) {
    for(const line of wrapTextWithAnsi(this.paint(tone,safe(value)),Math.max(1,width))) rows.push({text:line,review});
  }
  private formRows(rows: Row[], width: number) {
    const labels=this.form.map(f=>visibleWidth(f.label)+4),inline=width>=64,labelWidth=inline?Math.min(26,Math.max(0,...labels)):0;
    for(const [index,f] of this.form.entries()) {
      const active=!this.frame.actionMode&&this.frame.fieldIndex===index, label=`${active?'› ':'  '}${safe(f.label)}`;
      const cropped=truncateToWidth(label,labelWidth,'…');
      const prefix=inline?this.paint(active?'accent':'dim',cropped)+' '.repeat(Math.max(0,labelWidth-visibleWidth(cropped)))+'  ':'   ';
      const x=inline?labelWidth+2:3;
      if(!inline) this.wrap(rows,label,width,active?'accent':'dim');
      const value=f.kind==='input'?f.input.render(Math.max(1,width-x))[0]??'':f.kind==='choice'?apis[f.choices[f.choice()]!]??f.choices[f.choice()]??'':this.frame.advanced?'▾ 收起':'▸ 展开';
      rows.push({text:prefix+(f.kind==='input'?value:this.paint(active?'blue':'text',safe(value))),focus:active,hits:[{x:0,w:width,run:event=>{
        this.frame.fieldIndex=index;this.frame.actionMode=false;
        if(f.kind==='advanced') this.toggleAdvanced();
        else if(event&&f.kind==='input'&&!f.readonly) f.input.handleMouse({...event,x:Math.max(0,event.x-1-x),y:0});
        this.offsetReveal=true;this.syncFocus();this.redraw();
      }}]});
      if(f.kind==='advanced'&&this.frame.advanced) this.wrap(rows,'   空 = Pi 默认 · - = 不支持 · = 前缀保留字面值',width,'dim');
      if('hint' in f&&f.hint&&active) this.wrap(rows,f.hint,width,'dim');
    }
  }
  private list(rows: Row[], items: {value:string;label:string;description?:string}[], selected: number, width: number, max: number, active: boolean, pick: (id:string)=>void) {
    if(!items.length) {this.wrap(rows,'  暂无选项',width,'dim');return;}
    const index=Math.max(0,Math.min(selected,items.length-1));
    const list=new SelectList(items,max,{selectedPrefix:s=>this.paint(active?'accent':'dim',s),selectedText:s=>this.paint(active?'blue':'text',s),description:s=>this.paint('dim',s),scrollInfo:s=>this.paint('dim',s),noMatch:s=>this.paint('dim',s)});
    list.setSelectedIndex(index);
    const start=Math.max(0,Math.min(index-Math.floor(max/2),items.length-max)),count=Math.min(max,items.length-start);
    list.render(width).forEach((text,i)=>rows.push({text:active?text:text.replace('→ ','  '),focus:active&&start+i===index,
      hits:i<count?[{x:0,w:width,run:()=>pick(items[start+i]!.value)}]:[]}));
  }
  private specs(rows: Row[], p: ModelParameters, width: number, review=false) {
    this.wrap(rows,`上下文窗口 ${fmt(p.contextWindow)} · 最大输出 ${fmt(p.maxTokens)} · ${p.reasoning?'推理':'无推理'} · ${p.input.includes('image')?'图片输入':'文本输入'}`,width,'text',review);
    if(this.frame.advanced) this.wrap(rows,'强度映射 '+(p.thinkingLevelMap===undefined?'Pi 默认':Object.keys(p.thinkingLevelMap).length?Object.entries(p.thinkingLevelMap).map(([k,v])=>`${k}=${v===null?'不支持':v===''?'（空值）':v}`).join(' · '):'Pi 默认（显式空映射）'),width,'dim');
  }
  private evidence(rows: Row[], data: readonly FieldEvidence[], width: number) {
    for(const item of data) {
      const time=item.when!==undefined&&Number.isFinite(item.when)?date(item.when):'';
      this.wrap(rows,`${fields[item.field]} ← ${sourceNames[item.provenance.source]??item.provenance.source}${time?' · '+time:''}`,width,'dim');
      for(const h of item.provenance.history) this.wrap(rows,`  ${sourceNames[h.source]??h.source} · ${h.reason}`,width,'dim');
      if(item.testId)this.wrap(rows,'  记录 '+item.testId,width,'dim');
      if(item.previous)this.wrap(rows,'  前值 '+this.fieldValue(item.previous),width,'dim');
      for(const c of item.conditions??[]) this.wrap(rows,'  '+c,width,'dim');
    }
  }
  private fieldValue(v: ModelDiff['fields'][number]['before']): string {
    return !v.present?'未配置':typeof v.value==='object'?Array.isArray(v.value)?v.value.join('/'):
      Object.entries(v.value).map(([k,x])=>`${k}=${x===null?'不支持':x===''?'（空值）':x}`).join(' · ')||'显式空映射':String(v.value);
  }
  private differences(rows: Row[], diffs: readonly ModelDiff[], width: number) {
    for(const diff of diffs) for(const f of diff.fields) this.wrap(rows,`${refLabel(diff.ref)} · ${fields[f.field]}：${this.fieldValue(f.before)} → ${this.fieldValue(f.after)}`,width,'warning',true);
  }
  private matrixRows(rows: Row[], width: number) {
    const s=this.state.matrix, selected=s.selected;
    const pid=selected.kind==='model'?selected.ref.provider:selected.kind==='provider'?selected.provider:'';
    const headW=Math.min(20,Math.max(10,...s.providers.map(p=>visibleWidth(safe(p.name))+1)))+2;
    const providerWidth=Math.min(headW,Math.max(8,Math.floor(width*.24)));
    const counterWidth=Math.min(4,Math.max(2,1+String(Math.max(0,...s.providers.map(p=>p.models.length))).length));
    const {modelX,available,cellW}=homeColumns(width,providerWidth,counterWidth);
    const providers=new Map(s.providers.map(p=>[p.id,p]));
    for(let index=this.frame.offset;index<Math.min(s.visible.length,this.frame.offset+this.page);index++) {
      const visible=s.visible[index]!,p=providers.get(visible.provider);if(!p)continue;
      const byId=new Map(p.models.map(m=>[m.ref.id,m]));
      const models=visible.modelIds.flatMap(id=>{const m=byId.get(id);return m?[m]:[];});
      const active=pid===p.id,ps=active&&selected.kind==='provider';
      const c=selected.kind==='model'&&active?models.findIndex(m=>same(m.ref,selected.ref)):-1;
      const {start,count,remaining}=homeWindow(models.length,c,available,cellW);
      const lead=middle(ps?`[${safe(p.name)}]`:safe(p.name),Math.max(1,modelX-3));
      let text=this.paint(active?'accent':'dim',active&&!this.frame.actionMode?'▸ ':'  ')+this.paint(ps?'selection':active?'accent':'dim',lead,ps)
        +' '.repeat(Math.max(0,modelX-1-2-visibleWidth(lead)))+this.paint('dim',start>0?'‹':' ');
      const hits:Hit[]=[{x:0,w:modelX-1,run:()=>this.select({kind:'provider',provider:p.id})}];
      for(let column=0;column<count;column++) {
        const m=models[start+column]!,isSelected=selected.kind==='model'&&same(selected.ref,m.ref),isCurrent=same(s.current,m.ref);
        const name=middle(safe(m.name),cellW-3),label=`${isSelected&&!this.frame.actionMode?'›':isCurrent?'●':' '} ${name}${m.favorite?'★':''}`;
        const tone:Tone=isCurrent?'current':m.favorite?'favorite':isSelected?'selection':same(s.default,m.ref)?'default':'text';
        const x=modelX+column*cellW;
        text+=this.paint(tone,label+' '.repeat(Math.max(0,cellW-visibleWidth(label))),isSelected,isCurrent);
        this.matrixCells.push({pid:p.id,mid:m.ref.id,x,y:index+2,width:cellW,height:1});
        hits.push({x,w:cellW,run:()=>this.select({kind:'model',ref:m.ref})});
      }
      if(!models.length)text+=this.paint(active?'accent':'dim','[添加模型] · 尚无模型');
      else if(remaining)text+=this.paint('dim',`+${remaining}`);
      rows.push({text,hits});
    }
  }
  /** HOME alone has a provider viewport; the original fixed rails never scroll. */
  private renderHome(w: number): string[] {
    const s=this.state.matrix,inner=Math.max(1,w-2),height=Math.max(1,Math.floor(this.tui.terminal.rows));
    const line=(text:string)=>' '+truncateToWidth(text,inner,'');
    const fallback=()=>{
      this.ready=false;this.hits=[];this.actionRects=[];this.actionSlots=[];this.matrixCells=[];
      return [DISPLAY_NAME,'窗口太小，请放大；Esc 返回。'].slice(0,height).map(t=>truncateToWidth(t,Math.max(0,w-1),''));
    };
    if(w<28)return fallback();
    const rule=homeRule(inner,s.palette.gradient,s.palette.stepped,(color,text)=>this.theme.style(text,{fg:parseColor(color)}));
    const all=s.providers.reduce((n,p)=>n+p.models.length,0),hits=s.visible.reduce((n,p)=>n+p.modelIds.length,0);
    const title=this.paint('accent',BRAND)+this.paint('dim',` · ${ROLE} (${s.query.trim()?`${hits}/${all}`:all})${s.default?'  ·  默认 '+safe(s.default.id):''}`);
    const p=this.rootProvider(),m=this.rootModel();
    const scope=this.frame.actionMode?`操作 ${s.selected.kind==='model'?'模型 '+refLabel(m?.ref??null):'供应商 '+(p?.id??'未选择')} · `:'';
    const detail=scope+(s.selected.kind==='model'&&m?
      `${same(s.current,m.ref)?'● ':''}${safe(m.name)}${m.favorite?' ★':''}${same(s.default,m.ref)?' ◆默认':''} · ${homeContext(m.parameters.contextWindow)}${m.parameters.reasoning?' think':''}${m.parameters.input.includes('image')?' vision':''}${m.availability==='unavailable'?' · 未就绪':''}`:
      `供应商「${safe(p?.name??(s.providers.length?'无匹配':'尚未添加'))}」${p&&p.name!==p.id?' · '+safe(p.id):''} · ${p?.models.length??0} 个模型${p?.readonly?' · Pi 管理／只读':''}`);
    const bottom:Row[]=[{text:rule},{text:this.paint('text',truncateToWidth(detail,inner,'…'))}];
    this.stripActions(bottom,inner);
    const feedback=this.message||this.view.error||this.view.message||(!s.configReadable?'自定义配置无法读取；未清理收藏／排序':'')||(this.leftArmed?'再按一次 ← 操作此供应商；其他操作取消准备':'');
    const hints=`Tab 换区域 · Alt 数字 动作 · Enter 执行 · Esc ${this.frame.actionMode?'返回':'退出'} · F1 帮助`;
    const footer=wrapTextWithAnsi(this.paint('dim',hints),inner);
    // Feedback borrows existing footer space, never viewport/action height.
    // Persistent host messages must not erase all keyboard discoverability.
    if(feedback) {
      const tone=this.message||this.view.error||!s.configReadable?'warning':'blue';
      const combined=wrapTextWithAnsi(this.paint(tone,hints+' · '+safe(feedback)),inner);
      if(combined.length<=footer.length)footer.splice(0,combined.length,...combined);
      else {
        const compact=inner>=40?'Tab · Alt 数字 · Esc · F1 帮助 · ':'Tab/Alt数字/Esc/F1 · ';
        footer[0]=this.paint(tone,compact+truncateToWidth(safe(feedback),Math.max(0,inner-visibleWidth(compact)),'…'));
      }
    }
    // Measure every fixed row FIRST. Never borrow TASK's .55-height/slice policy.
    const available=height-4-bottom.length-footer.length;
    if(available<1)return fallback();
    this.total=s.visible.length;this.page=Math.max(1,Math.min(18,available));
    this.frame.offset=Math.max(0,Math.min(this.frame.offset,Math.max(0,this.total-this.page)));
    const pid=s.selected.kind==='model'?s.selected.ref.provider:s.selected.kind==='provider'?s.selected.provider:'';
    const selectedRow=s.visible.findIndex(p=>p.provider===pid);
    if(this.offsetReveal&&selectedRow>=0) {
      if(selectedRow<this.frame.offset)this.frame.offset=selectedRow;
      else if(selectedRow>=this.frame.offset+this.page)this.frame.offset=selectedRow-this.page+1;
    }
    this.offsetReveal=false;
    const rows:Row[]=[{text:(this.matrixQuery.render(inner)[0]??''),hits:[{x:0,w:inner,run:event=>{
      this.frame.actionMode=false;this.frame.searching=true;this.frame.origin='matrix';this.syncFocus();
      if(event)this.matrixQuery.handleMouse({...event,x:Math.max(0,event.x-1),y:0});this.redraw();
    }}]},{text:rule}];
    this.matrixRows(rows,inner);
    if(!s.visible.length)rows.push({text:this.paint('dim',s.providers.length?`没有匹配「${safe(s.query)}」的模型 · Ctrl+U 清空搜索`:'还没有供应商 · Alt+9 添加供应商及模型')});
    const viewportRows=Math.max(1,Math.min(s.providers.length,this.page));
    while(rows.length<2+viewportRows)rows.push({text:''});
    // Preserve point(): body starts after the first title rule; fixed rail's
    // logical y includes providerTop, while its actual hits use physical rows.
    const bottomY=this.frame.offset+rows.length;
    for(const rect of this.actionRects)rect.y+=bottomY;
    for(const slot of this.actionSlots)slot.y+=bottomY;
    rows.push(...bottom);
    rows.forEach((row,i)=>{for(const hit of row.hits??[])this.hits.push({...hit,x:hit.x+1,y:2+i});});
    this.required.clear();this.seen.clear();this.ready=true;this.renderedViewId=this.viewId;this.renderedToken=this.token;this.renderEpoch++;
    return [line(title),line(rule),...rows.map(row=>line(row.text)),...footer.map(line)].map(text=>truncateToWidth(text,Math.max(0,w-1),''));
  }
  private body(width: number, height: number): Row[] {
    const rows:Row[]=[],v=this.view;
    if(this.help) {
      this.wrap(rows,'快捷键与图例',width,'accent');
      for(const text of ['仅首页：Tab / Shift+Tab 切换对象与动作；方向键移动','Alt+数字 执行标号动作；普通数字仍可输入','Enter 切换 · Alt+1 收藏 · 2 编辑 · 3 检查 · 4 默认','Alt+5/6 调序 · 7 添加模型 · 8 移除 · 9 新供应商 · 0 已移除','Alt+E/V/D/N/X、Alt+方向键、Alt+Z/L 保留兼容','Alt+T 切换配色；Fast 仅作用于明确标出的当前会话模型','首格连续两次 ← 进入供应商列；→ 回模型区','选模型：↓ 入列表；←→ 换列；末项 ↓ 进入动作','字段 ↑↓；输入框 ←→ 编辑；任务 Tab 逐控件','Ctrl+S 当前明确动作；Esc 返回；Ctrl+C 结束任务','PgUp/PgDn 翻内容；报告也可 ←→ 翻页','Alt+M / F6 动作；F1 / Alt+H 帮助']) this.wrap(rows,text,width,'dim');
      return rows;
    }
    if(v.kind==='matrix') {this.matrixRows(rows,width);return rows;}
    this.wrap(rows,v.title,width,'accent');
    if(v.content?.stage)this.wrap(rows,v.content.stage,width,'dim');
    if(v.content?.title&&v.content.title!==v.title)this.wrap(rows,v.content.title,width,'text',this.actions.some(a=>this.isReview(a)));
    if(this.form.length) this.formRows(rows,width);
    if(v.kind==='connection'&&!v.content) {
      this.wrap(rows,`目标 ${v.target.endpoint||'尚未填写地址'} · ${apis[v.target.api]??v.target.api}`,width,'dim',true);
      this.wrap(rows,'读取本连接的上游模型清单；不运行模型、不保存配置或凭据。',width,'text',true);
    } else if(v.kind==='basket') {
      const candidates=this.candidates(),raw=v.candidates.length;
      if(raw) {
        this.wrap(rows,`筛选候选ID · ${candidates.length}/${raw}`,width,'accent');
        rows.push({text:this.paint('blue','› ')+this.basketQuery.render(Math.max(1,width-2))[0],focus:this.frame.zone==='query'&&!this.frame.actionMode,
          hits:[{x:0,w:width,run:()=>{this.frame.zone='query';this.frame.actionMode=false;this.syncFocus();this.redraw();}}]});
      }
      const wide=width>=70,col=wide?Math.floor((width-3)/2):width,max=Math.max(2,Math.min(6,wide?height-10:Math.floor((height-10)/2))),left:Row[]=[],right:Row[]=[];
      this.wrap(left,raw?`候选ID ${candidates.length}/${raw}`:'候选ID',col,'accent');
      if(!raw) this.wrap(left,v.listStatus==='idle'?'尚未读取上游清单':v.listStatus==='loaded'?(v.listCounts?.total?'返回的 ID 均已配置':'上游清单为空'):'暂无候选；可重试读取或手动输入 ID',col,'dim');
      else if(!candidates.length) this.wrap(left,'没有匹配的候选ID；请修改或清空筛选，或手动输入 ID。',col,'dim');
      if(candidates.length) this.list(left,candidates.map(m=>({value:m.id,label:`${v.selected.some(s=>s.id===m.id)?'✓':'□'} ${m.name}`,description:m.id})),this.frame.candidateIndex,col,max,this.frame.zone==='candidates'&&!this.frame.actionMode,id=>{
        this.frame.zone='candidates';this.frame.actionMode=false;this.frame.candidateIndex=candidates.findIndex(m=>m.id===id);this.frame.candidateId=id;this.toggle(id);
      });
      this.wrap(right,`已选 ${v.selected.length} 个`,wide?width-col-3:width,'accent');
      this.list(right,v.selected.map(m=>({value:m.id,label:`✓ ${m.name}`,description:m.parameters?`${fmt(m.parameters.contextWindow)} / ${fmt(m.parameters.maxTokens)}`:m.id})),this.frame.selectedIndex,wide?width-col-3:width,max,this.frame.zone==='selected'&&!this.frame.actionMode,id=>{
        this.frame.zone='selected';this.frame.actionMode=false;this.frame.selectedIndex=v.selected.findIndex(m=>m.id===id);this.frame.selectedId=id;this.activate(this.actions.find(a=>a.id==='adjust'));
      });
      if(wide) for(let i=0;i<Math.max(left.length,right.length);i++) {const a=left[i],b=right[i];rows.push({text:(a?.text??'')+' '.repeat(Math.max(0,col-visibleWidth(a?.text??''))+3)+(b?.text??''),focus:a?.focus||b?.focus,
        hits:[...(a?.hits??[]),...(b?.hits??[]).map(hit=>({...hit,x:hit.x+col+3}))]});}
      else rows.push(...left,...right);
      this.wrap(rows,v.listStatus==='loading'?'正在读取…':v.listMessage,width,v.listStatus==='failed'?'warning':'dim');
    } else if(v.kind==='preflight'&&!(v.contentOwnsPlan&&v.content)) {
      for(const t of v.plan.targets) this.wrap(rows,`${refLabel(t.model)} · ${t.connection.endpoint} · ${apis[t.connection.api]??t.connection.api}`,width,'text',true);
      for(const item of v.plan.items) this.wrap(rows,`${refLabel(item.model)} · ${item.label}`,width,'text',true);
      this.wrap(rows,`预算 ≤${v.plan.maxRequests} 请求 · 输入 ${v.plan.maxInputTokens===null?'未确认':v.plan.maxInputTokens} token · 输出 ≤${v.plan.maxOutputTokens} token`,width,'dim',true);
      this.wrap(rows,`时限 ${v.plan.maxDurationMs/1000}s · 凭据解析 ${v.plan.authTimeoutMs/1000}s · 重试 ${v.plan.retries} 次 · 仅合成样例`,width,'dim',true);
      this.wrap(rows,v.plan.priceNote,width,'warning',true);
      if(!v.plan.capability.available) this.wrap(rows,v.plan.capability.reason??'此检查尚未实现，不会发送请求',width,'warning',true);
    } else if(v.kind==='progress') {
      if(v.progress) this.wrap(rows,`${v.progressModel?refLabel(v.progressModel)+' · ':''}${v.progress.completed} / ${v.progress.total} 项 · ${v.progress.current}`,width,'blue');
      for(const item of v.items) {
        const status={waiting:'等待中',running:'正在检查',passed:'通过',inconclusive:'未确认','not-tested':'未测试',cancelled:'已取消'}[item.status];
        this.wrap(rows,`${item.status==='passed'?'✓':item.status==='running'?'◌':'·'} ${item.label}${item.model?' · '+refLabel(item.model):''} · ${status}${item.detail?' · '+item.detail:''}`,width,item.status==='passed'?'success':item.status==='running'?'blue':item.status==='inconclusive'?'warning':'dim');
      }
      if(!v.items.length&&v.progress) {
        const checks=v.progress.checks;
        for(const [id,label,check] of [['text','文本',checks.text],['stream','流式',checks.stream],['tools','工具',checks.tools],['image','图片',checks.image],...Object.entries(checks.thinking).map(([id,check])=>[id,id,check] as const)] as const) {
          const running=v.progress.current===id;this.wrap(rows,`${label} · ${running?'正在检查':check.status==='passed'?'通过':check.status==='inconclusive'?'未确认':'未测试'}`,width,running?'blue':check.status==='passed'?'success':'dim');
        }
      }
      if(v.cancelling) this.wrap(rows,'正在停止；不会开始后续请求',width,'warning');
    } else if(v.kind==='report') {
      for(const [index,m] of v.models.entries()) {
        const header=rows.length;this.wrap(rows,`${index===this.frame.selectedIndex?'› ':''}${m.parameters.name??m.ref.id} · ${refLabel(m.ref)}`,width,'accent',true);
        rows[header]!.focus=!this.frame.actionMode&&index===this.frame.selectedIndex;
        rows[header]!.hits=[{x:0,w:width,run:()=>{this.frame.selectedIndex=index;this.rememberIds();this.frame.actionMode=false;this.offsetReveal=true;this.redraw();}}];
        this.specs(rows,m.parameters,width,true);
        const label=(c:{status:string;code?:string}|undefined)=>c?.status==='passed'?'✓ 通过':c?.status==='inconclusive'?`未决${this.frame.advanced&&c.code?'（'+c.code+'）':''}`:'未测试';
        const c=m.suite?.checks;
        this.wrap(rows,`文本 ${label(c?.text)} · 流式 ${label(c?.stream)} · 工具 ${label(c?.tools)} · 图片 ${label(c?.image)}`,width,'text',true);
        this.wrap(rows,'推理档位（仅接口接受） '+['low','medium','high','xhigh','max'].map(level=>`${level} ${label(c?.thinking[level as keyof typeof c.thinking])}`).join(' · '),width,'dim',true);
        if(m.needsReview.length) this.wrap(rows,'待确认 '+m.needsReview.map(f=>fields[f]).join(' · '),width,'warning',true);
        if(!m.applicable) this.wrap(rows,'此报告不适用于当前连接，采用前须重新核对',width,'warning',true);
        if(m.reused) this.wrap(rows,'历史报告 · 未重新探测',width,'dim',true);
        if(m.suite?.cancelled||m.suite?.timedOut) this.wrap(rows,m.suite.cancelled?'检查已停止；保留已完成项':'检查已超时；未完成项不作结论',width,'warning',true);
        if(this.frame.advanced) {this.wrap(rows,`${m.connection.endpoint} · ${m.connection.api}${m.suite?' · '+date(m.suite.startedAt):''}`,width,'dim');this.evidence(rows,m.evidence,width);if(m.reportId)this.wrap(rows,'报告 '+m.reportId,width,'dim');if(m.expiresAt!==undefined&&Number.isFinite(m.expiresAt))this.wrap(rows,'适用期限 '+date(m.expiresAt),width,'dim');}
      }
      this.differences(rows,v.diffs,width);
      if(v.models.length>1&&!v.batchChecks.available) this.wrap(rows,v.batchChecks.reason??'批量检查尚未实现；未检查项不标通过',width,'warning',true);
    } else if(v.kind==='confirm') {
      this.wrap(rows,`影响 当前会话：${v.affectsCurrent?'是':'否'} · 全局默认：${v.affectsDefault?'是':'否'}`,width,'dim',true);
      for(const model of v.affectedModels) this.wrap(rows,refLabel(model),width,'text',true);
      if(v.replacementApplied) this.wrap(rows,'替代已生效；取消只停止后续修改，不自动切回',width,'warning',true);
      if(v.replacements.length) this.list(rows,v.replacements.map(m=>({value:refLabel(m.ref),label:m.label})),this.frame.selectedIndex,width,Math.max(2,Math.min(6,height-12)),!this.frame.actionMode,id=>{
        this.frame.selectedIndex=v.replacements.findIndex(m=>refLabel(m.ref)===id);this.rememberIds();this.frame.actionMode=false;this.redraw();
      });
      this.differences(rows,v.diffs??[],width);
    } else if(v.kind==='archives') {
      for(const e of v.entries) this.wrap(rows,`${e.label} · ${e.kind==='provider'?'供应商':'模型'}${e.restore.available?' · 可恢复':' · '+(e.restore.reason??'暂不可恢复')}`,width,'text');
      if(!v.entries.length) this.wrap(rows,'还没有移除任何项目。',width,'dim');
      if(v.hasLegacy) this.wrap(rows,'旧版记录单独保留；未迁移或删除',width,'dim');
    } else if(v.kind==='fast') {
      this.wrap(rows,`当前会话模型 ${v.session.modelLabel}`,width,'text');
      this.wrap(rows,`会话选择 ${v.session.tier}${v.session.supported?'':' · 当前不适用，不注入参数'}`,width,'dim');
      for(const line of v.observations) this.wrap(rows,line,width,'dim');
      this.wrap(rows,'仅影响后续适用请求；不切换候选或默认。回显不证明实际加速或计费。',width,'dim');
    } else if(v.kind==='recovery') {
      this.wrap(rows,v.operation,width,'text',true);
      if(!v.canRecover.available) this.wrap(rows,v.canRecover.reason??'暂不可恢复',width,'warning',true);
    } else if(v.kind==='edit'&&v.parameters&&!this.form.length) this.specs(rows,v.parameters,width);
    if(v.kind==='edit'&&this.frame.advanced) this.evidence(rows,v.evidence??[],width);
    if(v.content) {
      const review=this.actions.some(a=>this.isReview(a));
      if(v.content.subtitle) this.wrap(rows,v.content.subtitle,width,'dim',review);
      for(const section of v.content.sections) {
        if(section.title) this.wrap(rows,section.title,width,'accent',review);
        for(const row of section.rows??[]) this.wrap(rows,`${row.label}  ${row.value}${row.source?' · '+row.source:''}`,width,row.tone??'text',review);
        for(const text of section.lines??[]) this.wrap(rows,text,width,section.tone??'text',review);
      }
    }
    return rows;
  }
  private stripActions(rows: Row[], width: number) {
    const v=this.view,kind=this.help?'help':v.kind==='matrix'?(!v.providers.length?'empty':v.selected.kind==='model'?'model':'provider'):v.kind==='edit'&&v.purpose==='manual-ids'?'manual':v.kind==='edit'&&v.purpose==='model-limits'?'limits':v.kind;
    const specs=actionTemplates[kind];
    const extraHidden=new Set<PickerActionId>(v.kind==='matrix'?['switch','help','close-help','cycle-palette','edit-provider','provider-up','provider-down','edit-model','favorite','inspect','default','move-left','move-right','remove-model','remove-provider']:['help','cycle-palette',...(v.kind!=='connection'&&v.kind!=='progress'?['cancel-task' as const]:[]),...(v.kind==='basket'?['adjust' as const]:[])]);
    const represented=new Set<PickerActionId>();
    const entries: {spec:ActionSlotSpec;index:number|null}[]=(specs??[]).map(spec=>{
      for(const id of spec.ids) represented.add(id);
      const index=this.actions.findIndex(a=>spec.ids.includes(a.id));return {spec,index:index<0?null:index};
    });
    const dynamic=this.actions.flatMap((a,index)=>v.kind==='matrix'||represented.has(a.id)||extraHidden.has(a.id)?[]:[{spec:commandSlot(a.identity,[a.id],[safe(this.actionLabel(a))],this.digit(a)??a.shortcut),index}]);
    const blocks=entries.length?[entries,...(dynamic.length?[dynamic]:[])]:[dynamic];
    const live=blocks.flatMap(block=>block.flatMap(e=>e.index===null?[]:[this.actions[e.index]!]));
    if(!live.some(a=>a.identity===this.frame.actionIdentity))this.frame.actionIdentity=live[0]?.identity;
    if(!live.length)return;
    for(const block of blocks) {
      const plan=(v.kind==='archives'||!specs)?compactRows(block.map(x=>x.spec.width),width):commandColumns(block.map(x=>x.spec.width),width,kind==='model');
      for(const placements of plan) {
        const y=rows.length;let rowHeight=1;
        for(const placement of placements) {
          const {spec,index}=block[placement.index]!,{x,width:budget}=placement;
          const height=Math.max(1,...spec.variants.map(label=>wrapTextWithAnsi(label,budget).length));
          const slot:Slot={key:spec.key,x,y,width:budget,height,actionIndex:index};this.actionSlots.push(slot);
          if(index!==null) {
            const a=this.actions[index]!,focus=this.frame.actionMode&&a.identity===this.frame.actionIdentity,hint=this.digit(a)??(a.id==='switch'?'Enter':a.id==='undo'?'Alt Z':a.id==='locate'?'Alt L':a.shortcut);
            const label=this.paint(this.disabled(a)?'dim':a.danger?'error':a.primary?'blue':focus?'accent':'text',`${focus?'› ':'  '}${safe(this.actionLabel(a))}${hint?' ['+safe(hint)+']':''}`),lines=wrapTextWithAnsi(label,budget);
            this.actionRects.push({index,x,y,width:Math.max(...lines.map(visibleWidth)),height:lines.length});
            while(rows.length<y+lines.length) rows.push({text:''});
            lines.forEach((text,i)=>{const row=rows[y+i]!;row.text+=' '.repeat(Math.max(0,x-visibleWidth(row.text)))+text;
              (row.hits??=[]).push({x,w:visibleWidth(text),run:()=>this.activate(a,true)});row.focus ||= focus;});
            slot.height=Math.max(height,lines.length);
          }
          rowHeight=Math.max(rowHeight,slot.height);
        }
        while(rows.length<y+rowHeight) rows.push({text:''});
      }
    }
  }
  render(width: number): string[] {
    if(this.disposed) return [];
    this.sync();const w=Math.max(1,Math.floor(width)),height=Math.max(1,Math.min(28,Math.max(18,Math.floor(this.tui.terminal.rows*.55)),this.tui.terminal.rows)),inner=Math.max(1,w-2);
    const size=this.dimensions();if(this.size!==size||this.renderedWidth!==w){this.size=size;this.renderedWidth=w;this.resetReview();this.offsetReveal=true;}
    this.hits=[];this.actionRects=[];this.actionSlots=[];this.matrixCells=[];
    if(this.view.kind==='matrix'&&!this.help)return this.renderHome(w);
    if(w<28||height<10) {this.ready=false;return [DISPLAY_NAME,'窗口太小，请放大；Esc 返回。'].slice(0,height).map(t=>truncateToWidth(t,Math.max(0,w-1),''));}
    const s=this.state.matrix,brand=this.paint('accent',DISPLAY_NAME),context=this.paint('dim',this.view.kind==='matrix'&&this.frame.actionMode?`操作 ${s.selected.kind==='provider'?'供应商 '+(this.rootProvider()?.name??'未选择'):'模型 '+refLabel(s.selected.kind==='model'?s.selected.ref:null)}`:`当前 ${refLabel(s.current)}`);
    let header=visibleWidth(brand+' · '+context)<=inner?[brand+' · '+context]:[brand,context];
    const shortTask=height<18&&this.view.kind!=='matrix';
    if(shortTask)header=[brand];
    const nav=this.help?'↓ 动作 · PgDn 翻页':this.view.kind==='matrix'?'Tab 换区域':this.form.length?'↑↓ 字段 · ←→ 选项':this.view.kind==='basket'?'↑↓ 列表 · ←→ 换列':this.view.kind==='report'||this.view.kind==='confirm'?'↑↓ 选择／动作':'↓ 动作 · ↑ 内容';
    const footer=wrapTextWithAnsi(this.paint('dim',shortTask?'↑↓ 控件 · Esc 返回':`${nav} · Alt 数字 动作 · Enter 执行 · Esc ${this.view.kind==='matrix'&&!this.frame.actionMode&&!this.help?'退出':'返回'} · F1 帮助`),inner);
    const body=this.body(inner,height);this.stripActions(body,inner);
    const feedback=this.message||this.view.error||this.view.message;if(feedback) this.wrap(body,feedback,inner,this.message||this.view.error?'warning':'blue');
    // On genuinely short terminals keep the basket's real primary action row
    // visible while its content and remaining controls still scroll normally.
    // This is the same live row/hit targets, not a duplicate hint or hidden hotkey.
    const pinnedY=shortTask&&!this.help&&this.view.kind==='basket'?this.actionSlots.find(s=>s.actionIndex!==null&&this.actions[s.actionIndex]?.primary)?.y:undefined;
    const pinned=pinnedY===undefined?[]:[{row:body[pinnedY]!,index:pinnedY}];
    this.total=body.length;this.page=Math.max(1,height-header.length-footer.length-2-pinned.length);this.frame.offset=Math.max(0,Math.min(this.frame.offset,this.total-this.page));
    const focus=body.findIndex(r=>r.focus);if(this.offsetReveal&&focus>=0&&focus!==pinnedY) {
      if(focus<this.frame.offset)this.frame.offset=focus;
      else if(focus>=this.frame.offset+this.page)this.frame.offset=Math.max(0,focus-this.page+1);
    }
    this.offsetReveal=false;this.required=new Set(body.flatMap((row,i)=>row.review?[i]:[]));
    const shown=[...body.slice(this.frame.offset,this.frame.offset+this.page).map((row,i)=>({row,index:this.frame.offset+i})).filter(entry=>entry.index!==pinnedY),...pinned];
    shown.forEach(({row,index},i)=>{this.seen.add(index);for(const hit of row.hits??[])this.hits.push({...hit,x:hit.x+1,y:header.length+1+i});});
    const line=(text:string)=>' '+truncateToWidth(text,inner,'');
    const scroll=this.total>this.page?[line(this.paint('dim',`内容 ${this.frame.offset+1}–${Math.min(this.total,this.frame.offset+this.page)}/${this.total} · PgUp/PgDn`))]:[];
    this.ready=true;this.renderedViewId=this.viewId;this.renderedToken=this.token;this.renderEpoch++;
    return [...header.map(line),line(this.paint('dim','─'.repeat(inner))),...shown.map(({row})=>line(row.text)),...scroll,...footer.map(line)].slice(0,height).map(text=>truncateToWidth(text,Math.max(0,w-1),''));
  }
  private enterActions(identity=this.frame.actionIdentity) {
    if(!this.frame.actionMode) {
      this.frame.origin=this.help?'content':this.view.kind==='matrix'?(this.frame.searching?'matrix-query':'matrix'):this.form.length?'form':this.view.kind==='basket'?this.frame.zone:'content';
      this.frame.originOffset=this.frame.offset;
    }
    this.frame.actionMode=true;this.frame.actionIdentity=identity??this.visibleActions()[0]?.identity;this.offsetReveal=true;this.syncFocus();this.redraw();
  }
  private leaveActions() {
    this.frame.actionMode=false;
    if(this.view.kind==='matrix') this.frame.searching=this.frame.origin==='matrix-query';
    if(['query','candidates','selected'].includes(this.frame.origin)) this.frame.zone=this.frame.origin as Zone;
    if(this.view.kind==='matrix'&&!this.help)this.offsetReveal=false;
    else {this.frame.offset=this.frame.originOffset;this.offsetReveal=false;}
    this.syncFocus();this.redraw();
  }
  private visibleActions() {
    // Slot indices belong to the last rendered view, never a newly published task.
    // In particular Ctrl+S before that task's first paint must fail closed.
    if(this.renderedViewId!==this.viewId||this.renderedToken!==this.token)return [];
    return this.actionSlots.flatMap(slot=>slot.actionIndex===null?[]:this.actions[slot.actionIndex]?[this.actions[slot.actionIndex]!]:[]);
  }
  /** Entry points such as /models manage focus the approved action strip, not a menu. */
  focusActions(): void {
    if(this.disposed)return;
    this.sync();
    if(this.view.kind==='matrix')this.enterActions();
  }
  private tabs(back: boolean) {
    if(this.view.kind==='matrix'&&!this.help) {if(this.frame.actionMode)this.leaveActions();else this.enterActions();return;}
    const controls: (number|Zone|'content')[]=this.help?['content']:this.form.length?this.form.map((_,i)=>i):this.view.kind==='basket'?[...(this.view.candidates.length?['query' as const]:[]),...(this.candidates().length?['candidates' as const]:[]),...(this.selectedModels().length?['selected' as const]:[])]:['content'];
    const actions=this.visibleActions(),at=this.frame.actionMode?controls.length+Math.max(0,actions.findIndex(a=>a.identity===this.frame.actionIdentity)):Math.max(0,controls.indexOf(this.form.length?this.frame.fieldIndex:this.view.kind==='basket'?this.frame.zone:'content'));
    const next=(at+(back?-1:1)+controls.length+actions.length)%(controls.length+actions.length);
    if(next>=controls.length)this.enterActions(actions[next-controls.length]?.identity);
    else {if(this.frame.actionMode)this.leaveActions();const control=controls[next];if(typeof control==='number')this.frame.fieldIndex=control;else if(control!=='content')this.frame.zone=control!;}
    this.offsetReveal=true;this.syncFocus();this.redraw();
  }
  private moveActions(data: string) {
    const live=this.actionSlots.filter(s=>s.actionIndex!==null),at=live.find(s=>this.actions[s.actionIndex!]?.identity===this.frame.actionIdentity);
    if(!at)return;
    const up=matchesKey(data,Key.up),down=matchesKey(data,Key.down),left=matchesKey(data,Key.left),right=matchesKey(data,Key.right);let next:Slot|undefined;
    if(left||right) {const row=live.filter(r=>r.y===at.y);next=row[row.indexOf(at)+(right?1:-1)];}
    else if(up||down) {
      const ys=live.map(r=>r.y).filter(y=>up?y<at.y:y>at.y),y=up?Math.max(...ys):Math.min(...ys),centre=at.x+at.width/2;
      next=live.filter(r=>r.y===y).sort((a,b)=>Math.abs(a.x+a.width/2-centre)-Math.abs(b.x+b.width/2-centre)||a.actionIndex!-b.actionIndex!)[0];
      if(up&&!next&&(this.help||this.view.kind!=='matrix')) {this.leaveActions();return;}
    }
    if(next)this.frame.actionIdentity=this.actions[next.actionIndex!]!.identity;
    this.offsetReveal=this.view.kind!=='matrix'||this.help;this.redraw();
  }
  private select(selection: PickerSelection) {
    this.frame.actionMode=false;this.frame.searching=false;this.frame.origin='matrix';this.offsetReveal=true;
    this.command({type:'matrix-select',viewId:this.viewId,selection});this.syncFocus();
  }
  private moveMatrix(data: string) {
    const s=this.state.matrix,rows=s.visible;if(!rows.length){this.leftArmed=false;return;}
    const sel=s.selected,pid=sel.kind==='model'?sel.ref.provider:sel.kind==='provider'?sel.provider:'',mid=sel.kind==='model'?sel.ref.id:'';
    let r=Math.max(0,rows.findIndex(p=>p.provider===pid)),c=rows[r]!.modelIds.indexOf(mid);
    if(matchesKey(data,Key.up)||matchesKey(data,Key.down)) {
      this.leftArmed=false;r=(r+(matchesKey(data,Key.down)?1:-1)+rows.length)%rows.length;
      const row=rows[r]!,id=row.modelIds[Math.min(Math.max(0,c),row.modelIds.length-1)];
      this.select(sel.kind==='provider'||!id?{kind:'provider',provider:row.provider}:{kind:'model',ref:{provider:row.provider,id}});
    } else if(matchesKey(data,Key.right)) {
      this.leftArmed=false;const row=rows[r]!,id=row.modelIds[Math.min(Math.max(0,c+(sel.kind==='provider'?0:1)),row.modelIds.length-1)];
      if(id)this.select({kind:'model',ref:{provider:row.provider,id}});
    } else if(matchesKey(data,Key.left)&&sel.kind==='model') {
      if(c>0)this.select({kind:'model',ref:{provider:pid,id:rows[r]!.modelIds[c-1]!}});
      else if(isKeyRepeat(data))this.leftArmed=false;
      else if(this.leftArmed)this.select({kind:'provider',provider:pid});
      else this.leftArmed=true;
    }
    this.offsetReveal=true;this.redraw();
  }
  private toggle(id: string) {this.rememberIds();this.command({type:'basket-toggle',viewId:this.viewId,modelId:id});this.offsetReveal=true;}
  private toggleAdvanced() {this.frame.advanced=!this.frame.advanced;this.rebuildFields();this.resetReview();this.offsetReveal=true;this.syncFocus();this.redraw();}
  private inputChanged(field?: Field) {
    if(this.view.kind==='matrix')this.command({type:'matrix-query',viewId:this.viewId,query:this.matrixQuery.getValue()});
    else if(this.view.kind==='basket') {this.frame.candidateId=undefined;this.command({type:'basket-query',viewId:this.viewId,query:this.basketQuery.getValue()});}
    else if(field&&field.kind!=='advanced') {this.port?.changed(field.id);this.sync();}
    this.offsetReveal=true;this.redraw();
  }
  private finishPaste() {
    if(this.pasting)this.pasting.handleInput('\x1b[201~');
    this.pasting=null;this.pasteActive=false;this.pasteTail='';this.pasteChanged=undefined;
  }
  private shortcut(data: string): boolean {
    if(this.help)return false;
    if(matchesKey(data,Key.alt('t'))) {this.activate(this.state.matrix.actions.find(a=>a.id==='cycle-palette'));return true;}
    if(this.view.kind!=='matrix')return false;
    const provider=this.state.matrix.selected.kind!=='model';
    const keys: [string,PickerActionId][]=[['n',provider?'new-provider':'add-model'],['e',provider?'edit-provider':'edit-model'],['v','inspect'],['d','default'],['x',provider?'remove-provider':'remove-model'],['z','undo'],['l','locate'],['left','move-left'],['right','move-right'],['up','provider-up'],['down','provider-down']];
    for(const [key,id]of keys)if(matchesKey(data,Key.alt(key as 'n'))) {
      this.activate((id==='provider-up'||id==='provider-down'?this.state.matrix.actions:this.actions).find(a=>a.id===id));return true;
    }
    return false;
  }
  handleInput(data: string): void {
    if(!this.hasFocus||this.disposed||isKeyRelease(data))return;
    this.sync();
    if(this.pasteActive||data.includes('\x1b[200~')) {
      if(!this.pasteActive) {
        if(!this.help&&this.view.kind==='matrix'&&!this.frame.actionMode)this.frame.searching=true;
        if(!this.help&&this.view.kind==='basket'&&this.view.candidates.length){this.frame.zone='query';this.frame.actionMode=false;}
        this.syncFocus();this.pasteActive=true;this.pasting=this.currentInput()??null;
        const field=this.form[this.frame.fieldIndex];this.pasteChanged=()=>this.inputChanged(field);
      }
      this.pasting?.handleInput(data);const combined=this.pasteTail+data;this.pasteTail=combined.slice(-5);
      if(this.pasting)this.pasteChanged?.();
      if(combined.includes('\x1b[201~'))this.finishPaste();this.redraw();return;
    }
    if(isKeyRepeat(data)) {
      const commands=[Key.enter,Key.tab,Key.shift('tab'),Key.escape,Key.ctrl('c'),Key.ctrl('s'),Key.alt('h'),Key.alt('m'),Key.alt('t'),'f1','f6',...digits.map(d=>Key.alt(d))] as const;
      const object=this.view.kind==='matrix'&&(['n','e','v','d','x','z','l','left','right','up','down'] as const).some(k=>matchesKey(data,Key.alt(k)));
      if(commands.some(k=>matchesKey(data,k))||object||(this.view.kind==='basket'&&this.frame.zone==='selected'&&(matchesKey(data,Key.backspace)||matchesKey(data,Key.delete))))return;
    }
    if(!matchesKey(data,Key.left))this.leftArmed=false;
    for(const digit of digits)if(matchesKey(data,Key.alt(digit))) {this.activate(this.actions.find(a=>this.digit(a)===digit));return;}
    if(matchesKey(data,Key.escape)) {
      if(this.help){this.setHelp(false);return;}
      if(this.frame.actionMode&&!(this.view.kind==='basket'&&!this.view.candidates.length&&!this.view.selected.length)){this.leaveActions();return;}
      if(this.view.kind==='matrix'){this.dispose();this.done();return;}
      const ids:PickerActionId[]=this.view.kind==='progress'?['cancel-checks','stop-read']:['back','cancel-confirm','cancel-task','close-info'];
      this.activate(this.actions.find(a=>ids.includes(a.id)));return;
    }
    if(matchesKey(data,Key.ctrl('c'))) {
      if(this.help){this.setHelp(false);return;}
      if(this.view.kind==='matrix'){this.dispose();this.done();return;}
      this.activate(this.actions.find(a=>a.id==='cancel-task'));return;
    }
    if(matchesKey(data,Key.alt('h'))||matchesKey(data,'f1')){this.setHelp(!this.help);return;}
    if(matchesKey(data,'pageDown')||matchesKey(data,'pageUp')||(!this.help&&this.view.kind==='report'&&!this.frame.actionMode&&(matchesKey(data,Key.left)||matchesKey(data,Key.right)))) {
      const forward=matchesKey(data,'pageDown')||matchesKey(data,Key.right);this.frame.offset=Math.max(0,Math.min(Math.max(0,this.total-this.page),this.frame.offset+(forward?this.page:-this.page)));this.offsetReveal=false;this.redraw();return;
    }
    if(matchesKey(data,Key.alt('m'))||matchesKey(data,'f6')){if(this.frame.actionMode)this.leaveActions();else this.enterActions();return;}
    if(matchesKey(data,Key.tab)||matchesKey(data,Key.shift('tab'))){this.tabs(matchesKey(data,Key.shift('tab')));return;}
    if(matchesKey(data,Key.ctrl('s'))){this.activate(this.visibleActions().find(a=>a.primary&&!this.disabled(a)));return;}
    if(this.shortcut(data))return;
    // Native IME commits may contain several printable codepoints in one event.
    // Never treat escape/control-bearing command chunks as text.
    const printable=decodeKittyPrintable(data)??(data.length>0&&!/[\u0000-\u001f\u007f-\u009f]/u.test(data)?data:undefined);
    if(this.frame.actionMode) {
      if(this.view.kind==='basket'&&!this.help&&this.view.candidates.length&&printable){this.leaveActions();this.frame.zone='query';this.syncFocus();this.basketQuery.handleInput(data);this.inputChanged();}
      else if(matchesKey(data,Key.enter))this.activate(this.actions.find(a=>a.identity===this.frame.actionIdentity));
      else this.moveActions(data);return;
    }
    if(this.help){if(matchesKey(data,Key.down))this.enterActions();else if(matchesKey(data,Key.enter))this.activate(this.actions[0]);return;}
    if(this.view.kind==='matrix') {
      if([Key.up,Key.down,Key.left,Key.right].some(k=>matchesKey(data,k))){this.moveMatrix(data);return;}
      if(matchesKey(data,Key.enter)){
        if(this.state.matrix.selected.kind==='provider')this.enterActions();
        else this.activate(this.actions.find(a=>a.id==='switch'));
        return;
      }
      if(printable||[Key.backspace,Key.delete,Key.ctrl('u'),Key.ctrl('w'),Key.home,Key.end].some(k=>matchesKey(data,k))){this.frame.searching=true;this.syncFocus();this.matrixQuery.handleInput(data);this.inputChanged();}return;
    }
    if(this.form.length) {
      const field=this.form[this.frame.fieldIndex];
      if(matchesKey(data,Key.down)||matchesKey(data,Key.enter)) {
        if(matchesKey(data,Key.enter)&&field?.kind==='advanced'){this.toggleAdvanced();return;}
        if(this.frame.fieldIndex<this.form.length-1)this.frame.fieldIndex++;else this.enterActions(this.visibleActions()[0]?.identity);
      } else if(matchesKey(data,Key.up))this.frame.fieldIndex=Math.max(0,this.frame.fieldIndex-1);
      else if(field&&!field.readonly&&!(this.view.kind==='edit'&&this.view.readonly)) {
        if(field.kind==='choice'&&(matchesKey(data,Key.left)||matchesKey(data,Key.right))) {field.setChoice((field.choice()+(matchesKey(data,Key.right)?1:-1)+field.choices.length)%field.choices.length);this.inputChanged(field);}
        else if(field.kind==='input'){field.input.handleInput(data);this.inputChanged(field);}
      }
      this.offsetReveal=true;this.syncFocus();this.redraw();return;
    }
    if(this.view.kind==='basket') {
      const v=this.view,candidates=this.candidates(),f=this.frame;
      if(f.zone==='query') {
        if(matchesKey(data,Key.down)){if(candidates.length)f.zone='candidates';else if(v.selected.length)f.zone='selected';else this.enterActions(this.visibleActions()[0]?.identity);}
        else if(matchesKey(data,Key.enter)) {
          if(candidates.length){f.zone='candidates';f.candidateIndex=0;}
          else {this.message='没有匹配的候选ID；请修改筛选，或选择手动输入ID。';this.redraw();}
        }
        else {this.basketQuery.handleInput(data);this.inputChanged();}
      } else if(matchesKey(data,Key.up)){const index=f.zone==='candidates'?f.candidateIndex:f.selectedIndex;if(index===0){if(v.candidates.length)f.zone='query';else this.enterActions();}else if(f.zone==='candidates')f.candidateIndex--;else f.selectedIndex--;}
      else if(matchesKey(data,Key.down)){const index=f.zone==='candidates'?f.candidateIndex:f.selectedIndex,length=f.zone==='candidates'?candidates.length:v.selected.length;if(index>=length-1)this.enterActions(this.visibleActions()[0]?.identity);else if(f.zone==='candidates')f.candidateIndex++;else f.selectedIndex++;}
      else if(matchesKey(data,Key.left)||matchesKey(data,Key.right)){if(f.zone==='selected'&&matchesKey(data,Key.left)&&candidates.length)f.zone='candidates';else if(f.zone==='candidates'&&matchesKey(data,Key.right)&&v.selected.length)f.zone='selected';}
      else if(matchesKey(data,Key.enter)){if(f.zone==='candidates'&&candidates[f.candidateIndex])this.toggle(candidates[f.candidateIndex]!.id);else if(f.zone==='selected')this.activate(this.actions.find(a=>a.id==='adjust'));}
      else if((matchesKey(data,Key.backspace)||matchesKey(data,Key.delete))&&f.zone==='selected'&&v.selected[f.selectedIndex])this.toggle(v.selected[f.selectedIndex]!.id);
      else if(printable&&v.candidates.length){f.zone='query';this.basketQuery.handleInput(data);this.inputChanged();}
      this.rememberIds();this.offsetReveal=true;this.syncFocus();this.redraw();return;
    }
    if((this.view.kind==='report'||this.view.kind==='confirm')&&(matchesKey(data,Key.up)||matchesKey(data,Key.down))) {
      const n=this.view.kind==='report'?this.view.models.length:this.view.replacements.length;
      if(matchesKey(data,Key.down)&&this.frame.selectedIndex>=n-1)this.enterActions(this.visibleActions()[0]?.identity);
      else this.frame.selectedIndex=Math.max(0,Math.min(n-1,this.frame.selectedIndex+(matchesKey(data,Key.down)?1:-1)));
      this.rememberIds();this.offsetReveal=true;this.redraw();return;
    }
    if(matchesKey(data,Key.enter)){this.activate(this.visibleActions().find(a=>a.primary&&!this.disabled(a)));return;}
    if(matchesKey(data,Key.down))this.enterActions(this.visibleActions()[0]?.identity);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if(!this.hasFocus||this.disposed)return;
    if(event.type==='wheel'&&event.wheelDelta){this.frame.offset=Math.max(0,Math.min(Math.max(0,this.total-this.page),this.frame.offset+event.wheelDelta));this.offsetReveal=false;this.redraw();return {handled:true,render:true};}
    if(event.type!=='click'||event.button!=='left')return;
    if(this.view.kind==='matrix'&&!this.help&&(!this.ready||this.size!==this.dimensions()||this.renderedViewId!==this.viewId||this.renderedToken!==this.token))return;
    const hit=this.hits.find(h=>h.y===event.y&&event.x>=h.x&&event.x<h.x+h.w);if(!hit)return;
    hit.run(event);this.redraw();return {handled:true,focus:true,render:true};
  }
  /** Geometry/navigation only: never snapshots, field values or effect payloads. */
  debug() {
    return {view:this.help?'help':this.view.kind,viewId:this.viewId,offset:this.frame.offset,page:this.page,total:this.total,
      ...(!this.help&&this.view.kind==='matrix'?{matrixViewport:{top:this.frame.offset,page:this.page,total:this.total}}:{}),
      ready:this.ready,reviewComplete:!!this.token&&[...this.required].every(i=>this.seen.has(i)),fieldIndex:this.frame.fieldIndex,
      actionMode:this.frame.actionMode,selectedAction:this.actions.find(a=>a.identity===this.frame.actionIdentity)?.id,
      selectedActionIdentity:this.frame.actionIdentity,zone:this.frame.zone,candidateIndex:this.frame.candidateIndex,selectedIndex:this.frame.selectedIndex,
      advanced:this.frame.advanced,searching:this.frame.searching,actionCols:Math.max(1,...this.actionSlots.map(s=>this.actionSlots.filter(t=>t.y===s.y).length)),actionRects:this.actionRects.map(r=>({...r})),actionSlots:this.actionSlots.map(s=>({...s})),matrixCells:this.matrixCells.map(c=>({...c}))};
  }
  dispose(): void {
    if(this.disposed)return;
    this.disposed=true;this.hasFocus=false;this.finishPaste();this.unsubscribe?.();
    for(const field of this.port?.fields()??[])if(field.kind==='input')field.input.focused=false;
    this.port=undefined;this.form=[];this.actions=[];this.frames.clear();this.hits=[];this.resetReview();
    this.matrixQuery.setValue('');this.basketQuery.setValue('');this.workspace.dispose();
  }
}
