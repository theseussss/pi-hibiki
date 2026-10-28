import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerPicker, { openPicker } from "./model-pick.js";
import { registerFastPolicy } from "../lib/fast.js";
import { readHibikiConfig } from "../lib/config.js";
import { DISPLAY_NAME, VERSION } from "../lib/identity.js";

/** The package declares this one public entry; picker and Fast are internal modules. */
export default function hibikiModelsExtension(pi: ExtensionAPI): void {
	let config: ReturnType<typeof readHibikiConfig> | undefined;
	const fast = registerFastPolicy(pi, { ultrafastEnabled: () => (config ??= readHibikiConfig()).fast.enableUltrafast });
	registerPicker(pi, { fast });
	pi.registerCommand("hibiki", {
		description: `${DISPLAY_NAME}：模型选择、供应商管理与会话 Fast；/hibiki [fast|manage|providers|status|help]`,
		getArgumentCompletions: (prefix) => ["fast", "manage", "providers", "status", "help"].filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status") {
				ctx.ui.notify(`${DISPLAY_NAME} ${VERSION}\n${fast.describe(ctx)}\n当前/默认模型、焦点候选与会话档位彼此独立。`, "info");
				return;
			}
			if (action === "help") {
				ctx.ui.notify(`${DISPLAY_NAME}\n/hibiki 或 /models、Ctrl+L：原模型矩阵\n/hibiki fast 或 /models fast：当前会话 Fast 面板\n/fast [on|off|ultrafast|status|check]：原快捷入口，status/check 不发请求\nAlt+M：当前对象操作与会话 Fast；原 Alt+N/X/D/T、收藏与调序保留\n模型选择与管理沿用原数据和受保护归档，不因品牌改名迁移。`, "info");
				return;
			}
			if (!["", "fast", "manage", "providers"].includes(action)) {
				ctx.ui.notify("用法：/hibiki [fast|manage|providers|status|help]", "warning");
				return;
			}
			await openPicker(pi, ctx, action === "manage" || action === "providers", action === "providers", fast, action === "fast");
		},
	});
}
