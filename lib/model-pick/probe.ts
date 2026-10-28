import { randomUUID } from "node:crypto";
import type { Scope, TestRecord } from "./reference.js";

export type ProbeCode = "ok" | "auth" | "limited" | "server" | "protocol" | "timeout" | "cancelled" | "network" | "unsupported";
export interface ProbeReport extends TestRecord {
	code: ProbeCode;
	elapsedMs: number;
	checks: { text: "passed" | "inconclusive" };
}
export class ProbeError extends Error {
	constructor(readonly code: ProbeCode) { super(`上游检查未完成（${code}）`); this.name = "ProbeError"; }
}
export interface ProbeOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetcher?: typeof fetch;
	checkDeadline?: () => void;
}
const APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const SENTINEL = "MODEL_PICK_OK";
const MAX_RESPONSE = 256 * 1024;
/** Bound credential resolution and the request together; late resolution cannot win. */
export async function withProbeDeadline<T>(task: (checkDeadline: () => void) => Promise<T>, controller: AbortController, timeoutMs = 10000): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new ProbeError("protocol");
	if (controller.signal.aborted) throw new ProbeError("cancelled");
	let expired = false;
	const deadline = performance.now() + timeoutMs;
	const checkDeadline = () => {
		if (performance.now() >= deadline) { expired = true; controller.abort(); throw new ProbeError("timeout"); }
		if (controller.signal.aborted) throw new ProbeError(expired ? "timeout" : "cancelled");
	};
	let rejectAbort: (error: unknown) => void = () => {};
	const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	const onAbort = () => rejectAbort(new ProbeError(expired ? "timeout" : "cancelled"));
	controller.signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
	try {
		return await Promise.race([Promise.resolve().then(() => {
			checkDeadline();
			return task(checkDeadline);
		}).then((result) => { checkDeadline(); return result; }), stopped]);
	} finally { clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort); }
}
function credentialFragments(headers: Record<string, string>): string[] {
	const values = new Set<string>();
	for (const raw of Object.values(headers)) {
		if (!raw) continue;
		values.add(raw);
		const normalized = raw.trim();
		values.add(normalized);
		const payload = normalized.replace(/^\S+\s+/, "");
		values.add(payload);
		// Basic credentials may be reflected either as the Base64 payload or its parts.
		if (/^Basic\s+/i.test(normalized)) {
			let bytes: Buffer | undefined;
			try {
				bytes = Buffer.from(payload, "base64");
				const decoded = bytes.toString("utf8");
				values.add(decoded);
				const colon = decoded.indexOf(":");
				if (colon >= 0) { values.add(decoded.slice(0, colon)); values.add(decoded.slice(colon + 1)); }
			} finally { bytes?.fill(0); }
		}
		for (const part of payload.split(/[\s,;="']+/)) if (part) values.add(part);
	}
	return [...values].filter(Boolean);
}
export function validateEndpoint(endpoint: string): URL {
	try {
		const u = new URL(endpoint);
		if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) throw new Error();
		return u;
	} catch { throw new ProbeError("protocol"); }
}
function validateScope(scope: Scope): void {
	validateEndpoint(scope.endpoint);
	if (!APIS.has(scope.api)) throw new ProbeError("unsupported");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+\-]{0,255}$/.test(scope.modelId) || scope.modelId.split("/").some((part) => part === "." || part === "..")) throw new ProbeError("protocol");
	for (const s of [scope.provider, scope.modelId, scope.credentialVersion]) {
		if (typeof s !== "string" || !s || s.length > 512 || /[\u0000-\u001f\u007f]/u.test(s)) throw new ProbeError("protocol");
	}
}
function endpoint(scope: Scope, suffix: string): string {
	const url = validateEndpoint(scope.endpoint);
	url.pathname = `${url.pathname.replace(/\/$/, "")}/${suffix}`;
	return url.toString();
}
function safeHeaders(headers: Record<string, string> = {}): Record<string, string> {
	try {
		const out: Record<string, string> = { "content-type": "application/json" };
		for (const [key, value] of Object.entries(headers)) {
			if (!/^[a-zA-Z0-9-]+$/.test(key) || typeof value !== "string" || /[\r\n\u0000]/.test(value)) throw new Error();
			if (["host", "content-length"].includes(key.toLowerCase())) throw new Error();
			out[key] = value;
		}
		return out;
	} catch { throw new ProbeError("protocol"); }
}
async function jsonBounded(response: Response): Promise<any> {
	if (!response.body) throw new ProbeError("protocol");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_RESPONSE) { void reader.cancel().catch(() => {}); throw new ProbeError("protocol"); }
			chunks.push(value);
		}
		const data = new Uint8Array(length);
		let at = 0;
		for (const c of chunks) { data.set(c, at); at += c.length; }
		try { return JSON.parse(new TextDecoder().decode(data)); }
		catch { throw new ProbeError("protocol"); }
	} finally { reader.releaseLock(); }
}
async function request(scope: Scope, suffix: string, method: string, body: unknown, options: ProbeOptions): Promise<any> {
	validateScope(scope);
	if (options.signal?.aborted) throw new ProbeError("cancelled");
	const timeout = options.timeoutMs ?? 10000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new ProbeError("protocol");
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectAbort: (reason: unknown) => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
	const onCancel = () => { abort.abort(); rejectAbort(new ProbeError("cancelled")); };
	options.signal?.addEventListener("abort", onCancel, { once: true });
	timer = setTimeout(() => { abort.abort(); rejectAbort(new ProbeError("timeout")); }, timeout);
	const url = endpoint(scope, suffix);
	const task = (async () => {
		const headers = safeHeaders(options.headers);
		if (scope.api === "anthropic-messages" && !Object.keys(headers).some((h) => h.toLowerCase() === "anthropic-version")) headers["anthropic-version"] = "2023-06-01";
		options.checkDeadline?.();
		const response = await (options.fetcher ?? fetch)(url, {
			method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: abort.signal, redirect: "error", credentials: "omit", cache: "no-store",
		});
		if (response.url && new URL(response.url).origin !== new URL(url).origin) throw new ProbeError("protocol");
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			throw new ProbeError(response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "limited" : response.status >= 500 ? "server" : "protocol");
		}
		return jsonBounded(response);
	})();
	try { return await Promise.race([task, cancelled]); }
	catch (error) { throw error instanceof ProbeError ? error : new ProbeError(options.signal?.aborted ? "cancelled" : "network"); }
	finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onCancel); }
}
export async function discoverModels(scope: Scope, options: ProbeOptions = {}): Promise<string[]> {
	const data = await request(scope, "models", "GET", undefined, options);
	const list = scope.api === "google-generative-ai" ? data?.models : data?.data;
	if (!Array.isArray(list)) throw new ProbeError("protocol");
	// Only model IDs enter the UI. Never preserve response bodies or server messages.
	const secrets = credentialFragments(options.headers ?? {});
	const ids: string[] = [];
	for (const item of list) {
		const id = scope.api === "google-generative-ai" ? item?.name : item?.id;
		if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+\-]{0,255}$/.test(id) || secrets.some((secret) => id.includes(secret))) continue;
		if (!ids.includes(id)) ids.push(id);
		if (ids.length >= 1000) break;
	}
	return ids;
}
export async function probeText(scope: Scope, options: ProbeOptions = {}): Promise<ProbeReport> {
	validateScope(scope);
	const now = Date.now();
	let suffix: string;
	let body: unknown;
	const prompt = `Reply with exactly ${SENTINEL}.`;
	if (scope.api === "openai-completions") {
		suffix = "chat/completions";
		body = { model: scope.modelId, messages: [{ role: "user", content: prompt }], max_tokens: 32, stream: false };
	} else if (scope.api === "openai-responses") {
		suffix = "responses";
		body = { model: scope.modelId, input: prompt, max_output_tokens: 32, store: false };
	} else if (scope.api === "anthropic-messages") {
		suffix = "messages";
		body = { model: scope.modelId, messages: [{ role: "user", content: prompt }], max_tokens: 32 };
	} else {
		suffix = `${scope.modelId.startsWith("models/") ? scope.modelId : `models/${scope.modelId}`}:generateContent`;
		body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 32 } };
	}
	let code: ProbeCode = "ok";
	try {
		const data = await request(scope, suffix, "POST", body, options);
		let text: unknown;
		if (scope.api === "openai-completions") text = data?.choices?.[0]?.message?.content;
		else if (scope.api === "openai-responses") text = data?.output?.flatMap((o: any) => o?.content ?? []).filter((c: any) => c?.type === "output_text").map((c: any) => c.text).join("");
		else if (scope.api === "anthropic-messages") text = data?.content?.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
		else text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("");
		if (typeof text !== "string" || text.trim() !== SENTINEL) code = "protocol";
	} catch (error) { code = error instanceof ProbeError ? error.code : "network"; }
	return {
		id: randomUUID(), scope: { ...scope }, testedAt: now, expiresAt: now + 3600000,
		status: code === "ok" ? "passed" : "inconclusive", fields: {}, verifiedFields: [],
		checks: { text: code === "ok" ? "passed" : "inconclusive" }, code, elapsedMs: Math.max(0, Date.now() - now),
	};
}
