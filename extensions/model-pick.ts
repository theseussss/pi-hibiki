/**
 * Hibiki · 模型工作台 — 保留 model-pick 行式矩阵与 Ctrl+L
 *
 * 形态:provider 为行,行内模型等宽栅格横排。检索态全表 fuzzy
 * (模型名/ID/provider),命中按 provider 聚合成行,组间按最优命中排序。
 * 长名中间省略;超宽行行内滚动,‹ / +N 指示余量,所有模型键盘可达。
 *
 * 排序体系(浏览态行内,优先级从高到低):
 *   1. 自定义声明(model-pick-order.json 的 providers/models)
 *   2. 默认模型(settings.json 的 defaultProvider/defaultModel)
 *   3. 收藏 ★(Tab 键切换,存 model-pick-favorites.json)
 *   4. 使用频率(最近 60 个会话的 assistant 消息统计,count → lastUsed)
 *   5. models.json 配置声明序兜底
 * 默认模型:Alt+D 把光标模型直写为 settings.json 新默认(原子写+滚动备份
 * settings.json.bak-model-pick.sealed(后台保护,无主密码);settingsManager 按字段合并落盘,互不干扰;
 * pi 内存态的官方选择器徽章重启后才同步)。
 * 配色主题:Alt+T 循环切换(樱花马卡龙/黄昏/彩虹/赛博朋克/像素/原生单色),
 * 写入 model-pick-theme.json。调色板全盘接管一切视觉要素(cur/def/fav/sel/
 * text/dim/accent/框线色标),真彩直写不经全局主题槽——选择器是自包含视觉岛,
 * 换主题即整体换装,与全局主题零耦合。像素为阶梯硬切,余为平滑渐变。
 * 面板即编辑器:Alt+←/→ 行内移动模型、Alt+↑/↓ 移动渠道行,
 * 移动即写入 order 文件,面板操作与持久层统一。
 * 焦点:首个模型处连续两次←进入现有供应商列,→返回模型区;不加操作行。
 * Alt+N/X按焦点添加/移除模型或供应商;临时任务结束回原查询/位置。
 * Alt+Z就近撤销移除,Alt+L按需定位新增/恢复项;不自动切换当前模型。
 * 打开即同步:order/favorites 与「models-store 原生目录 ∪
 * models.json 自定义声明 ∪ 当前可用」求交集,渠道退出时死条目
 * 当场清掉;凭据临时缺失的渠道定义仍在,不被误清(行序/收藏保留)。
 * (altScreen 系键——Ctrl+F/翻页/prompt 跳转——被 TUI 主循环全局拦截,
 * 组件收不到;编辑模式绕不开此层,故键位只能在可达空间内选)
 * provider 行序:自定义声明 > 配置序。当前模型不改排序,仅 ● 标记,
 * 光标初始锚定在它身上。
 *
 * 入口:/models 命令 + Ctrl+L(需 keybindings.json 将原生选择器
 * 重绑至 ctrl+shift+l 以释放 ctrl+l;未重绑时快捷键自动失效)。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FastController } from "../lib/fast.js";
import { BRAND, ROLE } from "../lib/identity.js";
import { decodeKittyPrintable, fuzzyFilter, Input, isKeyRelease, isKeyRepeat, Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { PickerStore, type Guard } from "../lib/model-pick/store.js";
import { PickerRecords } from "../lib/model-pick/records.js";
import { createRecordProtection, type RecordProtection } from "../lib/model-pick/protection.js";
import { PickerActions } from "../lib/model-pick/panel.js";
import { ProbeError, validateEndpoint } from "../lib/model-pick/probe.js";
import { mergeVisibleOrder } from "../lib/model-pick/order.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Row {
	model: Model<Api>;
	fullId: string; // provider/id
	name: string;
	id: string;
	provider: string;
	spec: string; // 详情行:上下文窗口 + 能力标签
	available: boolean;
}

interface PRow {
	provider: string;
	models: Row[];
}

interface OrderConfig {
	providers?: string[];
	models?: Record<string, string[]>;
}

interface UsageStat {
	count: number;
	lastUsed: number;
}

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const ORDER_PATH = path.join(AGENT_DIR, "model-pick-order.json");
const FAVS_PATH = path.join(AGENT_DIR, "model-pick-favorites.json");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const SETTINGS_BAK_PATH = path.join(AGENT_DIR, "settings.json.bak-model-pick.sealed");
const THEME_PATH = path.join(AGENT_DIR, "model-pick-theme.json");

function loadOrder(): OrderConfig {
	try {
		if (fs.existsSync(ORDER_PATH)) {
			const data = JSON.parse(fs.readFileSync(ORDER_PATH, "utf-8"));
			if (data && typeof data === "object") return data as OrderConfig;
		}
	} catch {}
	return {};
}

function saveOrder(order: OrderConfig): void {
	try {
		fs.writeFileSync(ORDER_PATH, JSON.stringify(order, null, 2));
	} catch {}
}

function loadFavorites(): Set<string> {
	try {
		if (fs.existsSync(FAVS_PATH)) {
			const data = JSON.parse(fs.readFileSync(FAVS_PATH, "utf-8"));
			if (Array.isArray(data)) return new Set(data.filter((x) => typeof x === "string"));
		}
	} catch {}
	return new Set();
}

function saveFavorites(favs: Set<string>): void {
	try {
		fs.writeFileSync(FAVS_PATH, JSON.stringify([...favs]));
	} catch {}
}

/**
 * 使用频率统计:session 文件名即 ISO 时间戳,按名排序取最近 60 个会话,
 * 统计 assistant 消息的 provider/model 出现次数与最近使用时间。
 * 实测 60 个文件约 55MB / 130ms,每次打开选择器直读,无需缓存。
 */
function collectUsage(): Map<string, UsageStat> {
	const stats = new Map<string, UsageStat>();
	try {
		const dir = path.join(AGENT_DIR, "sessions");
		const files: string[] = [];
		for (const sub of fs.readdirSync(dir)) {
			const subDir = path.join(dir, sub);
			try {
				for (const f of fs.readdirSync(subDir)) {
					if (f.endsWith(".jsonl")) files.push(path.join(subDir, f));
				}
			} catch {}
		}
		files.sort((a, b) => {
			const ba = path.basename(a);
			const bb = path.basename(b);
			return ba < bb ? 1 : ba > bb ? -1 : 0;
		});
		for (const fp of files.slice(0, 60)) {
			let content: string;
			try {
				content = fs.readFileSync(fp, "utf-8");
			} catch {
				continue;
			}
			for (const line of content.split("\n")) {
				if (!line.includes('"role":"assistant"') && !line.includes('"role": "assistant"')) continue;
				try {
					const e = JSON.parse(line);
					const msg = e.message ?? e;
					if (msg.role !== "assistant") continue;
					const provider = msg.provider;
					const model = typeof msg.model === "string" ? msg.model : msg.model?.id;
					if (!provider || !model) continue;
					const fid = `${provider}/${model}`;
					const ts = Date.parse(e.timestamp ?? msg.timestamp ?? "") || 0;
					const s = stats.get(fid) ?? { count: 0, lastUsed: 0 };
					s.count++;
					if (ts > s.lastUsed) s.lastUsed = ts;
					stats.set(fid, s);
				} catch {}
			}
		}
	} catch {}
	return stats;
}

/**
 * 同步基准:三层并集——①models-store.json 原生/注册渠道目录
 * (kimi-coding、xiaomi-token-plan-cn 等原生渠道的定义层);
 * ②models.json 自定义声明(models 字段兼容字符串与对象);
 * ③当前可用集合。凭据临时缺失但定义仍在的渠道不算「退出」,
 * 不参与清洗。
 */
function collectDeclared(all: Model<Api>[]): { providers: Set<string>; models: Set<string> } {
	const providers = new Set<string>();
	const models = new Set<string>();
	const addDir = (name: string, declared: unknown) => {
		providers.add(name);
		if (Array.isArray(declared)) {
			for (const m of declared) {
				models.add(`${name}/${typeof m === "string" ? m : (m as any)?.id}`);
			}
		}
	};
	try {
		const store = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "models-store.json"), "utf-8"));
		for (const [name, cfg] of Object.entries(store ?? {})) {
			addDir(name, (cfg as any)?.models);
		}
	} catch {}
	try {
		const custom = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "models.json"), "utf-8"));
		for (const [name, cfg] of Object.entries(custom?.providers ?? {})) {
			addDir(name, (cfg as any)?.models);
		}
	} catch {}
	for (const m of all) {
		addDir(String(m.provider), [m.id]);
	}
	return { providers, models };
}

/**
 * 打开即同步:order/favorites 与基准求交集,有变化才写回。
 * 返回是否发生了清理(供调用方决定是否落盘)。
 */
function syncPersisted(order: OrderConfig, favs: Set<string>, all: Model<Api>[]): boolean {
	const { providers: liveP, models: liveM } = collectDeclared(all);
	// 锁态仍保留归档身份；安全索引异常时不进行破坏性清洗。
	try {
		const retained = new PickerStore(AGENT_DIR).retained();
		for (const p of retained.providers) liveP.add(p);
		for (const m of retained.models) liveM.add(m);
	} catch { return false; }
	let dirty = false;
	if (Array.isArray(order.providers)) {
		const filtered = order.providers.filter((p) => liveP.has(p));
		if (filtered.length !== order.providers.length) {
			order.providers = filtered;
			dirty = true;
		}
	}
	if (order.models) {
		for (const p of Object.keys(order.models)) {
			if (!liveP.has(p)) {
				delete order.models[p];
			dirty = true;
				continue;
			}
			const ids = order.models[p];
			const filtered = ids.filter((id) => liveM.has(`${p}/${id}`));
			if (filtered.length !== ids.length) {
				order.models[p] = filtered;
				dirty = true;
			}
		}
	}
	for (const f of favs) {
		if (!liveM.has(f)) {
			favs.delete(f);
			dirty = true;
		}
	}
	return dirty;
}

function formatCtx(tokens: number): string {
	if (!tokens) return "";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return `${tokens}`;
}

function buildSpec(m: Model<Api>): string {
	const parts: string[] = [];
	const ctx = formatCtx(m.contextWindow);
	if (ctx) parts.push(ctx);
	if (m.reasoning) parts.push("think");
	if (Array.isArray(m.input) && m.input.includes("image")) parts.push("vision");
	return parts.join(" ");
}

/** 长名中间省略:保头保尾,区分信息多在两端(家族/版本号) */
function shortenMiddle(name: string, maxLen: number): string {
	const width = visibleWidth(name);
	if (width <= maxLen) return name;
	const keep = Math.max(0, maxLen - 1);
	const headLen = Math.ceil(keep / 2);
	const tailLen = keep - headLen;
	return sliceByColumn(name, 0, headLen, true) + "…" + sliceByColumn(name, width - tailLen, tailLen, true);
}

interface DefaultRef {
	provider: string;
	id: string;
}

/** 默认模型:直读 settings.json(扩展 API 未暴露 settingsManager,与 order/favs 同款直读) */
function readDefaultState(): { known: boolean; ref: DefaultRef | null } {
	try {
		const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { known: false, ref: null };
		const provider = raw.defaultProvider; const id = raw.defaultModel;
		if (provider === undefined && id === undefined) return { known: true, ref: null };
		if (typeof provider === "string" && provider && typeof id === "string" && id) return { known: true, ref: { provider, id } };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { known: true, ref: null };
	}
	return { known: false, ref: null };
}
function loadDefaultRef(): DefaultRef | null { return readDefaultState().ref; }
function sameRef(a: DefaultRef | null | undefined, b: DefaultRef | null | undefined): boolean {
	return a?.provider === b?.provider && a?.id === b?.id;
}

/** Alt+D 落盘:滚动备份+原子写,防半截写入损毁核心配置 */
function writeDefaultModel(provider: string, id: string, protection: RecordProtection, expected?: DefaultRef | null, canCommit?: () => boolean): boolean {
	const staged: string[] = [];
	try {
		if (canCommit && !canCommit()) return false;
		const stat = fs.lstatSync(SETTINGS_PATH);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
		const before = fs.readFileSync(SETTINGS_PATH, "utf-8");
		const raw = JSON.parse(before);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
		if (expected !== undefined && !sameRef(expected, typeof raw.defaultProvider === "string" && typeof raw.defaultModel === "string" ? { provider: raw.defaultProvider, id: raw.defaultModel } : null)) return false;
		raw.defaultProvider = provider; raw.defaultModel = id;
		// Historical settings may contain private extension fields. New backups
		// are protected records, never another ordinary plaintext settings copy.
		const protectedBackup = JSON.stringify(protection.seal({ version: 1, kind: "model-pick-settings-backup", when: Date.now(), before }, "settings"));
		if ((canCommit && !canCommit()) || fs.readFileSync(SETTINGS_PATH, "utf-8") !== before) return false;
		const stage = (file: string, value: string) => {
			const temp = `${file}.model-pick-${randomUUID()}.tmp`;
			const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
			staged.push(temp);
			try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, value, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			return temp;
		};
		const next = stage(SETTINGS_PATH, `${JSON.stringify(raw, null, 2)}\n`);
		const backup = stage(SETTINGS_BAK_PATH, `${protectedBackup}\n`);
		if ((canCommit && !canCommit()) || fs.readFileSync(SETTINGS_PATH, "utf-8") !== before) return false;
		fs.renameSync(backup, SETTINGS_BAK_PATH);
		if ((canCommit && !canCommit()) || fs.readFileSync(SETTINGS_PATH, "utf-8") !== before) return false;
		fs.renameSync(next, SETTINGS_PATH);
		const directory = fs.openSync(AGENT_DIR, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
		try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
		return true;
	} catch { return false; }
	finally { for (const temp of staged) { try { fs.unlinkSync(temp); } catch {} } }
}

type RGB = readonly [number, number, number];

interface Palette {
	key: string;
	name: string;
	cur: RGB; // 当前模型(加粗)
	def: RGB; // 默认模型
	fav: RGB; // 收藏
	sel: RGB; // 光标格
	text: RGB; // 普通格
	dim: RGB; // 辅助(非选中行首/提示/详情/溢出标记)
	accent: RGB; // 标题/选中行首/搜索提示符
	stops: readonly RGB[];
	steps: boolean; // true=阶梯硬切(像素风),false=平滑渐变
}

/** 调色板表:每套主题全要素成套设计,色系内部自洽 */
const PALETTES: readonly Palette[] = [
	{
		key: "sakura",
		name: "樱花马卡龙",
		cur: [232, 93, 158], // 浓樱 #E85D9E
		def: [242, 167, 198], // 浅樱粉 #F2A7C6
		fav: [199, 184, 245], // 薰衣草 #C7B8F5
		sel: [127, 196, 232], // 天蓝 #7FC4E8(粉海中的对比色,仍在马卡龙色系)
		text: [245, 235, 240], // 粉白
		dim: [151, 128, 142], // 灰粉
		accent: [239, 195, 230], // 花瓣 #EFC3E6
		stops: [
			[242, 167, 198],
			[252, 201, 185],
			[239, 195, 230],
			[199, 184, 245],
			[159, 211, 242],
		],
		steps: false,
	},
	{
		key: "dusk",
		name: "黄昏",
		cur: [248, 181, 0], // 山吹 #F8B500(nipponcolors 和色大辞典,棣棠花色)
		def: [225, 107, 91], // 茜红 #E16B5B
		fav: [143, 184, 216], // 雾蓝 #8FB8D8
		sel: [184, 169, 217], // 暮紫 #B8A9D9(暖海中的暮色对比)
		text: [242, 237, 228], // 米白
		dim: [141, 133, 120], // 暖灰
		accent: [240, 131, 0], // 橙 #F08300
		stops: [
			[248, 181, 0], // 金
			[240, 131, 0], // 橙
			[225, 107, 91], // 茜
			[123, 94, 167], // 暮紫
			[46, 58, 89], // 夜靛
		],
		steps: false,
	},
	{
		key: "rainbow",
		name: "彩虹",
		cur: [255, 217, 61], // 明黄 #FFD93D
		def: [255, 111, 181], // 亮粉 #FF6FB5
		fav: [61, 193, 211], // 青 #3DC1D3
		sel: [255, 255, 255], // 亮白(彩虹中的中性跳色)
		text: [240, 240, 245], // 白
		dim: [154, 160, 168], // 中灰
		accent: [255, 159, 67], // 橙 #FF9F43
		stops: [
			[255, 90, 90],
			[255, 159, 67],
			[255, 217, 61],
			[107, 203, 61],
			[61, 193, 211],
			[75, 123, 255],
			[165, 94, 234],
		],
		steps: false,
	},
	{
		key: "cyberpunk",
		name: "赛博朋克",
		cur: [252, 238, 12], // 霓虹黄 #FCEE0C
		def: [255, 46, 136], // 电粉 #FF2E88
		fav: [0, 229, 255], // 电青 #00E5FF
		sel: [181, 55, 242], // 电紫 #B537F2
		text: [232, 246, 255], // 冷白
		dim: [94, 107, 138], // 暗蓝灰(夜色底味)
		accent: [0, 255, 156], // 酸绿 #00FF9C
		stops: [
			[255, 46, 136],
			[181, 55, 242],
			[59, 130, 246],
			[0, 229, 255],
		],
		steps: false,
	},
	{
		key: "pixel",
		name: "像素",
		cur: [255, 216, 0], // 像素黄 #FFD800
		def: [255, 64, 64], // 像素红 #FF4040
		fav: [61, 214, 140], // 像素绿 #3DD68C
		sel: [74, 144, 217], // 像素蓝 #4A90D9
		text: [240, 240, 232], // 米白(复古屏感)
		dim: [122, 122, 140], // 灰紫
		accent: [255, 140, 66], // 像素橙 #FF8C42
		stops: [
			[255, 64, 64],
			[255, 140, 66],
			[255, 216, 0],
			[61, 214, 140],
			[74, 144, 217],
			[116, 84, 232],
		],
		steps: true,
	},
	{
		key: "mono",
		name: "原生单色",
		cur: [255, 176, 0], // 琥珀 #FFB000(全套唯一强调色)
		def: [216, 216, 216], // 浅灰
		fav: [168, 168, 168], // 中浅灰
		sel: [255, 255, 255], // 亮白
		text: [224, 224, 224], // 灰白
		dim: [128, 128, 128], // 中灰
		accent: [192, 192, 192], // 银灰
		stops: [
			[110, 110, 110],
			[145, 145, 145],
			[180, 180, 180],
			[205, 205, 205],
		],
		steps: false,
	},
];

function loadPaletteIndex(): number {
	try {
		const raw = JSON.parse(fs.readFileSync(THEME_PATH, "utf-8"));
		const idx = PALETTES.findIndex((p) => p.key === raw?.theme);
		if (idx >= 0) return idx;
	} catch {}
	return 0; // 默认樱花马卡龙——与全局主题 sakura-macaron 同族
}

function savePaletteIndex(idx: number): void {
	try {
		fs.writeFileSync(THEME_PATH, `${JSON.stringify({ theme: PALETTES[idx]!.key }, null, 2)}\n`);
	} catch {}
}

/** 框线着色:0→1→0 往返采样,两端同色,中段走色标光谱;steps=true 阶梯硬切(像素风) */
function frameGradient(line: string, stops: readonly RGB[], steps: boolean): string {
	if (!line) return line;
	const chars = [...line];
	const span = Math.max(1, chars.length - 1);
	let out = "";
	for (let i = 0; i < chars.length; i++) {
		const pos = i / span;
		const t = pos <= 0.5 ? pos * 2 : (1 - pos) * 2; // 往返:两端同色
		let rgb: RGB;
		if (steps) {
			rgb = stops[Math.min(stops.length - 1, Math.floor(t * stops.length))]!;
		} else {
			const scaled = t * (stops.length - 1);
			const idx = Math.min(stops.length - 2, Math.floor(scaled));
			const from = stops[idx]!;
			const to = stops[idx + 1]!;
			const f = scaled - idx;
			rgb = [
				Math.round(from[0] + (to[0] - from[0]) * f),
				Math.round(from[1] + (to[1] - from[1]) * f),
				Math.round(from[2] + (to[2] - from[2]) * f),
			];
		}
		out += `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${chars[i]}`;
	}
	return `${out}\u001b[39m`;
}

function rgbFg(rgb: RGB, s: string): string {
	return `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\u001b[39m`;
}

export async function openPicker(pi: ExtensionAPI, ctx: any, initialActions = false, initialProviderFocus = false, fast?: FastController, initialFast = false): Promise<void> {
	if (!ctx.hasUI || (ctx.mode && ctx.mode !== "tui")) {
		ctx.ui.notify("模型选择器需要交互模式", "error");
		return;
	}
	// 与原生 /model 相同的数据来源:先从磁盘刷新,再取有凭据的模型
	try {
		await ctx.modelRegistry.refresh?.({ allowNetwork: false });
	} catch {}
	let all: Model<Api>[] = ctx.modelRegistry.getAvailable();
	const protectedProviders = new Set<string>([...getBuiltinProviders(), "radius", ...(ctx.modelRegistry.getRegisteredProviderIds?.() ?? [])]);
	const protection = createRecordProtection();
	const store = new PickerStore(AGENT_DIR, protectedProviders, protection);
	const records = new PickerRecords(AGENT_DIR, protection);
	let custom: ReturnType<PickerStore["snapshot"]>["providers"] = [];
	let customReadable = true;
	try { custom = store.snapshot().providers; } catch { customReadable = false; }
	const credentialSalt = randomBytes(32);
	const credentialVersions = new Map<string, { signature: string; version: string }>();
	let cleanupPicker = () => { credentialSalt.fill(0); credentialVersions.clear(); store.lock(); };

	let cur = ctx.model;
	let curId = cur ? `${cur.provider}/${cur.id}` : "";

	// name 字段常自带“(渠道名)”后缀,剥掉——渠道身份由行首独家承担
	const cleanName = (raw: string): string => {
		const stripped = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
		return stripped || raw;
	};

	function makeRows(): Row[] {
		const result: Row[] = all.map((m) => ({ model: m, fullId: `${m.provider}/${m.id}`, name: cleanName(m.name || m.id), id: m.id, provider: String(m.provider), spec: buildSpec(m), available: true }));
		const known = new Set(result.map((r) => r.fullId));
		for (const p of custom) for (const m of p.models) {
			const fullId = `${p.id}/${m.id}`;
			if (known.has(fullId)) continue;
			const model = ctx.modelRegistry.find?.(p.id, m.id) ?? { ...m, provider: p.id, name: m.name || m.id, api: p.api, contextWindow: m.contextWindow ?? 128000, maxTokens: m.maxTokens ?? 8192, input: m.input ?? ["text"], reasoning: m.reasoning ?? false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
			result.push({ model, fullId, name: cleanName(m.name || m.id), id: m.id, provider: p.id, spec: `${buildSpec(model)} · 未就绪`, available: false });
			known.add(fullId);
		}
		return result;
	}
	let rows: Row[] = makeRows();
	// Display labels are not identities: references, favorites and ordering keep IDs.
	function providerLabel(id: string): string { return custom.find((p) => p.id === id)?.name || id; }

	// 排序材料:自定义声明 > 默认模型 > 收藏 > 使用频率 > 配置序
	const order = loadOrder();
	const favs = loadFavorites();
	let defaultRef = loadDefaultRef();
	let defaultId = defaultRef ? `${defaultRef.provider}/${defaultRef.id}` : "";
	let paletteIdx = loadPaletteIndex();
	// 打开即同步:provider 退出后的死条目当场清洗并落盘
	if (customReadable && syncPersisted(order, favs, all)) {
		saveOrder(order);
		saveFavorites(favs);
	}
	const usage = collectUsage();

	let rankOfProvider = new Map<string, number>();
	let rankDeclared = new Map<string, number>();

	// provider 行序与模型声明序可从面板移动后重建(移动即写 order 文件)
	function rebuildRanks() {
		const providerSeq: string[] = [];
		for (const p of order.providers ?? []) {
			if (!providerSeq.includes(p)) providerSeq.push(p);
		}
		for (const m of rows) {
			const p = String(m.provider);
			if (!providerSeq.includes(p)) providerSeq.push(p);
		}
		for (const p of custom) if (!providerSeq.includes(p.id)) providerSeq.push(p.id);
		rankOfProvider = new Map(providerSeq.map((p, i) => [p, i]));
		const declaredSeq: string[] = [];
		for (const p of providerSeq) {
			for (const id of order.models?.[p] ?? []) {
				const fid = `${p}/${id}`;
				if (!declaredSeq.includes(fid)) declaredSeq.push(fid);
			}
		}
		rankDeclared = new Map(declaredSeq.map((f, i) => [f, i]));
	}
	rebuildRanks();

	const configSeq: string[] = [];
	for (const m of rows) {
		const fid = `${m.provider}/${m.id}`;
		if (!configSeq.includes(fid)) configSeq.push(fid);
	}
	const rankConfig = new Map(configSeq.map((f, i) => [f, i]));

	// 面板即编辑器:移动后把当前顺序写入 order 文件,面板操作与持久层统一
	function persistModelOrder(pr: PRow) {
		order.models = order.models ?? {};
		order.models[pr.provider] = mergeVisibleOrder(order.models[pr.provider] ?? [], pr.models.map((m) => m.id));
		rebuildRanks();
		saveOrder(order);
	}
	function persistProviderOrder() {
		order.providers = mergeVisibleOrder(order.providers ?? [], browse.map((r) => r.provider));
		rebuildRanks();
		saveOrder(order);
	}

	// 行内比较器:自定义声明 > 默认模型 > 收藏 > 频率(count→lastUsed) > 配置序
	function cmpRow(a: Row, b: Row): number {
		const da = rankDeclared.get(a.fullId);
		const db = rankDeclared.get(b.fullId);
		if (da !== undefined || db !== undefined) {
			if (da === undefined) return 1;
			if (db === undefined) return -1;
			return da - db;
		}
		// 默认模型档:settings.json 钦定,次于手动声明,先于收藏
		const ga = a.fullId === defaultId ? 0 : 1;
		const gb = b.fullId === defaultId ? 0 : 1;
		if (ga !== gb) return ga - gb;
		const fa = favs.has(a.fullId) ? 0 : 1;
		const fb = favs.has(b.fullId) ? 0 : 1;
		if (fa !== fb) return fa - fb;
		const ua = usage.get(a.fullId);
		const ub = usage.get(b.fullId);
		const ca = ua?.count ?? 0;
		const cb = ub?.count ?? 0;
		if (ca !== cb) return cb - ca;
		const la = ua?.lastUsed ?? 0;
		const lb = ub?.lastUsed ?? 0;
		if (la !== lb) return lb - la;
		return rankConfig.get(a.fullId)! - rankConfig.get(b.fullId)!;
	}

	// 浏览态分组，凭据缺失或尚无模型的自定义行仍可从原面板修复。
	const byProvider = new Map<string, Row[]>();
	let browse: PRow[] = [];
	let headW = 13;
	function rebuildData() {
		rebuildRanks();
		rankConfig.clear();
		rows.forEach((r, i) => rankConfig.set(r.fullId, i));
		byProvider.clear();
		for (const r of rows) {
			const list = byProvider.get(r.provider) ?? [];
			list.push(r); byProvider.set(r.provider, list);
		}
		for (const p of custom) if (!byProvider.has(p.id)) byProvider.set(p.id, []);
		for (const list of byProvider.values()) list.sort(cmpRow);
		browse = [...byProvider.entries()].map(([provider, models]) => ({ provider, models })).sort((a, b) => rankOfProvider.get(a.provider)! - rankOfProvider.get(b.provider)!);
		headW = Math.min(20, Math.max(10, ...[...byProvider.keys()].map((p) => visibleWidth(providerLabel(p)) + 1))) + 3;
	}
	rebuildData();

	let picked: Model<Api> | null;
	try { picked = (await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result: Model<Api> | null) => void) => {
		let q = "";
		const queryInput = new Input({ prompt: "› ", placeholder: "输入模型名或供应商名过滤…", placeholderStyle: (s) => theme.fg("muted", s) });
		let queryPasting = false; let queryPasteTail = "";
		let disp: PRow[] = browse;
		let selR = 0;
		let selC = 0;
		let top = 0;
		let focus: "model" | "provider" = initialProviderFocus || browse.length === 0 ? "provider" : "model";
		let leftArmed = false;
		let locateTarget: { provider: string; id?: string } | null = null;
		const pageSize = () => Math.max(1, Math.min(18, (tui.terminal?.rows ?? 32) - 7));

		// 操作反馈:提示行短暂替换为 flash 消息,2 秒后自动复原
		let disposed = false;
		let pickerFocused = true;
		let flashMsg = "";
		let flashErr = false;
		let flashTimer: ReturnType<typeof setTimeout> | null = null;
		function flash(msg: string, isErr = false) {
			flashMsg = msg;
			flashErr = isErr;
			if (flashTimer) clearTimeout(flashTimer);
			flashTimer = setTimeout(() => {
				if (disposed) return;
				flashMsg = "";
				tui.requestRender();
			}, 2000);
		}

		function rebuild(anchorId?: string, preserveView = false, anchorProvider?: string) {
			const old = { r: selR, c: selC, top };
			if (!q.trim()) {
				disp = browse;
			} else {
				// fuzzyFilter 返回按匹配质量排序的原数组,支持空格分词
				const hits = fuzzyFilter(rows, q, (r) => `${r.name} ${r.id} ${r.provider} ${providerLabel(r.provider)}`);
				const firstHitAt = new Map<string, number>();
				const groups = new Map<string, Row[]>();
				hits.forEach((h, i) => {
					if (!groups.has(h.provider)) {
						groups.set(h.provider, []);
						firstHitAt.set(h.provider, i);
					}
					groups.get(h.provider)!.push(h);
				});
				for (const draft of fuzzyFilter(browse.filter((r) => r.models.length === 0), q, (r) => `${r.provider} ${providerLabel(r.provider)}`)) {
					groups.set(draft.provider, []); firstHitAt.set(draft.provider, hits.length);
				}
				disp = [...groups.entries()]
					.map(([provider, models]) => ({ provider, models }))
					.sort((a, b) => firstHitAt.get(a.provider)! - firstHitAt.get(b.provider)!);
			}
			// A truly empty registry differs from an empty search result.
			if (browse.length === 0) focus = "provider";
			leftArmed = false;
			const page = pageSize();
			// 光标锚定:初始/收藏切换后定位到指定模型;搜索时归零到最优命中
			selR = 0;
			selC = 0;
			top = 0;
			if (preserveView) { selR = Math.max(0, Math.min(old.r, disp.length - 1)); selC = old.c; }
			let anchored = false;
			if (anchorId) {
				for (let r = 0; r < disp.length; r++) {
					const c = disp[r].models.findIndex((m) => m.fullId === anchorId);
					if (c >= 0) {
						selR = r; selC = c; anchored = true;
						if (selR >= page) top = selR - page + 1;
						break;
					}
				}
			}
			if (!anchored && anchorProvider) {
				const r = disp.findIndex((p) => p.provider === anchorProvider);
				if (r >= 0) selR = r;
			}
			if (preserveView) {
				clampCol();
				top = Math.max(0, Math.min(old.top, Math.max(0, disp.length - page)));
				if (selR < top) top = selR;
				if (selR >= top + page) top = selR - page + 1;
			}
		}
		rebuild(curId);

		function clampCol() {
			const pr = disp[selR];
			if (!pr) {
				selC = 0;
				return;
			}
			selC = Math.max(0, Math.min(selC, pr.models.length - 1));
		}

		function actionTarget() {
			const pr = disp[selR];
			return { kind: focus, provider: pr?.provider, ...(focus === "model" ? { modelId: pr?.models[selC]?.id } : {}) };
		}

		function guardSnapshot(): Guard {
			const live = ctx.model;
			const defaults = readDefaultState();
			return { current: live ? { provider: String(live.provider), id: live.id } : undefined, default: defaults.ref ?? undefined, defaultUnknown: !defaults.known, busy: ctx.isIdle ? !ctx.isIdle() : false };
		}

		function canUseLiveModel(ref: DefaultRef): boolean {
			try {
				if (disposed || store.hasPending()) return false;
				if (!ctx.modelRegistry.getAvailable().some((m: Model<Api>) => String(m.provider) === ref.provider && m.id === ref.id)) return false;
				return protectedProviders.has(ref.provider) || store.snapshot().providers.some((p) => p.id === ref.provider && p.models.some((m) => m.id === ref.id));
			} catch { return false; }
		}

		const actions = new PickerActions({
			store, records,
			fast: fast ? { snapshot: () => fast.snapshot(ctx), setTier: (tier) => fast.setTier(tier, ctx), describe: () => fast.describe(ctx) } : undefined,
			providerLabel,
			isProtected: (provider) => protectedProviders.has(provider),
			feedback: (message, error) => { flash(message, error); if (!disposed) tui.requestRender(); },
			catalog: () => ctx.modelRegistry.getAll?.() ?? all,
			available: () => ctx.modelRegistry.getAvailable(),
			replace: async (ref, targets, expected = guardSnapshot()) => {
				const before = guardSnapshot();
				if (disposed || before.busy || before.defaultUnknown || (targets.current && !sameRef(before.current, expected.current)) || (targets.default && !sameRef(before.default, expected.default))) throw new Error("Replacement unavailable");
				const candidate = ctx.modelRegistry.getAvailable().find((m: Model<Api>) => String(m.provider) === ref.provider && m.id === ref.id);
				if (!candidate || !canUseLiveModel(ref)) throw new Error("Replacement unavailable");
				if (targets.default) protection.seal({ kind: "model-pick-default-preflight", version: 1 }, "settings");
				if (targets.current) {
					if (!(await pi.setModel(candidate))) throw new Error("Replacement unavailable");
					cur = ctx.model; curId = cur ? `${cur.provider}/${cur.id}` : "";
				}
				const after = guardSnapshot();
				if (disposed || after.busy || after.defaultUnknown || !canUseLiveModel(ref) || (targets.current && !sameRef(after.current, ref)) || (targets.default && !sameRef(after.default, expected.default))) throw new Error("Replacement unavailable");
				if (targets.default) {
					if (!writeDefaultModel(ref.provider, ref.id, protection, expected.default ?? null, () => canUseLiveModel(ref))) throw new Error("Replacement unavailable");
					defaultRef = { ...ref }; defaultId = `${ref.provider}/${ref.id}`;
					for (const list of byProvider.values()) list.sort(cmpRow);
				}
			},
			guard: () => ({ ...guardSnapshot(), recheck: guardSnapshot }),
			requestRender: () => { if (!disposed) tui.requestRender(); },
			flushRender: () => { if (!disposed) tui.renderNow?.(); },
			paint: (kind, value) => theme.fg(kind === "dim" ? "muted" : kind, value),
			changed: async (target) => {
				const anchor = disp[selR]?.models[selC]?.fullId;
				const anchorProvider = disp[selR]?.provider;
				const previousModels = new Set(rows.map((r) => r.fullId));
				const previousProviders = new Set(browse.map((r) => r.provider));
				await ctx.modelRegistry.refresh?.({ allowNetwork: false });
				if (disposed) return;
				custom = store.snapshot().providers; customReadable = true;
				all = ctx.modelRegistry.getAvailable(); rows = makeRows(); rebuildData(); rebuild(anchor, true, anchorProvider);
				const added = rows.find((r) => !previousModels.has(r.fullId));
				const addedProvider = browse.find((r) => !previousProviders.has(r.provider));
				const requested = target ? browse.find((p) => p.provider === target.provider) : undefined;
				locateTarget = requested ? { provider: requested.provider, id: target?.modelId ?? requested.models[0]?.id }
					: added ? { provider: added.provider, id: added.id } : addedProvider ? { provider: addedProvider.provider } : null;
			},
			auth: async (provider, modelId) => {
				const cfg = store.snapshot(); const p = cfg.providers.find((entry) => entry.id === provider);
				const model = modelId ? ctx.modelRegistry.find?.(provider, modelId) : (ctx.modelRegistry.getAll?.() ?? all).find((m: Model<Api>) => String(m.provider) === provider);
				const endpoint = model?.baseUrl || p?.endpoint;
				if (!endpoint) throw new ProbeError("protocol");
				validateEndpoint(endpoint);
				const api = model?.api || p?.api;
				if (!["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(api)) throw new ProbeError("unsupported");
				const resolved = await ctx.modelRegistry.getApiKeyAndHeaders({ ...model, provider, id: modelId || model?.id || "catalog", api, baseUrl: endpoint });
				if (disposed) throw new ProbeError("cancelled");
				if (!resolved?.ok) throw new ProbeError("auth");
				if (resolved.baseUrl && validateEndpoint(resolved.baseUrl).toString() !== validateEndpoint(endpoint).toString()) throw new ProbeError("protocol");
				const headers: Record<string, string> = { ...(resolved.headers ?? {}) };
				const has = (key: string) => Object.keys(headers).some((h) => h.toLowerCase() === key);
				if (resolved.apiKey) {
					if (api === "anthropic-messages" && !has("x-api-key") && !has("authorization")) headers["x-api-key"] = resolved.apiKey;
					else if (api === "google-generative-ai" && !has("x-goog-api-key")) headers["x-goog-api-key"] = resolved.apiKey;
					else if (!has("authorization") && api !== "anthropic-messages" && api !== "google-generative-ai") headers.authorization = `Bearer ${resolved.apiKey}`;
				}
				const signature = createHmac("sha256", credentialSalt).update(JSON.stringify(headers)).digest("hex");
				let version = credentialVersions.get(provider);
				if (!version || version.signature !== signature) { version = { signature, version: randomUUID() }; credentialVersions.set(provider, version); }
				return { scope: { provider, modelId: modelId || model?.id || "catalog", endpoint, api, credentialVersion: `${cfg.revision}:${version.version}` }, headers };
			},
		});
		const unsubscribeFast = fast?.subscribe(() => { if (!disposed) { actions.refreshFast(); tui.requestRender(); } });
		cleanupPicker = () => { disposed = true; unsubscribeFast?.(); if (flashTimer) clearTimeout(flashTimer); actions.dispose(); credentialSalt.fill(0); credentialVersions.clear(); };
		if (initialFast && fast) actions.openFast();
		else if (initialActions) actions.open(actionTarget());

		function editQuery(data: string) {
			queryInput.handleInput(data);
			if (q !== queryInput.getValue()) { q = queryInput.getValue(); rebuild(); }
			tui.requestRender();
		}
		function handleInput(data: string) {
			if (!pickerFocused) return;
			if (actions.active) { leftArmed = false; actions.handleInput(data); return; }
			if (queryPasting || data.includes("\x1b[200~")) {
				queryPasting = !(queryPasteTail + data).includes("\x1b[201~");
				queryPasteTail = queryPasting ? (queryPasteTail + data).slice(-5) : "";
				leftArmed = false; editQuery(data); return;
			}
			if (isKeyRelease(data)) return;
			if (isKeyRepeat(data) && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))) return;
			const isLeft = matchesKey(data, Key.left);
			if (!isLeft) leftArmed = false;
			if (matchesKey(data, Key.alt("n"))) {
				if (isKeyRepeat(data)) return;
				if (focus === "model" && !disp[selR]) return;
				actions.open(actionTarget(), "add"); return;
			}
			if (matchesKey(data, Key.alt("x"))) {
				if (isKeyRepeat(data)) return;
				const target = actionTarget();
				if (!target.provider || (focus === "model" && !target.modelId)) return;
				actions.open(target, "remove"); return;
			}
			if (matchesKey(data, Key.alt("l"))) {
				if (!locateTarget || isKeyRepeat(data)) return;
				q = ""; queryInput.setValue(""); focus = locateTarget.id ? "model" : "provider";
				rebuild(locateTarget.id ? `${locateTarget.provider}/${locateTarget.id}` : undefined, false, locateTarget.provider);
				locateTarget = null; tui.requestRender(); return;
			}
			if (matchesKey(data, Key.alt("z"))) { if (!isKeyRepeat(data) && actions.undoLabel) actions.undoLast(); return; }
			if (matchesKey(data, Key.alt("m"))) { if (!isKeyRepeat(data)) actions.open(actionTarget()); return; }
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				done(null);
				return;
			}
			// Alt+D:把光标模型写为 settings.json 默认模型(幂等;原子写+滚动备份)
			if (matchesKey(data, Key.alt("d"))) {
				if (focus === "provider") return;
				const r = disp[selR]?.models[selC];
				if (!r) return;
				if (!r.available) { flash("模型未就绪，不能设为默认；请先配置凭据", true); tui.requestRender(); return; }
				if (r.fullId === defaultId) return;
				if (!canUseLiveModel({ provider: r.provider, id: r.id })) { flash("模型配置已变化或上次修改未完成；请先核对", true); tui.requestRender(); return; }
				if (writeDefaultModel(r.provider, r.id, protection, undefined, () => canUseLiveModel({ provider: r.provider, id: r.id }))) {
					defaultRef = { provider: r.provider, id: r.id };
					defaultId = r.fullId;
					// 默认档易主,浏览态行内重排并锚定新默认
					for (const list of byProvider.values()) list.sort(cmpRow);
					rebuild(r.fullId);
					flash(`默认 → ${r.fullId}`);
				} else {
					flash("默认设置写入未确认完成，请重新打开检查", true);
				}
				tui.requestRender();
				return;
			}
			// Alt+T:循环切换配色主题(即时生效,写入 model-pick-theme.json)
			if (matchesKey(data, Key.alt("t"))) {
				paletteIdx = (paletteIdx + 1) % PALETTES.length;
				savePaletteIndex(paletteIdx);
				flash(`主题 → ${PALETTES[paletteIdx]!.name}`);
				tui.requestRender();
				return;
			}
			// Tab 切换收藏:空闲键、无字符语义,picker 已实证可用
			if (matchesKey(data, Key.tab)) {
				if (focus === "provider") return;
				const m = disp[selR]?.models[selC];
				if (m) {
					if (favs.has(m.fullId)) favs.delete(m.fullId);
					else favs.add(m.fullId);
					saveFavorites(favs);
					// 收藏改变行内排序,重排后光标跟随该模型
					for (const list of byProvider.values()) list.sort(cmpRow);
					rebuild(m.fullId);
					tui.requestRender();
				}
				return;
			}
			// Alt+←/→:行内移动模型(仅浏览态;移动即写入 order 文件)
			// 注:altScreen 系键(搜索/prompt 跳转/翻页)被 TUI 主循环全局拦截,组件收不到;
			// Ctrl+Shift+←→ 与 Alt 系在组件层可达,选 Alt 四件套求对称
			if (matchesKey(data, Key.alt("left")) || matchesKey(data, Key.alt("right"))) {
				if (focus === "provider" || q.trim() || disp.length === 0) return;
				const pr = disp[selR];
				if (!pr) return;
				const dir = matchesKey(data, Key.alt("left")) ? -1 : 1;
				const ni = selC + dir;
				if (ni < 0 || ni >= pr.models.length) return;
				const list = pr.models;
				const tmp = list[selC];
				list[selC] = list[ni];
				list[ni] = tmp;
				selC = ni;
				persistModelOrder(pr);
				tui.requestRender();
				return;
			}
			// Alt+↑/↓:移动 provider 行(仅浏览态)
			if (matchesKey(data, Key.alt("up")) || matchesKey(data, Key.alt("down"))) {
				if (q.trim() || disp.length === 0) return;
				const dir = matchesKey(data, Key.alt("up")) ? -1 : 1;
				const nr = selR + dir;
				if (nr < 0 || nr >= disp.length) return;
				const tmp = disp[selR];
				disp[selR] = disp[nr];
				disp[nr] = tmp;
				selR = nr;
				persistProviderOrder();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete) || matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("w")) || matchesKey(data, Key.home) || matchesKey(data, Key.end)) { editQuery(data); return; }
			if (!matchesKey(data, Key.up) && !matchesKey(data, Key.down) && !isLeft && !matchesKey(data, Key.right) && !matchesKey(data, Key.enter)) { editQuery(data); return; }
			if (disp.length === 0) return;
			// 首尾循环:搜索态同样只在当前匹配行中环绕,并保持目标行可见。
			if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
				const direction = matchesKey(data, Key.up) ? -1 : 1;
				selR = (selR + direction + disp.length) % disp.length;
				clampCol();
				const page = pageSize();
				if (selR < top) top = selR;
				if (selR >= top + page) top = selR - page + 1;
				tui.requestRender(); return;
			}
			if (isLeft) {
				if (focus === "model") {
					if (selC > 0) { selC--; leftArmed = false; }
					else if (isKeyRepeat(data)) leftArmed = false;
					else if (leftArmed) { focus = "provider"; leftArmed = false; }
					else leftArmed = true;
				}
				tui.requestRender(); return;
			}
			if (matchesKey(data, Key.right)) {
				if (focus === "provider") { focus = "model"; selC = 0; }
				else selC = Math.max(0, Math.min(disp[selR].models.length - 1, selC + 1));
				tui.requestRender(); return;
			}
			if (matchesKey(data, Key.enter)) {
				if (focus === "provider") { actions.open(actionTarget()); return; }
				if (disp[selR] && !disp[selR].models.length) { actions.open(actionTarget(), "add"); return; }
				try { if (store.hasPending()) { flash("上次修改未完成；Alt+M 处理后再切换", true); tui.requestRender(); return; } }
				catch { flash("安全存档状态异常；请先从 Alt+M 检查", true); tui.requestRender(); return; }
				const r = disp[selR]?.models[selC];
				if (r?.available) done(r.model);
				else if (r) { flash("模型未就绪；Alt+M 查看配置或凭据引用", true); tui.requestRender(); }
				return;
			}
		}

		function renderRow(pr: PRow, isSelRow: boolean, w: number): string {
			const providerSelected = isSelRow && focus === "provider";
			if (!pr.models.length) return truncateToWidth(rgbFg(PALETTES[paletteIdx]![isSelRow ? "accent" : "dim"], `${isSelRow ? " ▸ " : "   "}${providerSelected ? `[${providerLabel(pr.provider)}]` : providerLabel(pr.provider)}  ${isSelRow && focus === "model" ? "› " : ""}[添加模型] · 尚无模型`), w - 1, "");
			const avail = Math.max(40, w - 1 - headW);
			const cellW = Math.min(30, Math.max(14, Math.floor(avail / 6)));
			const nameW = cellW - 3; // 前缀 1 + 空格 1 + ★ 预留 1
			const len = pr.models.length;
			// 窗口:非选中行从行首贪心填充;选中行以光标格为右锚回退(保证选中格可见)
			let start = 0;
			if (isSelRow && selC > 0) {
				start = selC;
				while (start > 0 && (selC - start + 1) * cellW <= avail) start--;
				if ((selC - start + 1) * cellW > avail) start = selC; // 极端:独格也超宽,只显示自己
			}

			const pal = PALETTES[paletteIdx]!;
			const shortProvider = shortenMiddle(providerSelected ? `[${providerLabel(pr.provider)}]` : providerLabel(pr.provider), headW - 4);
			let head =
				(isSelRow ? rgbFg(pal.accent, " ▸ ") : "   ") +
				rgbFg(providerSelected ? pal.sel : isSelRow ? pal.accent : pal.dim,
					shortProvider + " ".repeat(Math.max(0, headW - 4 - visibleWidth(shortProvider))));
			// 左溢出标记塞进行首末尾,不占格子位
			head += start > 0 ? rgbFg(pal.dim, "‹") : " ";

			let line = head;
			let idx = start;
			while (idx < len && (idx - start + 1) * cellW <= avail) {
				const m = pr.models[idx];
				const isSel = isSelRow && focus === "model" && idx === selC;
				const isCur = m.fullId === curId;
				const isFav = favs.has(m.fullId);
				const raw = shortenMiddle(m.name, nameW);
				const label = (isSel ? "›" : isCur ? "●" : " ") + " " + raw + (isFav ? "★" : "");
				// 配色主题制:cur/def/fav/框线色标由 PALETTES 调色板统辖(Alt+T 循环);
				// sel/普通沿用主题槽(accent/text)贴全局主题;真彩直写不经主题槽。
				// 显色优先级:当前>收藏>光标>默认>普通(收藏身份稳定,光标扫过不变色)。
				const isDef = m.fullId === defaultId;
				const padded = label + " ".repeat(Math.max(0, cellW - visibleWidth(label)));
				const cell = isCur
					? theme.bold(rgbFg(pal.cur, padded))
					: isFav
						? rgbFg(pal.fav, padded)
						: isSel
							? rgbFg(pal.sel, padded)
							: isDef
								? rgbFg(pal.def, padded)
								: rgbFg(pal.text, padded);
				line += cell;
				idx++;
			}
			if (idx < len) line += rgbFg(pal.dim, `+${len - idx}`);
			return truncateToWidth(line, w - 1, "");
		}

		function render(w: number): string[] {
			cur = ctx.model; curId = cur ? `${cur.provider}/${cur.id}` : "";
			const out: string[] = [];
			const pal = PALETTES[paletteIdx]!;
			const hr = frameGradient("─".repeat(Math.max(1, w - 1)), pal.stops, pal.steps);
			const hitCount = q.trim() ? disp.reduce((n, pr) => n + pr.models.length, 0) : null;

			const title =
				" " + rgbFg(pal.accent, BRAND) +
				rgbFg(pal.dim, ` · ${ROLE} (${hitCount === null ? rows.length : `${hitCount}/${rows.length}`})`) +
				(defaultRef ? rgbFg(pal.dim, `  ·  默认 ${defaultRef.id}`) : "");
			out.push(truncateToWidth(title, w - 1, ""));
			out.push(hr);
			queryInput.focused = pickerFocused && !actions.active;
			out.push(truncateToWidth(` ${queryInput.render(Math.max(1, w - 2))[0] ?? ""}`, w - 1, ""));
			out.push(hr);

			if (actions.active) {
				// One focused task, not a form squeezed under another search field.
				const height = Math.max(5, Math.min(28, tui.terminal?.rows ?? 32));
				const border = theme.fg("border", "─".repeat(Math.max(1, w - 1)));
				return [border, ...actions.render(w, height - 2), border];
			}
			const page = pageSize();
			top = Math.max(0, Math.min(top, Math.max(0, disp.length - page)));
			if (selR < top) top = selR;
			if (selR >= top + page) top = selR - page + 1;
			const windowRows = disp.slice(top, top + page);
			for (let ri = 0; ri < windowRows.length; ri++) {
				out.push(renderRow(windowRows[ri], top + ri === selR, w));
			}
			if (disp.length === 0) out.push(rgbFg(pal.dim, !customReadable ? "   自定义配置无法读取；未清理收藏/排序，请先检查配置。" : browse.length ? "   无匹配模型 · 调整搜索以选择供应商/模型" : "   暂无供应商 · Alt+N 添加供应商及模型 · Alt+M 更多"));
			// 窗口高度固定(浏览态行数封顶 PAGE),搜索收缩不跳版
			const fixedWindow = Math.min(browse.length, page);
			const filled = windowRows.length + (disp.length === 0 ? 1 : 0);
			for (let i = filled; i < fixedWindow; i++) out.push("");

			const selModel = disp[selR]?.models[selC];
			const provider = disp[selR]?.provider;
			const providerModels = provider ? browse.find((p) => p.provider === provider)?.models.length ?? 0 : 0;
			const detail = focus === "provider"
				? ` 供应商「${provider ? providerLabel(provider) : browse.length ? "无匹配" : "尚未添加"}」${provider && providerLabel(provider) !== provider ? ` · ${provider}` : ""} · ${providerModels} 个模型`
				: selModel
					? ` ${selModel.fullId === curId ? "● " : ""}${selModel.name}${favs.has(selModel.fullId) ? " ★" : ""}${selModel.fullId === defaultId ? " ◆默认" : ""}${selModel.spec ? ` · ${selModel.spec}` : ""}`
					: provider ? ` ${provider} · 尚无模型，Alt+N 或 Enter 添加模型` : "";
			out.push(hr);
			out.push(truncateToWidth(rgbFg(pal.dim, detail), w - 1, ""));
			const mutable = provider && !protectedProviders.has(provider) && custom.some((p) => p.id === provider);
			const taskHint = (w < 64 ? "Enter 操作 · Alt+M 菜单"
				: focus === "provider" ? `Enter 操作 · Alt+N 新供应商${mutable ? " · Alt+X 移除" : ""} · → 模型`
				: `Enter 切换${mutable ? " · Alt+N 添加 · Alt+X 移除" : ""} · Alt+M 菜单`) + (fast && w >= 80 ? " · 会话 Fast" : "");
			const auxiliary = [actions.undoLabel ? "Alt+Z 撤销移除" : "", locateTarget ? "Alt+L 定位新增/恢复项" : ""].filter(Boolean).join(" · ");
			const hint = leftArmed
				? rgbFg(pal.accent, " 再按一次 ← 操作此供应商；其他操作取消准备")
				: flashMsg
					? (flashErr ? theme.fg("error", ` ${auxiliary ? `${auxiliary} · ` : ""}${flashMsg}`) : rgbFg(pal.accent, ` ${auxiliary ? `${auxiliary} · ` : ""}${flashMsg}`))
					: rgbFg(pal.dim, ` ${auxiliary ? `${auxiliary} · ` : ""}${taskHint}`);
			out.push(truncateToWidth(hint, w - 1, ""));
			return out;
		}

		return { render, invalidate: () => {}, handleInput, get focused() { return pickerFocused; }, set focused(value: boolean) { pickerFocused = value; if (!value) { leftArmed = false; if (queryPasting) { queryPasting = false; queryPasteTail = ""; editQuery("\x1b[201~"); } } queryInput.focused = value && !actions.active; actions.setFocused(value); } };
	})) as Model<Api> | null; } finally { cleanupPicker(); }

	if (picked === null) return;
	const ok = await pi.setModel(picked);
	if (ok) {
		ctx.ui.notify(`已切换到 ${picked.provider}/${picked.id}`, "success");
	} else {
		ctx.ui.notify(`切换失败(该渠道缺少凭据?)`, "error");
	}
}

/** Isolated UX candidate. Never registers against an ordinary user HOME. */
export default function modelPickExtension(pi: ExtensionAPI, options: { fast?: FastController } = {}) {
	pi.registerCommand("models", {
		description: "Hibiki · 模型工作台：Alt+N/X 按焦点增删；首格两次←操作供应商，→返回模型；Alt+M 更多与会话 Fast",
		handler: async (args: string, ctx: any) => {
			const action = args.trim();
			if (action && !["manage", "providers", "fast"].includes(action)) { ctx.ui.notify("用法：/models [manage|providers|fast]", "info"); return; }
			await openPicker(pi, ctx, action === "manage" || action === "providers", action === "providers", options.fast, action === "fast");
		},
	});
	pi.registerShortcut("ctrl+l", {
		description: "Hibiki · 模型工作台 — 打开模型矩阵",
		handler: async (ctx) => {
			await openPicker(pi, ctx, false, false, options.fast);
		},
	});
}
