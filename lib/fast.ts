import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Compatible with the standalone gpt-fast-mode extension; branding is not migration.
const STATE_ENTRY = "gpt-fast-mode-state";
const FAST_PROVIDERS = new Set(["clf-responses", "clf-completions", "openai", "openai-codex"]);
const FAST_APIS = new Set(["openai-responses", "openai-completions", "openai-codex-responses"]);
const FAST_GPT_MODEL = /^gpt-(?:5\.[4-9]|[6-9]|[1-9]\d+)(?:$|[-.])/i;

export type RequestTier = "off" | "priority" | "ultrafast";
type FastState = { version: 2; tier: RequestTier };
type RequestObservation = {
	requestedTier: RequestTier;
	requestedAt: string;
	actualTier?: string;
	responseId?: string;
	terminalEvent?: string;
};

export interface FastSnapshot {
	tier: RequestTier;
	supported: boolean;
	active: boolean;
	ultrafastEnabled: boolean;
	modelLabel: string;
}

export interface FastController {
	snapshot(ctx: ExtensionContext): FastSnapshot;
	setTier(tier: RequestTier, ctx: ExtensionContext): boolean;
	describe(ctx: ExtensionContext): string;
	subscribe(listener: () => void): () => void;
}

export function supportsFastMode(model: Model<Api> | undefined): boolean {
	return Boolean(model && FAST_PROVIDERS.has(model.provider) && FAST_APIS.has(model.api) && FAST_GPT_MODEL.test(model.id));
}

function modelName(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "未选择模型";
}

function modelKey(model: Model<Api>): string {
	return JSON.stringify([model.provider, model.api, model.id, model.baseUrl]);
}

function tierName(tier: RequestTier): string {
	return tier === "priority" ? "Fast（priority）" : tier === "ultrafast" ? "Ultrafast" : "关闭";
}

export function restoreTier(value: unknown): RequestTier {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "off";
	const state = value as Partial<FastState> & { enabled?: unknown };
	if (state.version === 2) return state.tier === "priority" || state.tier === "ultrafast" ? state.tier : "off";
	// Old probe echoes do not grant permission to enable Ultrafast.
	return state.enabled === true ? "priority" : "off";
}

// Only presentation callbacks are isolated. Configuration, branch and persistence
// errors deliberately propagate to the host instead of appearing successful.
function present(action: () => unknown): void {
	try {
		const result = action();
		if (result && typeof (result as PromiseLike<unknown>).then === "function") {
			void Promise.resolve(result).catch(() => {});
		}
	} catch {
		// Headless, unavailable or failing UI must not change request policy.
	}
}

export function registerFastPolicy(
	pi: ExtensionAPI,
	options: { ultrafastEnabled?: () => boolean } = {},
): FastController {
	let tier: RequestTier = "off";
	let disposed = false;
	const observations = new Map<string, RequestObservation>();
	const listeners = new Set<() => void>();
	// Intentionally lazy: registration must not load configuration or touch IO.
	const ultrafastEnabled = (): boolean => !disposed && options.ultrafastEnabled?.() === true;
	const usage = (enabled: boolean): string => `/fast、/fast on${enabled ? "、/fast ultrafast" : ""}、/fast off、/fast check、/fast status`;

	function changed(): void {
		for (const listener of [...listeners]) {
			if (disposed) break;
			if (listeners.has(listener)) present(listener);
		}
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
		if (!disposed) present(() => ctx.ui.notify(message, level));
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (disposed) return;
		const active = supportsFastMode(ctx.model) && tier !== "off";
		// The arrow denotes a request selection, never confirmed acceleration.
		present(() => ctx.ui.setStatus("gpt-fast-mode", active ? (tier === "priority" ? "\u26a1 FAST↑" : "\u26a1 ULTRAFAST↑") : undefined));
		changed();
	}

	function restoreState(ctx: ExtensionContext): void {
		if (disposed) return;
		const state = ctx.sessionManager.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)
			.at(-1);
		const enabled = ultrafastEnabled();
		if (disposed) return;
		tier = restoreTier(state?.type === "custom" ? state.data : undefined);
		if (tier === "ultrafast" && !enabled) tier = "off";
		observations.clear();
		updateStatus(ctx);
	}

	function describe(ctx: ExtensionContext): string {
		const model = ctx.model;
		if (!model || !supportsFastMode(model)) {
			return `当前模型 ${modelName(model)} 不在加速参数适用范围；不会注入参数。会话选择：${tierName(tier)}。`;
		}
		const sending = tier === "off" ? "不发送 service_tier" : `将发送 service_tier=${tier}`;
		const observation = observations.get(modelKey(model));
		const current = `${modelName(model)}：${tierName(tier)}，${sending}。`;
		if (!observation) return `${current}\n本次加载后尚无请求记录；下一次对话会记录发送档位与上游回显。`;
		const sent = observation.requestedTier === "off" ? "未发送档位字段" : `service_tier=${observation.requestedTier}`;
		const echoed = observation.actualTier === undefined ? "未回显" : `service_tier=${observation.actualTier}`;
		return `${current}\n最近请求（${observation.requestedAt}）：${sent}；上游${echoed}。` +
			`${observation.terminalEvent ? `终态：${observation.terminalEvent}。` : ""}` +
			`${observation.responseId ? `\n响应 ID：${observation.responseId}` : ""}` +
			"\n回显仅作观察，不阻止发送，也不作为实际加速或计费的证明。";
	}

	function setTier(next: RequestTier, ctx: ExtensionContext): boolean {
		if (disposed) return false;
		const enabled = ultrafastEnabled();
		if (disposed) return false;
		// Also fail closed for untyped callers; do not persist an unknown tier.
		if (next !== "off" && next !== "priority" && next !== "ultrafast") {
			notify(ctx, `用法：${usage(enabled)}`, "warning");
			return false;
		}
		if (next === "ultrafast" && !enabled) {
			notify(ctx, "Ultrafast 默认禁用；当前只提供 Fast。若需启用，将 pi-hibiki.json 的 fast.enableUltrafast 设为 true 后 /reload。", "warning");
			return false;
		}
		if (next !== "off" && !supportsFastMode(ctx.model)) {
			notify(ctx, `当前模型 ${modelName(ctx.model)} 不在加速参数适用范围；选择保持不变。`, "warning");
			return false;
		}
		pi.appendEntry(STATE_ENTRY, { version: 2, tier: next } satisfies FastState);
		if (disposed) return false;
		tier = next;
		updateStatus(ctx);
		notify(ctx, next === "off"
			? "加速参数已关闭，后续请求不发送 service_tier。"
			: `已选择 ${tierName(next)}，后续请求发送 service_tier=${next}。上游支持范围与费用以站方为准；回显不拦截发送。`, "info");
		return true;
	}

	pi.registerCommand("fast", {
		description: "请求 Fast 档位：/fast、/fast on、/fast ultrafast（需显式启用）、/fast off、/fast check、/fast status；查看发送状态与最近回显（不发探针）",
		handler: async (args, ctx) => {
			if (disposed) return;
			const action = args.trim().toLowerCase();
			if (action === "status" || action === "check") {
				notify(ctx, describe(ctx), "info");
				return;
			}
			let next: RequestTier;
			if (action === "off" || (action === "" && tier !== "off")) next = "off";
			else if (action === "on" || action === "fast" || action === "priority" || action === "") next = "priority";
			else if (action === "ultrafast") next = "ultrafast";
			else {
				notify(ctx, `用法：${usage(ultrafastEnabled())}`, "warning");
				return;
			}
			setTier(next, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.on("before_provider_request", (event, ctx) => {
		if (disposed) return;
		const model = ctx.model;
		if (!model || !supportsFastMode(model)) return;
		if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return;
		const payload = event.payload as Record<string, unknown>;
		// A context model does not identify every background request.
		if (payload.model !== model.id) return;
		if (!Array.isArray(payload.messages) && !Array.isArray(payload.input) && typeof payload.input !== "string") return;
		const next = { ...payload };
		if (tier === "off") delete next.service_tier;
		else next.service_tier = tier;
		observations.set(modelKey(model), { requestedTier: tier, requestedAt: new Date().toISOString() });
		changed();
		return disposed ? undefined : next;
	});

	pi.on("provider_stream_event", (event, ctx) => {
		if (disposed) return;
		const model = ctx.model;
		if (!model || !supportsFastMode(model) || event.provider !== model.provider || event.api !== model.api || event.model !== model.id) return;
		if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return;
		const observation = observations.get(modelKey(model));
		if (!observation) return;
		const data = event.data as Record<string, unknown>;
		const response = typeof data.response === "object" && data.response !== null && !Array.isArray(data.response)
			? data.response as Record<string, unknown> : data;
		if (typeof response.id === "string") observation.responseId = response.id;
		// Responses' initial auto is not the terminal service tier.
		const terminal = data.type === "response.completed" || data.type === "response.failed" || data.type === "response.incomplete";
		if (terminal) {
			observation.terminalEvent = String(data.type);
			observation.actualTier = typeof response.service_tier === "string" ? response.service_tier : undefined;
		} else if (model.api === "openai-completions" && typeof data.service_tier === "string") {
			observation.actualTier = data.service_tier;
		}
		changed();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (disposed) return;
		// Runtime replacement gets a new controller. Old callbacks cannot revive it.
		disposed = true;
		tier = "off";
		observations.clear();
		listeners.clear();
		present(() => ctx.ui.setStatus("gpt-fast-mode", undefined));
	});

	return {
		snapshot: (ctx) => {
			const enabled = ultrafastEnabled();
			return {
				tier,
				supported: supportsFastMode(ctx.model),
				active: !disposed && supportsFastMode(ctx.model) && tier !== "off",
				ultrafastEnabled: !disposed && enabled,
				modelLabel: modelName(ctx.model),
			};
		},
		setTier,
		describe,
		subscribe: (listener) => {
			if (disposed) return () => {};
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
}
