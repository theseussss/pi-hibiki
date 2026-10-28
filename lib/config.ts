import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface HibikiConfig { fast: { enableUltrafast: boolean }; }
export function getHibikiConfigPath(agentDir = path.join(os.homedir(), ".pi", "agent")): string {
	return path.join(agentDir, "pi-hibiki.json");
}

/** No write or implicit legacy import. Missing, damaged or unsafe config never enables Ultrafast. */
export function readHibikiConfig(file = getHibikiConfigPath()): HibikiConfig {
	let enabled = false;
	try {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) return { fast: { enableUltrafast: false } };
		const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			const current = fs.fstatSync(fd);
			if (current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1 || current.size > 65536) return { fast: { enableUltrafast: false } };
			const data: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
			if (data && typeof data === "object" && !Array.isArray(data)) {
				const fast = (data as Record<string, unknown>).fast;
				if (fast && typeof fast === "object" && !Array.isArray(fast)) enabled = (fast as Record<string, unknown>).enableUltrafast === true;
			}
		} finally { fs.closeSync(fd); }
	} catch { /* Default remains opt-in, with no repair writes or fallback to donor state. */ }
	return { fast: { enableUltrafast: enabled } };
}
