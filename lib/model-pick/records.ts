import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { openJson, sealJson } from "./vault.js";
import type { TestRecord } from "./reference.js";
import type { RecordProtection } from "./protection.js";

type Dict = Record<string, unknown>;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_PAYLOAD = 4 * 1024 * 1024;
const object = (value: unknown): value is Dict => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Dict, allowed: string[], required = allowed): boolean =>
	Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192 && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function invalid(): never { throw new RecordError(); }

/** Validate JSON without calling getters, proxy traps or serialization hooks. */
function inspect(value: unknown, maxBytes = MAX_PAYLOAD): void {
	let nodes = 0;
	const ancestors = new Set<object>();
	function visit(v: unknown, depth: number): void {
		if (++nodes > 100_000 || depth > 64) invalid();
		if (v === null || typeof v === "string" || typeof v === "boolean") return;
		if (typeof v === "number") { if (!Number.isFinite(v)) invalid(); return; }
		if (typeof v !== "object" || types.isProxy(v) || ancestors.has(v)) invalid();
		const array = Array.isArray(v);
		const prototype = Object.getPrototypeOf(v);
		if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) invalid();
		const keys = Reflect.ownKeys(v);
		if (array && keys.length !== (v as unknown[]).length + 1) invalid();
		ancestors.add(v);
		for (const key of keys) {
			if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) invalid();
			if (array && key === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
			if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
			if (array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
			visit(descriptor.value, depth + 1);
		}
		ancestors.delete(v);
	}
	visit(value, 0);
	if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) invalid();
}
function eventValue(value: unknown): void {
	if (!object(value) || (value.attemptId !== undefined && !text(value.attemptId))) invalid();
	if (value.kind === "probe-start" || value.kind === "discovery-start") {
		const probe = value.kind === "probe-start";
		if (!exact(value, probe ? ["kind", "attemptId", "when", "provider", "modelId"] : ["kind", "attemptId", "when", "provider"]) ||
			!text(value.attemptId) || !timestamp(value.when) || !text(value.provider) || (probe && !text(value.modelId))) invalid();
	} else if (value.kind === "probe") {
		if (!exact(value, ["kind", "report", "attemptId"], ["kind", "report"]) || !object(value.report)) invalid();
		const r = value.report;
		if (!text(r.id) || !object(r.scope) || !exact(r.scope, ["provider", "modelId", "endpoint", "api", "credentialVersion"]) ||
			!Object.values(r.scope).every(text) || !timestamp(r.testedAt) || !timestamp(r.expiresAt) || r.expiresAt <= r.testedAt ||
			!object(r.fields) || !Array.isArray(r.verifiedFields) || !r.verifiedFields.every(text) ||
			!["passed", "failed", "inconclusive"].includes(r.status as string)) invalid();
	} else if (value.kind === "resolution") {
		if (!exact(value, ["kind", "id", "when", "provider", "modelId", "fields", "recommendation", "provenance", "edited", "phase"],
			["kind", "modelId", "fields", "provenance"]) || !text(value.modelId) || !object(value.fields) || !object(value.provenance)) invalid();
		if ((value.provider !== undefined && !text(value.provider)) || (value.id !== undefined && !text(value.id)) ||
			(value.when !== undefined && !timestamp(value.when)) || (value.recommendation !== undefined && !object(value.recommendation)) ||
			(value.edited !== undefined && (!Array.isArray(value.edited) || !value.edited.every(text))) ||
			(value.phase !== undefined && value.phase !== "proposed")) invalid();
	} else if (value.kind === "discovery") {
		if (!exact(value, ["kind", "when", "provider", "code", "count", "attemptId"], ["kind", "when", "provider", "code", "count"]) || !timestamp(value.when) ||
			!text(value.provider) || !text(value.code) || !timestamp(value.count) || value.count > 1000) invalid();
	} else invalid();
}
function ledgerValue(value: unknown, automatic: boolean): unknown[] {
	inspect(value);
	if (!object(value) || !exact(value, ["version", "kind", "events"]) || value.version !== 1 ||
		value.kind !== "model-pick-records" || !Array.isArray(value.events)) invalid();
	if (automatic) value.events.forEach(eventValue);
	return value.events;
}

/** Encrypted provenance/probe ledger. No raw requests, responses or credential values. */
export class RecordError extends Error {
	constructor() { super("安全记录未能保存；未写入明文替代文件"); this.name = "RecordError"; }
}
export class PickerRecords {
	private readonly agentDir: string;
	private readonly dir: string;
	private readonly file: string;
	constructor(agentDir: string, private readonly protection?: RecordProtection) {
		if (typeof agentDir !== "string" || !path.isAbsolute(agentDir) || agentDir.includes("\0")) invalid();
		this.agentDir = path.resolve(agentDir);
		this.dir = path.join(this.agentDir, "model-pick-data");
		this.file = path.join(this.dir, protection ? "records.auto.json" : "records.json");
	}
	hasData(): boolean { try { return this.metadata(this.file) !== null; } catch { throw new RecordError(); } }
	hasLegacyData(): boolean { try { return this.metadata(path.join(this.dir, "records.json")) !== null; } catch { throw new RecordError(); } }
	isUnlocked(): boolean { return this.protection !== undefined; }
	lock(): void { try { this.protection?.clear(); } catch { throw new RecordError(); } }
	dispose(): void { this.lock(); }
	private load(passphrase?: string): { raw: string | null; events: unknown[] } {
		try {
			if (!this.protection && (typeof passphrase !== "string" || passphrase.length === 0)) invalid();
			const raw = this.read(this.file);
			if (raw === null) return { raw, events: [] };
			const container: unknown = JSON.parse(raw);
			let data: unknown;
			if (this.protection) {
				inspect(container, MAX_FILE);
				if (!object(container) || !exact(container, ["version", "sealed"]) || container.version !== 2 || !object(container.sealed)) invalid();
				data = this.protection.open(container.sealed, "records");
			} else data = openJson(container, passphrase!);
			return { raw, events: ledgerValue(data, this.protection !== undefined) };
		} catch { throw new RecordError(); }
	}
	tests(passphrase?: string): TestRecord[] {
		return this.load(passphrase).events.filter((e): e is Dict => object(e) && e.kind === "probe").map(e => e.report as TestRecord);
	}
	append(event: unknown, passphrase?: string): void { this.appendMany([event], passphrase); }
	/** One authenticated ledger update for a bounded model batch, not N full re-encryptions. */
	appendMany(batch: unknown[], passphrase?: string): void {
		let lock: number | undefined;
		let lockIdentity: fs.Stats | undefined;
		let temp = "";
		const lockPath = path.join(this.dir, "records.lock");
		try {
			if (types.isProxy(batch) || !Array.isArray(batch) || batch.length < 1 || batch.length > 100) invalid();
			inspect(batch);
			if (this.protection) batch.forEach(eventValue);
			this.directories(this.agentDir, false);
			try { fs.mkdirSync(this.dir, { mode: 0o700 }); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			this.directories(this.dir, false);
			// Shared with explicit-password writers: neither mode may race the other.
			lock = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
			lockIdentity = fs.fstatSync(lock);
			fs.fchmodSync(lock, 0o600);
			const { raw, events } = this.load(passphrase);
			const data = { version: 1, kind: "model-pick-records", events: [...events, ...batch] };
			ledgerValue(data, this.protection !== undefined);
			const sealed: unknown = this.protection ? { version: 2, sealed: this.protection.seal(data, "records") } : sealJson(data, passphrase!);
			// The backend is trusted for confidentiality, not allowed unbounded/executable envelopes.
			// Envelope encoding has its own 8 MiB bound (ciphertext exceeds payload size).
			if (this.protection) {
				inspect(sealed, MAX_FILE);
				if (!object(sealed) || !object(sealed.sealed)) invalid();
			}
			const encoded = JSON.stringify(sealed);
			if (Buffer.byteLength(encoded) > MAX_FILE) invalid();
			temp = `${this.file}.${randomUUID()}.tmp`;
			fs.writeFileSync(temp, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
			const fd = fs.openSync(temp, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			if (this.read(this.file) !== raw) invalid();
			const actualLock = fs.lstatSync(lockPath);
			if (actualLock.isSymbolicLink() || actualLock.ino !== lockIdentity.ino || actualLock.dev !== lockIdentity.dev) invalid();
			fs.renameSync(temp, this.file);
			temp = "";
			const directory = fs.openSync(this.dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
			try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
		} catch { throw new RecordError(); }
		finally {
			if (temp) { try { fs.unlinkSync(temp); } catch {} }
			if (lock !== undefined) {
				try { fs.closeSync(lock); } catch {}
				try {
					const actual = fs.lstatSync(lockPath);
					if (!actual.isSymbolicLink() && actual.ino === lockIdentity?.ino && actual.dev === lockIdentity?.dev) fs.unlinkSync(lockPath);
				} catch {}
			}
		}
	}
	private directories(directory: string, allowMissing: boolean): boolean {
		const root = path.parse(directory).root;
		let current = root;
		for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
			current = path.join(current, part);
			let stat: fs.Stats;
			try { stat = fs.lstatSync(current); } catch (error) {
				if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw error;
			}
			if (stat.isSymbolicLink() || !stat.isDirectory() || (current === this.dir && (stat.mode & 0o777) !== 0o700)) invalid();
		}
		return true;
	}
	private metadata(file: string): fs.Stats | null {
		if (!this.directories(path.dirname(file), true)) return null;
		let stat: fs.Stats;
		try { stat = fs.lstatSync(file); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_FILE) invalid();
		return stat;
	}
	private read(file: string): string | null {
		const stat = this.metadata(file);
		if (!stat) return null;
		const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			const initial = fs.fstatSync(fd);
			if (!initial.isFile() || initial.ino !== stat.ino || initial.dev !== stat.dev) invalid();
			const bytes = fs.readFileSync(fd);
			if (bytes.length > MAX_FILE) invalid();
			const raw = bytes.toString("utf8");
			if (!Buffer.from(raw, "utf8").equals(bytes)) invalid();
			const final = this.metadata(file);
			const actual = fs.fstatSync(fd);
			if (!final || final.ino !== initial.ino || final.dev !== initial.dev || actual.size !== initial.size ||
				actual.mtimeMs !== initial.mtimeMs || actual.ctimeMs !== initial.ctimeMs) invalid();
			return raw;
		} finally { fs.closeSync(fd); }
	}
}
