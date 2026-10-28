import { decodeKittyPrintable, Input, isKeyRelease, isKeyRepeat, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { PickerStore, StoreError, type Guard, type ModelInput, type ProviderInput } from "./store.js";
import { findModelTemplate, resolveModelFields, type Scope } from "./reference.js";
import { discoverModels, probeText, withProbeDeadline, ProbeError, type ProbeCode, type ProbeReport } from "./probe.js";
import { PickerRecords, RecordError } from "./records.js";
import { ModelBasket, NativeMenu } from "./controls.js";
import type { FastController } from "../fast.js";

export interface ActionTarget { provider?: string; modelId?: string; kind?: "model" | "provider"; }
export interface ActionHost {
	store: PickerStore;
	records: PickerRecords;
	catalog(): Array<{ provider: string; id: string; [key: string]: any }>;
	guard(): Guard;
	changed(target?: { provider: string; modelId?: string }): Promise<void>;
	requestRender(): void;
	flushRender?(): void;
	auth(provider: string, modelId?: string): Promise<{ scope: Scope; headers: Record<string, string> }>;
	paint(kind: "accent" | "text" | "dim" | "error", value: string): string;
	isProtected?(provider: string): boolean;
	feedback?(message: string, error?: boolean): void;
	replace?(modelRef: { provider: string; id: string }, targets: { current: boolean; default: boolean }, expected?: Guard): Promise<void>;
	available?(): Array<{ provider: string; id: string; name?: string }>;
	providerLabel?(provider: string): string;
	fast?: {
		snapshot(): ReturnType<FastController["snapshot"]>;
		setTier(tier: Parameters<FastController["setTier"]>[0]): boolean;
		describe(): string;
	};
}
interface Item { label: string; run(): void; }
interface Field { id: string; label: string; input?: Input; choices?: string[]; choice?: number; hint?: string; }
interface DraftModel { model: ModelInput; resolved: ReturnType<typeof resolveModelFields>; scopeKey: string; manual?: Partial<ModelInput>; }
type View =
	| { kind: "menu"; title: string; items: Item[]; selected: number; native?: NativeMenu; notes?: string[]; fastOrigin?: View | null; back(): void }
	| { kind: "models"; title: string; basket: ModelBasket; activate(): void; back(): void }
	| { kind: "form"; title: string; fields: Field[]; selected: number; notes: string[]; error: string; saveLabel: string; pasting?: boolean; pasteTail?: string; extras?: () => Item[]; save(values: Record<string, string>): void; back(): void }
	| { kind: "report"; title: string; lines: string[]; offset: number; back(): void }
	| { kind: "busy"; title: string; abort: AbortController; cancellable?: boolean; back(): void };
const APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
const API_NAMES: Record<string, string> = { "openai-completions": "OpenAI · Chat Completions", "openai-responses": "OpenAI · Responses", "anthropic-messages": "Anthropic · Messages", "google-generative-ai": "Google · Gemini" };
const FIELD_NAMES: Record<string, string> = { name: "显示名", contextWindow: "上下文", maxTokens: "输出上限", reasoning: "思考能力", input: "输入类型" };
const SOURCE_NAMES: Record<string, string> = { tested: "有效实测", manual: "人工配置", provider: "渠道目录", generic: "通用模板", default: "保守默认·待确认" };
const CODE_NAMES: Record<ProbeCode, string> = { ok: "文本连通性通过", auth: "鉴权失败，请检查凭据", limited: "上游限流，本次无法判断", server: "上游暂时异常", protocol: "协议/响应未确认", timeout: "请求超时", cancelled: "已取消", network: "网络请求未完成", unsupported: "此协议尚未接入测试" };
function input(value = ""): Input {
	const field = new Input({ prompt: "" });
	field.setValue(value);
	field.handleInput("\u001b[F"); // Pre-filled fields start at their end, not before the existing value.
	return field;
}
function safeMessage(error: unknown): string {
	if (error instanceof StoreError) return ({ BUSY: "正在运行请求，请结束后再修改。", PROTECTED: "这个供应商由 Pi 或扩展管理，不能在这里修改。", CURRENT_MODEL: "当前正在使用这个模型，请先切换。", DEFAULT_MODEL: "这个模型仍是默认模型，请先更换默认。", DEFAULT_UNKNOWN: "无法确认默认模型，暂不移除。", CONFLICT: "配置已在别处变化，请返回重新核对。", EXISTS: "供应商或模型已存在，不会覆盖。", NOT_FOUND: "这个对象已变化，请返回重新选择。", PENDING: "上次修改尚未完成，请先处理。", LEGACY_PENDING: "旧版修改尚未完成，需要单独处理；旧记录已保留。", INVALID_CONFIG: "无法读取当前配置，未继续修改。", INVALID_VAULT: "无法读取历史记录，未继续修改。", INVALID_INDEX: "历史记录信息异常，未继续修改。", UNSAFE_PATH: "配置路径不安全，已停止修改。", INVALID_INPUT: "请检查填写内容。", IO_ERROR: "保存未能完成，请核对当前状态。" } as Record<string, string>)[error.code] ?? "修改未能完成。";
	if (error instanceof RecordError) return "无法安全保存，当前输入已保留。";
	if (error instanceof ProbeError) return CODE_NAMES[error.code];
	return "操作未完成，当前输入已保留。";
}
function text(value: unknown): string { return String(value ?? "").replace(/[\u0000-\u001f\u007f\u009b]/gu, "").slice(0, 512); }

/** One temporary flow in the original custom UI. No new TUI, editor or tool is installed. */
export class PickerActions {
	private view: View | null = null;
	private target: ActionTarget = {};
	private focused = true;
	private disposed = false;
	private epoch = 0;
	constructor(private readonly host: ActionHost) {}
	get active(): boolean { return this.view !== null; }
	setFocused(value: boolean): void {
		this.focused = value;
		if (this.view?.kind === "models") this.view.basket.setFocused(value);
		if (!value && this.view?.kind === "form" && this.view.pasting) {
			this.view.fields[this.view.selected]?.input?.handleInput("\x1b[201~");
			this.view.pasting = false; this.view.pasteTail = "";
		}
	}
	private undo: { id: string; revision: string; label: string; provider: string; modelId?: string } | null = null;
	private replacementApplied = false;
	private directTask = false;
	private removalOrigin: View | null = null;
	private cancelAfterRequest = false;
	get undoLabel(): string | null { return this.undo?.label ?? null; }
	undoLast(): void {
		const undo = this.undo;
		if (!undo || this.active) return;
		this.protectedStep(() => { void this.mutate("已撤销移除", () => {
			this.host.store.restore(undo.id, undo.revision, this.host.guard());
			this.undo = null;
		}, { provider: undo.provider, modelId: undo.modelId }); });
	}
	open(target: ActionTarget, intent?: "add" | "remove"): void {
		this.epoch++;
		this.replacementApplied = false;
		this.cancelAfterRequest = false;
		this.directTask = intent !== undefined;
		this.target = { ...target, kind: target.kind ?? (target.provider ? "model" : "provider") };
		try {
			if (intent === "add") this.addTask();
			else if (intent === "remove") this.removeTask();
			else this.root();
		} catch (error) { this.report("无法准备操作", [safeMessage(error)], () => this.leave()); }
	}
	/** Current session policy, never the highlighted candidate or global default. */
	openFast(): void { this.fastMenu(this.view); }
	refreshFast(): void {
		const view = this.view;
		if (!this.disposed && view?.kind === "menu" && Object.hasOwn(view, "fastOrigin")) this.fastMenu(view.fastOrigin ?? null, view.native?.selected ?? view.selected);
	}
	private fastMenu(origin: View | null, selected = 0): void {
		const fast = this.host.fast;
		if (!fast || this.disposed) return;
		const info = fast.snapshot();
		const names = { off: "关闭", priority: "Fast（priority）", ultrafast: "Ultrafast" };
		const item = (tier: keyof typeof names): Item => ({ label: `${info.tier === tier ? "● " : ""}${names[tier]}`, run: () => { if (fast.setTier(tier)) this.fastMenu(origin, tier === "off" ? 0 : tier === "priority" ? 1 : 2); } });
		const items: Item[] = [item("off")];
		if (info.supported) {
			items.push(item("priority"));
			if (info.ultrafastEnabled) items.push(item("ultrafast"));
		}
		items.push({ label: "查看发送与回显（不发请求）", run: () => this.report("Hibiki · Fast 观察", fast.describe().split("\n"), () => this.fastMenu(origin, selected)) });
		this.setView({ kind: "menu", title: "Hibiki · 会话 Fast", items, selected: Math.min(selected, items.length - 1), fastOrigin: origin,
			notes: [`当前模型：${text(info.modelLabel)}`, `会话选择：${names[info.tier]}${!info.supported ? "（当前不适用，不注入参数）" : ""}`,
				"选择即生效，仅影响后续适用请求；不切换光标候选或默认模型。",
				...(!info.ultrafastEnabled ? ["Ultrafast 未显式启用，不提供此选项。"] : [])], back: () => this.setView(origin) });
	}
	private addTask(): void {
		if (this.host.guard().busy) { this.report("暂不可修改", ["请求运行中；请等待结束。"], () => this.leave()); return; }
		if (this.target.kind === "provider" || !this.target.provider) this.newProviderTask();
		else this.modelIdForm(this.target.provider);
	}
	private removeTask(): void {
		this.removalOrigin = this.view;
		if (!this.target.provider || (this.target.kind !== "provider" && !this.target.modelId)) { this.report("未选择移除对象", [], () => this.leave()); return; }
		this.archiveConsent(this.target.provider, this.target.kind === "provider" ? undefined : this.target.modelId);
	}
	private cancelTask(): void { this.setView(this.removalOrigin); }
	private renderSoon(): void { if (!this.disposed) this.host.requestRender(); }
	private setView(view: View | null): void {
		this.view = view;
		if (view?.kind === "menu" && !view.native) view.native = new NativeMenu(view.items, this.host.paint, view.back, view.selected);
		if (view?.kind === "models") { try { view.activate(); } catch (error) { view.basket.setError(safeMessage(error)); } view.basket.setFocused(this.focused); }
		this.renderSoon();
	}
	private leave(): void { this.epoch++; if (this.view?.kind === "busy") this.view.abort.abort(); this.setView(null); }
	dispose(): void { this.disposed = true; this.leave(); this.host.store.lock(); }
	private summary() { return this.host.store.snapshot(); }
	private provider() { return this.summary().providers.find((p) => p.id === this.target.provider); }
	private label(provider: string): string { return text(this.host.providerLabel?.(provider) ?? provider); }
	private root(): void {
		const p = this.target.provider;
		const m = this.target.kind === "provider" ? undefined : this.target.modelId;
		const mutable = p && !this.host.isProtected?.(p) && !!this.provider();
		const items: Item[] = [];
		if (p && this.target.kind === "provider") {
			if (mutable) items.push({ label: "添加模型…", run: () => this.modelIdForm(p) }, { label: "编辑供应商…", run: () => this.providerForm(p) }, { label: "移除供应商…", run: () => this.removeTask() });
			items.push({ label: "添加供应商…", run: () => this.newProviderTask() });
		} else if (p) {
			if (mutable) {
				items.push({ label: "添加模型…", run: () => this.addTask() });
				if (m) items.push({ label: "编辑模型…", run: () => this.modelForm(p, m, "edit") }, { label: "移除模型…", run: () => this.removeTask() });
			} else if (m) items.push({ label: "查看模型参数…", run: () => this.modelForm(p, m, "edit") });
		} else items.push({ label: "添加供应商…", run: () => this.newProviderTask() });
		if (this.host.fast) items.push({ label: "当前会话 · Fast…", run: () => this.openFast() });
		items.push({ label: "更多…", run: () => this.more() });
		this.setView({ kind: "menu", title: p ? `${this.label(p)}${m ? ` / ${text(m)}` : ""}` : "模型", notes: p && !mutable ? ["此供应商由 Pi 或扩展管理，只读。"] : [], selected: 0, back: () => this.leave(), items });
	}
	private more(): void {
		const origin = this.view;
		const p = this.target.provider; const m = this.target.kind === "provider" ? undefined : this.target.modelId;
		const items: Item[] = [];
		if (p && m) items.push({ label: "测试连接…", run: () => this.testConsent(p, m) });
		if (p && this.target.kind !== "provider" && !this.host.isProtected?.(p) && this.provider()) items.push({ label: "编辑供应商…", run: () => this.providerForm(p) });
		items.push({ label: "已移除的项目…", run: () => this.archives() });
		if (this.host.store.hasPending()) items.push({ label: "完成上次修改…", run: () => this.recoveryConsent() });
		this.setView({ kind: "menu", title: "更多", items, selected: 0, back: () => this.setView(origin) });
	}
	private report(title: string, lines: string[], back?: () => void): void {
		const origin = this.view;
		this.setView({ kind: "report", title, lines, offset: 0, back: back ?? (() => this.setView(origin)) });
	}
	private form(title: string, fields: Field[], notes: string[], save: (values: Record<string, string>) => void, back?: () => void, saveLabel = "保存修改", extras?: () => Item[]): void {
		const origin = this.view;
		this.setView({ kind: "form", title, fields, selected: 0, notes, error: "", save, back: back ?? (() => this.setView(origin)), saveLabel, extras });
	}
	/** Backend protection is automatic; it is not a user authentication step. */
	private protectedStep(next: () => void): void {
		const origin = this.view;
		try { next(); }
		catch (error) { this.report("操作未完成", [safeMessage(error)], () => this.setView(origin)); }
	}
	private pendingTask(origin: View | null): void {
		const back = () => this.setView(origin);
		this.setView({ kind: "menu", title: "上次修改尚未完成", selected: 0, back, notes: ["当前输入不会自动提交；先核对并完成上次修改。", "恢复完成后回矩阵重新检查，不覆盖外部修改。"], items: [
			{ label: "取消，保留当前输入", run: back },
			{ label: "核对并完成上次修改", run: () => { void this.mutate("上次修改已恢复；请重新检查当前任务", () => this.host.store.recover(this.summary().revision, this.host.guard())); } },
		] });
	}
	private formError(message: string): void { if (this.view?.kind === "form") { this.view.error = message; this.renderSoon(); } }
	private async mutate(title: string, operation: () => void, target?: { provider: string; modelId?: string }): Promise<void> {
		let saved = false;
		const origin = this.view;
		const previousUndo = this.undo;
		this.undo = null;
		this.setView({ kind: "busy", title: "保存中…", abort: new AbortController(), back: () => {} });
		try {
			this.host.flushRender?.();
			operation(); saved = true;
			await this.host.changed(target);
			if (!this.disposed) { this.leave(); this.host.feedback?.(title); }
		} catch (error) {
			if (!saved && previousUndo && !this.undo) {
				try { if (!this.host.store.hasPending() && this.summary().revision === previousUndo.revision) this.undo = previousUndo; } catch {}
			}
			if (!this.disposed) this.report(saved ? "已保存，列表尚未更新" : "修改未确认完成", [saved ? "重新打开列表核对即可，请勿重复添加。" : safeMessage(error), ...(this.replacementApplied ? ["当前/默认模型已切换；取消只停止移除，不会自动切回。"] : [])], saved ? () => this.leave() : () => this.setView(origin));
		}
	}
	private providerForm(id: string): void {
		let summary: ReturnType<PickerStore["snapshot"]>;
		try { summary = this.summary(); } catch (error) { this.report("无法读取配置", [safeMessage(error)]); return; }
		const provider = summary.providers.find((p) => p.id === id);
		if (id && this.host.isProtected?.(id)) { this.report("只读供应商", ["此供应商由 Pi 或扩展管理，不能在这里修改。"]); return; }
		if (id && !provider) { this.report("只读供应商", ["此供应商不是在这里添加的，不能修改。"]); return; }
		const fields: Field[] = [];
		fields.push({ id: "name", label: "名称", input: input(provider?.name ?? "") });
		fields.push({ id: "endpoint", label: "地址", input: input(provider?.endpoint ?? "") });
		fields.push({ id: "api", label: "接口类型", choices: ["保持现有协议", ...APIS], choice: 0, hint: API_NAMES[provider?.api ?? ""] ?? "当前接口保持不变" });
		fields.push({ id: "env", label: "密钥环境变量名", input: input(), hint: provider ? "留空保留现有凭据，不展示原密钥" : "例如 ACME_API_KEY；只填变量名，不粘贴密钥" });
		this.form(`编辑 ${this.label(id)}`, fields, [], (values) => {
			const env = values.env.trim() ? { envVar: values.env.trim() } : {};
			const changes = {
				...(values.name.trim() !== provider?.name ? { name: values.name.trim() || id! } : {}),
				...(values.endpoint.trim() !== provider?.endpoint ? { endpoint: values.endpoint.trim() } : {}),
				...(values.api !== "保持现有协议" ? { api: values.api } : {}), ...env,
			};
			if (id && !Object.keys(changes).length) { this.leave(); this.host.feedback?.("未修改连接配置"); return; }
			this.protectedStep(() => { void this.mutate("供应商配置已保存", () => {
				this.host.store.editProvider(id, changes, summary.revision, this.host.guard());
			}); });
		});
	}
	private newProviderTask(): void {
		const parent = this.view;
		const summary = this.summary();
		const retained = this.host.store.retained().providers;
		let pending: ProviderInput | undefined; let nextView: View | null = null;
		const fields: Field[] = [
			{ id: "name", label: "名称", input: input() },
			{ id: "endpoint", label: "地址", input: input() },
			{ id: "api", label: "接口类型", choices: APIS, choice: 0 },
			{ id: "env", label: "密钥环境变量名", input: input(), hint: "只填变量名，例如 ACME_API_KEY；不填密钥" },
		];
		this.form("添加供应商", fields, [], (values) => {
			let url: URL;
			try {
				url = new URL(values.endpoint.trim());
				if (url.protocol !== "https:" || !url.hostname || url.username || url.password || /[?#\s\\]/u.test(values.endpoint.trim())) throw new Error();
			} catch { this.formError("请输入无凭据、查询参数的 HTTPS 地址"); return; }
			if (values.env.trim() && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(values.env.trim())) { this.formError("只接受环境变量名，不接受密钥"); return; }
			const name = values.name.trim() || url.hostname;
			if (name.length > 256 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) { this.formError("供应商名称过长或含控制字符"); return; }
			const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[-.]+$/g, "");
			const base = (slug(name) || slug(url.hostname) || "provider").slice(0, 100);
			const taken = (id: string) => ["__proto__", "prototype", "constructor"].includes(id) || retained.includes(id) || summary.providers.some((p) => p.id === id) || this.host.catalog().some((m) => m.provider === id) || this.host.isProtected?.(id);
			let id = base; let n = 2; while (taken(id)) id = `${base}-${n++}`;
			const origin = this.view!;
			const value = { id: pending?.id ?? id, name, endpoint: values.endpoint.trim(), api: values.api, envVar: values.env.trim() || undefined };
			if (pending && nextView) { Object.assign(pending, value); nextView.title = `${text(pending.name)} · 添加模型`; this.setView(nextView); }
			else { pending = value; this.selectModels(id, summary.revision, () => this.setView(origin), pending); nextView = this.view; }
		}, () => this.setView(parent), "下一步");
	}
	private modelIdForm(provider: string, preset = ""): void {
		const summary = this.summary();
		if (this.host.isProtected?.(provider) || !summary.providers.some((p) => p.id === provider)) { this.report("只读供应商", ["这个供应商由 Pi 或扩展管理，不能在这里添加模型。"]); return; }
		const origin = this.view;
		this.selectModels(provider, summary.revision, () => this.setView(origin), undefined, preset);
	}
	private selectModels(providerId: string, revision: string, back: () => void, draft?: ProviderInput, preset = ""): void {
		// Capture read-only reference data once. Keystrokes/rendering never read files,
		// decrypt a ledger or rebuild the registry; writes still use the live guard.
		const provider = this.summary().providers.find((p) => p.id === providerId);
		const catalog = this.host.catalog();
		const existing = new Set(draft ? [] : provider?.models.map((m) => m.id) ?? []);
		// Other providers are parameter templates only, never this provider's candidates.
		// An uncommitted supplier has no owned catalog yet; do not invent one from templates.
		const local = draft ? [] : [...new Set(catalog.filter((m) => m.provider === providerId).map((m) => m.id))].filter((id) => !existing.has(id));
		let candidates = local;
		const selected = new Map<string, DraftModel>();
		let tests: ReturnType<PickerRecords["tests"]> | undefined;
		let picker: Extract<View, { kind: "models" }>;
		let basket: ModelBasket;
		const resolve = (ids: string[]) => {
			if (ids.some((id) => existing.has(id))) throw new StoreError("EXISTS");
			const scopeKey = JSON.stringify([providerId, draft?.endpoint ?? provider?.endpoint, draft?.api ?? provider?.api, draft?.envVar, revision]);
			for (const modelId of ids) {
				const previous = selected.get(modelId);
				if (previous?.scopeKey === scopeKey) continue;
				tests ??= this.host.records.hasData() ? this.host.records.tests() : [];
				const scope: Scope = { provider: providerId, modelId, endpoint: draft?.endpoint ?? provider?.endpoint ?? "", api: draft?.api ?? provider?.api ?? "", credentialVersion: draft ? `draft:${randomUUID()}` : revision };
				const resolved = resolveModelFields({ scope, now: Date.now(), tests, manual: previous?.manual, providerModel: findModelTemplate(modelId, catalog, providerId), generic: findModelTemplate(modelId, catalog) });
				selected.set(modelId, { model: { id: modelId, ...resolved.fields } as ModelInput, resolved, scopeKey, manual: previous?.manual });
			}
		};
		basket = new ModelBasket({
			candidates: local, blockedIds: [...existing], query: preset, paint: this.host.paint,
			requestRender: () => this.renderSoon(), onBack: back, onCancel: () => this.leave(),
			onChange: (ids) => { try { resolve(ids); } catch (error) { basket.setError(safeMessage(error)); } },
			describe: (id) => {
				const row = selected.get(id);
				return row ? `${row.resolved.needsReview.length ? "规格待确认" : "参考规格"} · ${row.model.contextWindow} / ${row.model.maxTokens}` : "";
			},
			saveLabel: (count) => draft ? `添加供应商及模型（${count}个）` : `添加${count}个模型`,
			onEdit: (id) => {
				try { resolve([id]); this.adjustDraft(selected.get(id)!, () => this.setView(picker)); }
				catch (error) { basket.setError(safeMessage(error)); }
			},
			onSubmit: (ids) => {
				try {
					resolve(ids);
					if (this.host.guard().busy) { basket.setError("正在运行请求，请结束后再添加。"); return; }
					const rows = ids.map((id) => selected.get(id)!);
					this.protectedStep(() => { void this.mutate(draft ? "供应商及模型已添加" : "模型已添加", () => {
						this.host.records.appendMany(rows.map(({ model, resolved }) => ({ kind: "resolution", id: randomUUID(), when: Date.now(), provider: providerId, modelId: model.id, fields: model, recommendation: resolved.fields, provenance: resolved.provenance, edited: Object.keys(resolved.provenance).filter((key) => JSON.stringify(model[key as keyof ModelInput]) !== JSON.stringify(resolved.fields[key])), phase: "proposed" })));
						if (draft) this.host.store.addProviderWithModels(draft, rows.map((r) => r.model), revision, this.host.guard());
						else this.host.store.putModels(providerId, rows.map((r) => r.model), revision, this.host.guard());
					}, { provider: providerId, modelId: rows[0]!.model.id }); });
				} catch (error) { basket.setError(safeMessage(error)); }
			},
			...(!draft ? { onDiscover: () => this.discoveryConsent(providerId, () => this.setView(picker), (ids, code, recorded) => {
				if (recorded && code === "ok") {
					// A successful response (including an empty one) is authoritative for
					// this read. Never union templates/local IDs back into the returned list.
					candidates = [...new Set(ids)].filter((id) => !existing.has(id));
					basket.setCandidates(candidates);
				}
				basket.setStatus(!recorded ? "未能保存检查记录，可继续手输" : code === "ok" ? "已读取本家模型，规格仍需核对" : `${CODE_NAMES[code]}，可继续手输`);
				this.setView(picker);
			}) } : {}),
		});
		picker = { kind: "models", title: `${draft?.name ?? this.label(providerId)} · 添加模型`, basket, activate: () => { resolve(basket.selectedIds); basket.setCandidates(candidates); }, back };
		this.setView(picker);
	}
	private adjustDraft(row: DraftModel, back: () => void): void {
		const m = row.model;
		this.form(`${text(m.id)} · 调整参数`, [
			{ id: "name", label: "显示名", input: input(m.name ?? m.id) },
			{ id: "context", label: "上下文窗口", input: input(String(m.contextWindow)) },
			{ id: "output", label: "最大输出", input: input(String(m.maxTokens)) },
			{ id: "reasoning", label: "思考能力", choices: ["否", "是"], choice: m.reasoning ? 1 : 0 },
			{ id: "vision", label: "图片输入", choices: ["否", "是"], choice: m.input.includes("image") ? 1 : 0 },
		], Object.entries(row.resolved.provenance).map(([k, v]) => `${FIELD_NAMES[k] ?? k} ← ${SOURCE_NAMES[v.source]}`), (v) => {
			const contextWindow = Number(v.context); const maxTokens = Number(v.output);
			if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || contextWindow < maxTokens) { this.formError("窗口/输出须为正整数，且输出不能大于窗口"); return; }
			const next: ModelInput = { id: m.id, name: v.name.trim() || m.id, contextWindow, maxTokens, reasoning: v.reasoning === "是", input: v.vision === "是" ? ["text", "image"] : ["text"] };
			row.manual ??= {};
			for (const field of ["name", "contextWindow", "maxTokens", "reasoning", "input"] as const) {
				if (JSON.stringify(next[field]) !== JSON.stringify(m[field])) Object.assign(row.manual, { [field]: next[field] });
			}
			row.model = next; back();
		}, back, "保存修改");
	}
	private modelForm(providerId: string, modelId: string, mode: "add" | "edit"): void {
		try {
			const summary = this.summary();
			const provider = summary.providers.find((p) => p.id === providerId);
			const manual = provider?.models.find((m) => m.id === modelId);
			const scope: Scope = { provider: providerId, modelId, endpoint: provider?.endpoint ?? "", api: provider?.api ?? "", credentialVersion: summary.revision };
			const resolved = resolveModelFields({ scope, now: Date.now(),
				tests: this.host.records.hasData() ? this.host.records.tests() : [],
				manual, providerModel: findModelTemplate(modelId, this.host.catalog(), providerId), generic: findModelTemplate(modelId, this.host.catalog()),
			});
			const sourceLines = Object.entries(resolved.provenance).map(([k, v]) => `${FIELD_NAMES[k] ?? k} ← ${SOURCE_NAMES[v.source] ?? v.source}`);
			if (!provider || this.host.isProtected?.(providerId) || (mode === "edit" && !manual)) {
				this.report(`${text(providerId)} / ${text(modelId)} · 参数来源（只读）`, [...sourceLines,
					`上下文 ${resolved.fields.contextWindow} / 输出 ${resolved.fields.maxTokens}`,
					"此模型由 Pi 或扩展管理，只读。"]); return;
			}
			const r = resolved.fields;
			this.form(`${text(providerId)} / ${text(modelId)} · ${mode === "add" ? "添加" : "编辑"}`, [
				{ id: "name", label: "显示名", input: input(String(r.name ?? modelId)) },
				{ id: "context", label: "上下文窗口", input: input(String(r.contextWindow)) },
				{ id: "output", label: "最大输出", input: input(String(r.maxTokens)) },
				{ id: "reasoning", label: "思考能力", choices: ["否", "是"], choice: r.reasoning ? 1 : 0 },
				{ id: "vision", label: "图片输入", choices: ["否", "是"], choice: Array.isArray(r.input) && r.input.includes("image") ? 1 : 0 },
			], [...sourceLines, ...(resolved.needsReview.length ? [`待确认：${resolved.needsReview.map((field) => FIELD_NAMES[field] ?? field).join("、")}`] : []), "价格不由通用模板复制；未知价格不代表免费。"], (values) => {
				const contextWindow = Number(values.context); const maxTokens = Number(values.output);
				if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || contextWindow < 1 || maxTokens < 1 || maxTokens > contextWindow) { this.formError("窗口/输出须为正整数，且输出不能大于窗口"); return; }
				const model = { id: modelId, name: values.name.trim() || modelId, contextWindow, maxTokens, reasoning: values.reasoning === "是", input: (values.vision === "是" ? ["text", "image"] : ["text"]) as ("text" | "image")[] };
				this.protectedStep(() => { void this.mutate("模型配置已保存", () => {
					const edited = Object.keys(resolved.provenance).filter((field) => JSON.stringify(model[field as keyof typeof model]) !== JSON.stringify(resolved.fields[field]));
					const event = { kind: "resolution", id: randomUUID(), when: Date.now(), provider: providerId, modelId, fields: model, recommendation: resolved.fields, provenance: resolved.provenance, edited, phase: "proposed" };
					this.host.records.append(event);
					this.host.store.putModel(providerId, model, mode, summary.revision, this.host.guard());
					// The store's authenticated transaction history records application;
					// do not add a fallible post-commit ledger write and misreport a saved config.
				}); });
			});
		} catch (error) { this.report("无法准备模型参数", [safeMessage(error)]); }
	}
	private archiveConsent(provider: string, modelId?: string): void {
		try {
			const summary = this.summary();
			const entry = summary.providers.find((p) => p.id === provider);
			const guard = this.host.guard();
			if (guard.busy || this.host.isProtected?.(provider) || !entry || (modelId && !entry.models.some((m) => m.id === modelId))) {
				this.report("无法移除", [guard.busy ? "请求运行中；请等待结束。" : "此对象只读或已不在自定义配置中。"], () => this.leave()); return;
			}
			if (guard.defaultUnknown) { this.report("暂不能移除", ["无法确认默认模型设置；请先检查或重新设置默认模型。未移除任何配置。"], () => this.leave()); return; }
			if (this.host.store.hasPending()) { this.pendingTask(this.view); return; }
			const affected = (ref?: { provider: string; id: string }) => ref?.provider === provider && (!modelId || ref.id === modelId);
			const targets = { current: affected(guard.current), default: affected(guard.default) };
			if (targets.current || targets.default) {
				this.replacement(provider, modelId, targets, () => {
					if (this.summary().revision !== summary.revision) { this.report("配置已在外部变更", ["替换已完成，但未归档；请重新检查对象后再移除。"], () => this.leave()); return; }
					this.archiveConsent(provider, modelId);
				}); return;
			}
			this.setView({ kind: "menu", title: modelId ? `移除模型 ${text(provider)} / ${text(modelId)}` : `移除供应商 ${text(provider)} · 整行 ${entry.models.length} 个模型`, selected: 0,
				notes: [modelId ? "仅移除此模型，可恢复。" : `包含全部 ${entry.models.length} 个模型（含搜索未显示项），可恢复。`, ...(this.replacementApplied ? ["当前/默认已切换；取消只停止移除，不会自动切回。"] : [])],
				items: [
					{ label: this.replacementApplied ? "停止移除，保留已切换模型" : "取消", run: () => this.cancelTask() },
					{ label: modelId ? "确认移除模型（可恢复）" : `确认移除整家（${entry.models.length}个模型，可恢复）`, run: () => {
						const latest = this.host.guard();
						if (latest.busy || latest.defaultUnknown || affected(latest.current) || affected(latest.default)) { this.archiveConsent(provider, modelId); return; }
						this.protectedStep(() => { void this.mutate(`已移除 ${text(provider)}${modelId ? ` / ${text(modelId)}` : " 整家"}（可恢复）`, () => {
							const previous = new Set(this.host.store.listArchives().map((a) => a.id));
							if (modelId) this.host.store.archiveModel(provider, modelId, summary.revision, this.host.guard());
							else this.host.store.archiveProvider(provider, summary.revision, this.host.guard());
							// Undo metadata is best effort after commit; its read failure must not
							// turn a completed archive into an apparent failed write.
							try {
								const archive = this.host.store.listArchives().find((a) => !previous.has(a.id));
								if (archive) this.undo = { id: archive.id, provider, modelId, revision: this.summary().revision, label: `撤销移除 ${text(provider)}${modelId ? ` / ${text(modelId)}` : ""}` };
							} catch { this.undo = null; }
						}); });
					} },
				], back: () => this.cancelTask() });
		} catch (error) { this.report("无法准备归档", [safeMessage(error)]); }
	}
	private replacement(provider: string, modelId: string | undefined, targets: { current: boolean; default: boolean }, next: () => void): void {
		const label = [targets.current ? "当前模型" : "", targets.default ? "默认模型" : ""].filter(Boolean).join("及");
		const candidates = this.host.available?.().filter((m) => m.provider !== provider || (modelId !== undefined && m.id !== modelId)) ?? [];
		if (!this.host.replace || !candidates.length) { this.report("暂不能移除", [`此范围包含${label}；请先明确切换${label}后再移除。`], () => this.leave()); return; }
		const back = () => this.leave();
		this.setView({ kind: "menu", title: `先替换${label}（未移除）`, selected: 0, back, items: [
			{ label: "取消，不切换、不移除", run: back },
			...candidates.map((m) => ({ label: `${text(m.provider)} / ${text(m.id)}`, run: () => {
				const selection = this.view;
				const returnToSelection = () => this.setView(selection);
				this.setView({ kind: "menu", title: `将${label}改为 ${text(m.provider)} / ${text(m.id)}？`, selected: 0, back: returnToSelection, items: [
					{ label: "取消", run: returnToSelection },
					{ label: "确认替换，继续移除确认", run: () => {
						const expected = this.host.guard();
						if (expected.busy || expected.defaultUnknown) { this.report("暂不可修改", [expected.defaultUnknown ? "无法确认默认设置；未替换、未移除。" : "请求运行中；未替换、未移除。"], back); return; }
						const affected = (r?: { provider: string; id: string }) => r?.provider === provider && (!modelId || r.id === modelId);
						if (affected(expected.current) !== targets.current || affected(expected.default) !== targets.default) {
							this.report("使用状态已变化", ["尚未替换或移除；请重新核对当前/默认模型。"], back); return;
						}
						const token = ++this.epoch;
						this.setView({ kind: "busy", title: "替换当前/默认模型", abort: new AbortController(), back: () => {} });
						void Promise.resolve().then(() => this.host.replace!(m, targets, expected)).then(() => {
							if (this.disposed || token !== this.epoch) return;
							const g = this.host.guard();
							const still = (r?: { provider: string; id: string }) => r?.provider === provider && (!modelId || r.id === modelId);
							if (g.busy || still(g.current) || still(g.default)) { this.report("替换未完整完成", ["未归档；当前/默认设置可能已部分改变，请核对后重试。"], back); return; }
							this.replacementApplied = true;
							next();
						}).catch(() => { if (!this.disposed && token === this.epoch) this.report("替换未完整完成", ["未归档；当前/默认设置可能已部分改变，请核对后重试。"], back); });
					} },
				] });
			} })),
		] });
	}
	private archives(): void {
		const origin = this.view;
		let list: View;
		const legacy = this.host.store.hasLegacyData?.() || this.host.records.hasLegacyData?.();
		if (!this.host.store.hasVault()) { this.report("已移除", [legacy ? "旧版记录仍保留，迁移需另行确认。" : "没有可恢复记录。"], () => this.setView(origin)); return; }
		this.protectedStep(() => {
			try {
				const archives = this.host.store.listArchives();
				if (!archives.length) { this.report("已移除", [legacy ? "没有新移除项；旧版记录仍单独保留。" : "没有待恢复项。"], () => this.setView(origin)); return; }
				list = { kind: "menu", title: "已移除的项目", selected: 0, notes: legacy ? ["另有旧版记录单独保留。"] : [], back: () => this.setView(origin), items: archives.map((a) => ({
					label: `${a.kind === "provider" ? "整行" : "模型"} · ${text(a.provider)}${a.modelId ? ` / ${text(a.modelId)}` : ""}`,
					run: () => {
						const summary = this.summary();
						const occupied = new Set([...summary.providers.map((p) => p.id), ...this.host.catalog().map((m) => m.provider)]);
						const copy = a.kind === "provider" && (occupied.has(a.provider) || this.host.isProtected?.(a.provider));
						let destination = a.provider;
						if (copy) {
							const retained = new Set(this.host.store.retained().providers);
							const base = `${a.provider.slice(0, 96)}-restored`;
							let n = 2; destination = base;
							while (occupied.has(destination) || retained.has(destination) || this.host.isProtected?.(destination)) destination = `${base}-${n++}`;
						}
						this.form(`恢复 ${text(a.provider)}${a.modelId ? ` / ${text(a.modelId)}` : ""}`, [],
							copy ? [`已有同名供应商，将作为「${text(destination)}」恢复。`, "现有配置保持不变；副本不迁移旧收藏/排序。"] : ["同名项不会被覆盖；原有收藏/排序保留。"],
							() => { void this.mutate("已恢复到模型列表", () => this.host.store.restore(a.id, summary.revision, this.host.guard(), a.kind === "provider" ? destination : undefined), { provider: destination, modelId: a.modelId }); },
							() => this.setView(list), copy ? "作为新供应商恢复" : "恢复到列表");
					},
				})) };
				this.setView(list);
			} catch (error) { this.report("无法读取归档", [safeMessage(error)]); }
		});
	}
	private recoveryConsent(): void {
		try {
			const revision = this.summary().revision;
			this.setView({ kind: "menu", title: "完成上次修改", selected: 0, back: () => this.root(), items: [
				{ label: "取消，不修改配置", run: () => this.root() },
				{ label: "确认完成上次修改", run: () => { void this.mutate("上次修改已完成", () => this.host.store.recover(revision, this.host.guard())); } },
			] });
		} catch (error) { this.report("无法准备恢复", [safeMessage(error)]); }
	}
	private connectionNotes(provider: string, modelId?: string): string[] {
		try {
			const p = this.summary().providers.find((item) => item.id === provider);
			const m = this.host.catalog().find((item) => item.provider === provider && (!modelId || item.id === modelId));
			const u = new URL(m?.baseUrl || p?.endpoint || "");
			return [`${u.origin}${u.pathname} · ${API_NAMES[m?.api || p?.api] ?? "当前接口"}`,  "鉴权+请求总计最多10秒；取消不保证终止既有凭据命令。"]; 
		} catch { return ["目标地址不可确认；请求将拒绝不安全地址。"] ; }
	}
	private discoveryConsent(provider: string, back = () => this.root(), done?: (ids: string[], code: ProbeCode, recorded: boolean) => void): void {
		this.setView({ kind: "menu", title: `${text(provider)} · 上游清单`, notes: [...this.connectionNotes(provider), "只读取模型名，不运行模型；服务商仍可能计费。"], selected: 0, back, items: [
			{ label: "直接手输模型 ID（不发请求）", run: back },
			{ label: "确认读取清单 · 一次 HTTPS GET，无自动重试", run: () => this.protectedStep(() => { void this.discover(provider, done); }) },
		] });
	}
	private testConsent(provider: string, modelId: string): void {
		const origin = this.view;
		this.setView({ kind: "menu", title: `${text(provider)} / ${text(modelId)} · 测试`, notes: [...this.connectionNotes(provider, modelId), "可能计费；本轮仅固定文本连通性，不验证模型规格。"], selected: 0, back: () => this.setView(origin), items: [
			{ label: "取消，不发请求", run: () => this.setView(origin) },
			{ label: "确认文本测试（可能计费）· 1次 / 最多32输出token / 10秒", run: () => this.protectedStep(() => { void this.test(provider, modelId); }) },

		] });
	}
	private hintScope(provider: string, modelId: string): Scope {
		let endpoint = ""; let api = "";
		try {
			const p = this.summary().providers.find((item) => item.id === provider);
			const m = this.host.catalog().find((item) => item.provider === provider && item.id === modelId);
			const u = new URL(m?.baseUrl || p?.endpoint || "");
			endpoint = `${u.origin}${u.pathname}`; api = m?.api || p?.api || "";
		} catch {}
		return { provider, modelId, endpoint, api, credentialVersion: `unresolved:${randomUUID()}` };
	}
	private async discover(provider: string, done?: (ids: string[], code: ProbeCode, recorded: boolean) => void): Promise<void> {
		const origin = this.view; this.cancelAfterRequest = false;
		const abort = new AbortController(); const token = ++this.epoch;
		const started = Date.now(); const attemptId = randomUUID(); let ids: string[] = []; let code: ProbeCode = "ok";
		this.setView({ kind: "busy", title: "读取模型中…", abort, cancellable: true, back: () => { abort.abort(); } });
		try { this.host.flushRender?.(); this.host.records.append({ kind: "discovery-start", attemptId, when: started, provider }); }
		catch (error) { if (done) done([], "network", false); else this.report("请求未发出", [safeMessage(error)], () => this.setView(origin)); return; }
		try {
			ids = await withProbeDeadline(async (checkDeadline) => {
				const auth = await this.host.auth(provider);
				checkDeadline();
				return discoverModels(auth.scope, { headers: auth.headers, signal: abort.signal, checkDeadline });
			}, abort);
		} catch (error) { code = error instanceof ProbeError ? error.code : "network"; }
		if (this.disposed || token !== this.epoch) return;
		try {
			this.host.records.append({ kind: "discovery", attemptId, when: started, provider, code, count: code === "ok" ? ids.length : 0 });
			if (this.cancelAfterRequest) { this.cancelAfterRequest = false; this.leave(); return; }
			if (done) { done(ids, code, true); return; }
			if (code !== "ok") { this.report("未能读取模型", [CODE_NAMES[code], "可以返回后手动输入模型 ID。"], () => this.setView(origin)); return; }
			this.setView({ kind: "menu", title: `${text(provider)} · 上游候选（本次单批最多1000个，不代表已验证可调用）`, selected: 0, back: () => this.root(), items: [
				{ label: "手输其他模型 ID", run: () => this.modelIdForm(provider) },
				...ids.map((id) => ({ label: text(id), run: () => this.modelForm(provider, id, "add") })),
			] });
		} catch (error) {
			if (this.cancelAfterRequest) { this.cancelAfterRequest = false; this.leave(); this.host.feedback?.("已取消；检查记录未能保存。", true); }
			else if (done) done([], "network", false);
			else this.report("检查记录未能保存", [safeMessage(error)], () => this.setView(origin));
		}
	}
	private async test(provider: string, modelId: string): Promise<void> {
		const origin = this.view; this.cancelAfterRequest = false;
		const abort = new AbortController(); const token = ++this.epoch;
		const started = Date.now(); const attemptId = randomUUID(); let scope = this.hintScope(provider, modelId); let result: ProbeReport;
		this.setView({ kind: "busy", title: `${this.label(provider)} / ${text(modelId)} · 文本测试中`, abort, cancellable: true, back: () => { abort.abort(); } });
		try { this.host.flushRender?.(); this.host.records.append({ kind: "probe-start", attemptId, when: started, provider, modelId }); }
		catch (error) { this.report("测试未开始", [safeMessage(error)], () => this.setView(origin)); return; }
		try {
			result = await withProbeDeadline(async (checkDeadline) => {
				const auth = await this.host.auth(provider, modelId); scope = auth.scope;
				checkDeadline();
				return probeText(scope, { headers: auth.headers, signal: abort.signal, checkDeadline });
			}, abort);
		} catch (error) {
			const code = error instanceof ProbeError ? error.code : "network";
			result = { id: randomUUID(), scope, code, elapsedMs: Date.now() - started, testedAt: started, expiresAt: started + 3600000, status: "inconclusive", fields: {}, verifiedFields: [], checks: { text: "inconclusive" } };
		}
		if (this.disposed || token !== this.epoch) return;
		try {
			result.elapsedMs = Math.max(0, Date.now() - started);
			this.host.records.append({ kind: "probe", attemptId, report: result });
			if (this.cancelAfterRequest) { this.cancelAfterRequest = false; this.leave(); return; }
			this.report("连接检查", [CODE_NAMES[result.code], `${result.elapsedMs}ms · ${this.label(provider)} / ${text(modelId)}`, "仅检查文本连通性，不代表模型规格已验证。"], () => this.setView(origin));
		} catch (error) {
			if (this.cancelAfterRequest) { this.cancelAfterRequest = false; this.leave(); this.host.feedback?.("已取消；检查记录未能保存。", true); }
			else this.report("检查记录未能保存", [safeMessage(error)], () => this.setView(origin));
		}
	}
	handleInput(data: string): void {
		const view = this.view;
		if (!view || !this.focused) return;
		if (view.kind === "models") { view.basket.handleInput(data); return; }
		if (view.kind === "form" && (view.pasting || data.includes("\x1b[200~"))) {
			view.pasting = !((view.pasteTail ?? "") + data).includes("\x1b[201~");
			view.pasteTail = view.pasting ? ((view.pasteTail ?? "") + data).slice(-5) : "";
			view.fields[view.selected]?.input?.handleInput(data); this.renderSoon(); return;
		}
		if (isKeyRelease(data)) return;
		if (isKeyRepeat(data) && (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) return;
		if (matchesKey(data, Key.ctrl("c"))) {
			if (view.kind === "busy") { if (view.cancellable) { this.cancelAfterRequest = true; view.abort.abort(); } }
			else this.leave();
			return;
		}
		if (matchesKey(data, Key.escape)) { view.back(); return; }
		if (view.kind === "busy") return;
		if (view.kind === "menu") {
			try { view.native?.handleInput(data); view.selected = view.native?.selected ?? view.selected; }
			catch (error) { this.report("操作未完成", [safeMessage(error)]); }
		} else if (view.kind === "report") {
			if (matchesKey(data, Key.up)) view.offset = Math.max(0, view.offset - 1);
			else if (matchesKey(data, Key.down)) view.offset = Math.min(Math.max(0, view.lines.length - 1), view.offset + 1);
			else if (matchesKey(data, Key.enter)) view.back();
		} else {
			if (matchesKey(data, Key.ctrl("s"))) { this.submit(view); return; }
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.down) || matchesKey(data, Key.up) || matchesKey(data, Key.enter)) {
				const extras = view.extras?.() ?? [];
				if (matchesKey(data, Key.enter) && view.selected >= view.fields.length) {
					if (view.selected === view.fields.length) this.submit(view);
					else extras[view.selected - view.fields.length - 1]?.run();
					return;
				}
				const count = view.fields.length + 1 + extras.length;
				const f = view.fields[view.selected];
				if (matchesKey(data, Key.enter) && f?.choices) f.choice = ((f.choice ?? 0) + 1) % f.choices.length;
				else view.selected = (view.selected + (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab")) ? -1 : 1) + count) % count;
			} else {
				const f = view.fields[view.selected];
				if (f?.choices && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) f.choice = ((f.choice ?? 0) + (matchesKey(data, Key.left) ? -1 : 1) + f.choices.length) % f.choices.length;
				else if (f?.input) f.input.handleInput(data);
				else if (view.extras && view.fields.length === 1 && view.fields[0]?.input) {
					const printable = decodeKittyPrintable(data) ?? data;
					if ((printable.length === 1 && printable >= " ") || data.startsWith("\x1b[200~") || matchesKey(data, Key.backspace) || matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("w"))) {
						view.selected = 0; view.fields[0].input.handleInput(data);
					}
				}
			}
		}
		this.renderSoon();
	}
	private submit(view: Extract<View, { kind: "form" }>): void {
		const values: Record<string, string> = {};
		for (const f of view.fields) values[f.id] = f.choices ? f.choices[f.choice ?? 0]! : f.input?.getValue() ?? "";
		try { view.save(values); } catch (error) { this.formError(safeMessage(error)); }
	}
	render(width: number, height = 18): string[] {
		const view = this.view;
		if (!view) return [];
		const paint = this.host.paint;
		const h = Math.max(3, height); const w = Math.max(1, width - 1);
		const lines = [paint("accent", ` ${view.title}`)];
		const budget = Math.max(1, h - 3);
		if (view.kind === "models") {
			view.basket.setFocused(this.focused);
			lines.push(...view.basket.render(width, h - 1));
		} else if (view.kind === "menu") {
			const notes = (view.notes ?? []).slice(0, Math.max(0, h - 4));
			lines.push(...notes.map((s) => paint("dim", ` ${s}`)));
			lines.push(...(view.native?.render(width, Math.max(1, h - lines.length - 1)) ?? []));
			lines.push(paint("dim", " ↑↓ 选择 · Enter 确认 · Esc 返回"));
		} else if (view.kind === "form") {
			const fieldRows: string[] = []; const starts: number[] = [];
			view.fields.forEach((f, index) => {
				starts.push(fieldRows.length);
				const focus = view.selected === index;
				if (f.input) f.input.focused = this.focused && focus;
				const prefix = ` ${focus ? "›" : " "} ${f.label}: `;
				const narrow = width < 42;
				const available = Math.max(1, w - (narrow ? 3 : visibleWidth(prefix)));
				const rawChoice = f.choices?.[f.choice ?? 0];
				const value = rawChoice !== undefined ? `‹ ${API_NAMES[rawChoice] ?? rawChoice} ›` : f.input?.render(available)[0] ?? "";
				if (narrow) fieldRows.push(paint(focus ? "accent" : "text", prefix.trimEnd()), `   ${value}`);
				else fieldRows.push(paint(focus ? "accent" : "text", prefix) + value);
			});
			starts.push(fieldRows.length);
			fieldRows.push(paint(view.selected === view.fields.length ? "accent" : "text", ` ${view.selected === view.fields.length ? "→" : " "} ${view.saveLabel}`));
			const focusedRow = starts[Math.min(view.selected, starts.length - 1)] ?? 0;
			const room = Math.max(1, h - 4);
			const start = Math.max(0, Math.min(focusedRow - room + (width < 42 ? 2 : 1), fieldRows.length - room));
			lines.push(...fieldRows.slice(start, start + room));
			const note = view.error || view.fields[view.selected]?.hint || view.notes[view.selected] || "";
			if (note) lines.push(paint(view.error ? "error" : "dim", ` ${note}`));
			lines.push(paint("dim", ` Tab/Shift+Tab 字段 · Ctrl+S ${view.saveLabel} · Esc 返回`));
		} else if (view.kind === "report") {
			lines.push(...view.lines.slice(view.offset, view.offset + budget).map((s) => paint("text", ` ${s}`)));
			lines.push(paint("dim", " ↑↓ 滚动 · Enter/Esc 返回"));
		} else if (view.title.includes("测试") || view.title.includes("清单")) lines.push(paint("dim", " 等待响应 · Esc 取消"));
		return lines.slice(0, h).map((line) => truncateToWidth(line, w, ""));
	}
}
