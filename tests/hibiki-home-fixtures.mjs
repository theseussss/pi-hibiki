/** Anonymous, deterministic HOME acceptance catalog. No real credentials or routes. */
export const homeModelCounts = Object.freeze([7, 1, 4, 9, 4, 2, 2, 3, 8, 7, 7, 4, 4, 4, 5, 2, 7, 1, 6, 6, 6, 5]);
const providerNames = ['北辰模型实验供应商', 'One', 'Long English Provider Laboratory', '长名称供应商用于紧凑矩阵回归', 'Harbor', '青竹', 'Cedar', '云帆', 'Anonymous Research Collective', '山海', 'Silver Observatory', '墨色', 'Willow', '晨光', 'Synthetic Model Workshop', '湖畔', 'Very Long Anonymous Provider Name', '星河', 'Maple', '远山', 'Quiet Laboratory', '终点'];
const names = [
  'Synthetic Reasoning Model Extended Context Generation',
  '匿名中文推理模型超长上下文专业增强版本',
  'English Vision Instruction Preview Experimental',
  '多模态工具调用模型长名称区分后缀测试',
  'Compact',
  'Research Coding Assistant Long English Model Name',
  '中文代码助手高性能推理模型正式版',
  'Anonymous Streaming Model Evaluation Candidate',
  '终末模型超长名称保留重要后缀',
];
export const homeShape = Object.freeze({ providers: 22, models: 104, counts: homeModelCounts });
export const homeCurrent = Object.freeze({ provider: 'p00', id: 'm0' });
export const homeDefault = Object.freeze({ provider: 'p03', id: 'm8' });
export const homeFavorites = Object.freeze(['p00/m0', 'p00/m6', 'p03/m8', 'p21/m4']);
/** Fresh objects on every call: paired renderers may safely normalize independently. */
export function homeConfig() {
  return { providers: Object.fromEntries(homeModelCounts.map((count, i) => {
    const id = `p${String(i).padStart(2, '0')}`;
    return [id, { name: providerNames[i], baseUrl: `https://${id}.home-fixture.invalid/v1`, api: 'openai-completions',
      models: Array.from({ length: count }, (_, j) => ({ id: `m${j}`, name: `${names[(i + j) % names.length]} ${id}-suffix-${j}`,
        contextWindow: 128000 + j * 1024, maxTokens: 8192, reasoning: j % 2 === 0,
        input: j % 3 === 0 ? ['text', 'image'] : ['text'] })) }];
  })) };
}
/** Seed the existing bounded fixture harness without touching any host settings. */
export function homeFixtureFiles() {
  return {
    'settings.json': { defaultProvider: homeDefault.provider, defaultModel: homeDefault.id },
    'model-pick-favorites.json': [...homeFavorites],
    'model-pick-order.json': {
      providers: homeModelCounts.map((_, i) => `p${String(i).padStart(2, '0')}`),
      models: Object.fromEntries(homeModelCounts.map((count, i) => [`p${String(i).padStart(2, '0')}`, Array.from({ length: count }, (_, j) => `m${j}`)])),
    },
  };
}
