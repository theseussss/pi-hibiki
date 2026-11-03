import { visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import type { MatrixProvider, PickerActionId } from './workspace.js';

export type SlotPlacement = { index: number; x: number; width: number };
export type ActionSlotSpec = { key: string; ids: readonly PickerActionId[]; width: number; variants: readonly string[] };
export const safe = (value: unknown): string => stripVTControlCharacters(String(value ?? ''))
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
// V10 geometry: shared columns, bounded cells, semantic slots; no I/O or state engine.
export function commandColumns(widths:readonly number[],width:number,trailingOptional=false):SlotPlacement[][]{
 if(!widths.length)return [];
 for(let capacity=widths.length;capacity>=1;capacity--){
  const count=Math.ceil(widths.length/capacity),live=widths.length-(trailingOptional?1:0),plan:number[][]=[];let index=0;
  for(let row=0;row<count;row++){
   const length=Math.floor(live/count)+(row<live%count?1:0);
   plan.push(Array.from({length},()=>index++));
  }
  if(trailingOptional)plan[count-1]!.push(index);
  const columns=Array.from({length:Math.max(...plan.map(row=>row.length))},(_,column)=>Math.max(...plan.flatMap(row=>row[column]===undefined?[]:[Math.min(width,widths[row[column]!]!)])));
  let spare=width-(columns.reduce((sum,w)=>sum+w,0)+columns.length-1);if(spare<0)continue;
  // Fill shared columns, not row gaps. Shortest first, leftmost on ties;
  // intrinsic captions may exceed 24, but never grow beyond their own budget.
  // A single short task strip stays compact even in a very wide terminal.
  if(plan.length>1||columns.length>3){
   const limits=columns.map(w=>Math.max(w,24));
   while(spare>0){
    let shortest=-1;
    for(let i=0;i<columns.length;i++)if(columns[i]!<limits[i]!&&(shortest<0||columns[i]!<columns[shortest]!))shortest=i;
    if(shortest<0)break;
    columns[shortest]=columns[shortest]!+1;spare--;
   }
  }
  const xs:number[]=[];let x=0;for(const w of columns){xs.push(x);x+=w+1;}
  return plan.map(row=>row.map((index,column)=>({index,x:xs[column]!,width:columns[column]!})));
 }
 return [];
}
// Archive captions are data, not stable command slots. Keep them compact and
// full-length, wrapping within a cell when necessary; never justify endpoints.
export function compactRows(widths:readonly number[],width:number):SlotPlacement[][]{
 const rows:SlotPlacement[][]=[];let row:SlotPlacement[]=[],x=0;
 for(const [index,w]of widths.entries()){
  const budget=Math.min(width,w);if(row.length&&x+budget>width){rows.push(row);row=[];x=0;}
  row.push({index,x,width:budget});x+=budget+1;
 }
 if(row.length)rows.push(row);return rows;
}
// Model ordinals share columns across ALL providers, including filtered-out
// models. Selection/current/favorite/default marks never enter these budgets.
export function modelColumns(providers:readonly MatrixProvider[],width:number):number[]{
 const maxCount=Math.max(0,...providers.map(p=>p.models.length));if(!maxCount)return [];
 // Each column reserves at least 6 badge columns plus a 2-column gutter.
 // Skip impossible capacities instead of scanning the full catalog quadratically.
 for(let count=Math.min(maxCount,Math.max(1,Math.floor((width+2)/8)));count>=1;count--){
  const columns=Array.from({length:count},()=>0);
  for(const p of providers)for(const [index,m]of p.models.entries())columns[index%count]=Math.max(columns[index%count]!,Math.min(26,width,visibleWidth(safe(m.name))+6));
  if(columns.reduce((sum,w)=>sum+w,0)+2*(count-1)<=width)return columns;
 }
 return [];
}
// Budget complete compact labels, cursor prefix and shortcut, not the current state.
// Counts 0..100, readonly and optional controls all use the same workspace template.
// Full available width selects balanced rows; shared columns then grow up to
// max(intrinsic,24). Model commands use 3 rows at 80, 2 at 120..160; providers
// use 2 at 80/120, 1 at 140/160. Short single task rows stay compact.
// Narrow widths wrap complete labels; dynamic archive
// labels and long matrix content may require scrolling, not pixel-frozen blocks.
// Only width/kind reflows these slots; content above and viewport scrolling can
// still move the entire action block. Archive entry labels are deliberately dynamic.
export const commandSlot=(key:string,ids:readonly PickerActionId[],labels:readonly string[],hint?:string):ActionSlotSpec=>{const variants=labels.map(label=>`  ${label}${hint?' ['+hint+']':''}`);return {key,ids,variants,width:Math.max(...variants.map(visibleWidth))};};
const numberedSlot=(digit:string,key:string,ids:readonly PickerActionId[],labels:readonly string[])=>commandSlot(key,ids,labels,digit);
export const actionTemplates:Record<string,readonly ActionSlotSpec[]>={
 model:[
  commandSlot('switch',['switch'],['切换','使用中'],'Enter'),
  numberedSlot('1','favorite',['favorite'],['收藏','取消收藏']),
  numberedSlot('2','edit',['edit-model'],['编辑','查看参数']),
  numberedSlot('3','inspect',['inspect'],['检查']),
  numberedSlot('4','default',['default'],['设为默认','默认']),
  numberedSlot('5','move-left',['move-left'],['前移']),
  numberedSlot('6','move-right',['move-right'],['后移']),
  numberedSlot('7','add-model',['add-model'],['添加模型']),
  numberedSlot('8','remove',['remove-model'],['移除']),
  numberedSlot('9','new-provider',['new-provider'],['添加供应商']),
  numberedSlot('0','archives',['archives'],['已移除']),
  commandSlot('undo',['undo'],['撤销'],'Alt Z'),
  commandSlot('locate',['locate'],['定位'],'Alt L'),
  commandSlot('fast',['fast'],['开启会话 Fast','关闭会话 Fast'])
 ],
 provider:[
  numberedSlot('2','edit',['edit-provider'],['编辑连接']),
  numberedSlot('5','move-left',['provider-up'],['上移']),numberedSlot('6','move-right',['provider-down'],['下移']),
  numberedSlot('7','add-model',['add-model'],['添加模型']),numberedSlot('8','remove',['remove-provider'],['移除供应商']),
  numberedSlot('9','new-provider',['new-provider'],['添加供应商']),numberedSlot('0','archives',['archives'],['已移除']),
  commandSlot('undo',['undo'],['撤销'],'Alt Z'),commandSlot('locate',['locate'],['定位'],'Alt L')
 ],
 empty:[numberedSlot('9','new-provider',['new-provider'],['添加供应商']),numberedSlot('0','archives',['archives'],['已移除'])],
 connection:[numberedSlot('1','connect',['connect'],['读取模型']),numberedSlot('2','manual-connection',['manual-connection'],['手输 ID']),numberedSlot('0','cancel-task',['cancel-task','back'],['取消','返回'])],
 edit:[numberedSlot('1','save-form',['save-form'],['保存']),numberedSlot('0','back',['back'],['返回'])],
 limits:[numberedSlot('1','save-form',['save-form'],['查看差异']),numberedSlot('2','reset-limits',['reset-limits'],['重置为继承']),numberedSlot('0','back',['back'],['返回'])],
 manual:[numberedSlot('1','add-ids',['add-ids'],['加入已选']),numberedSlot('0','back',['back'],['返回'])],
 basket:[
  numberedSlot('1','next-models',['next-models'],Array.from({length:101},(_,i)=>`继续（${i}）`)),
  numberedSlot('2','read-list',['read-list'],['读取模型清单','刷新模型清单']),
  numberedSlot('3','manual-id',['manual-id'],['手动输入ID']),
  numberedSlot('4','stop-read',['stop-read'],['停止读取']),
  numberedSlot('0','back',['back'],['返回'])
 ],
 preflight:[numberedSlot('1','run',['run'],['开始检查']),numberedSlot('2','skip',['skip'],['跳过']),numberedSlot('3','image',['image'],['✓ 图片样例','□ 图片样例']),numberedSlot('4','reuse',['reuse'],['复用报告']),numberedSlot('0','back',['back'],['返回'])],
 progress:[numberedSlot('1','cancel-checks',['cancel-checks','stop-read'],['停止检查','停止读取']),numberedSlot('0','cancel-task',['cancel-task'],['取消'])],
 report:[
  numberedSlot('1','finish',['commit','finish-inspect'],['完成',...Array.from({length:101},(_,i)=>`确认添加（${i}）`)]),
  numberedSlot('2','adjust',['adjust'],['调整参数']),numberedSlot('3','recheck',['recheck'],['重新检查']),
  numberedSlot('4','details',['details'],['参数详情','收起参数']),numberedSlot('5','apply-inspect',['apply-inspect'],['应用修改']),numberedSlot('0','back',['back'],['返回'])
 ],
 confirm:[numberedSlot('1','confirm',['replacement','confirm-remove','confirm-restore','confirm-recover','commit','apply-inspect','commit-limits'],['下一步','确认移除','确认恢复','确认完成','确认应用','确认添加','确认保存','确认重置']),numberedSlot('0','cancel-confirm',['cancel-confirm','back'],['取消','返回'])],
 fast:[numberedSlot('1','off',['fast-off'],['关闭']),numberedSlot('2','priority',['fast-priority'],['Fast（priority）']),numberedSlot('3','ultrafast',['fast-ultrafast'],['Ultrafast']),numberedSlot('4','observations',['fast-observations'],['发送与回显']),numberedSlot('0','back',['back'],['返回'])],
 recovery:[numberedSlot('1','recover',['recover','confirm-recover'],['确认完成']),numberedSlot('0','back',['back'],['返回'])],
 info:[numberedSlot('1','consent',['connect','read-list','commit','sync-reference'],['确认读取','确认添加','确认同步参考']),numberedSlot('0','back',['back','close-info','close-help'],['返回','关闭'])],
 archives:[numberedSlot('0','back',['back'],['返回'])],
 help:[numberedSlot('0','close-help',['close-help'],['关闭帮助'])]
};
