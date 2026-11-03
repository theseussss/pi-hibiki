import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPicker, { openPicker, type PickerHostOptions } from "./model-pick.js";
import { resolvePickerStorage } from "../lib/model-pick/storage-context.js";
import { registerFastPolicy } from "../lib/fast.js";
import { getHibikiConfigPath, readHibikiConfig } from "../lib/config.js";
import { DISPLAY_NAME, VERSION } from "../lib/identity.js";

/** The package declares this one public entry; picker and Fast are internal modules. */
export default function hibikiModelsExtension(pi: ExtensionAPI, options: Pick<PickerHostOptions, "storageOverride"> = {}): void {
	let config: ReturnType<typeof readHibikiConfig> = { fast: { enableUltrafast: false } };
	// Registration order matters: Fast restores branch state in its session_start
	// listener. Resolve the actual native profile before that listener, with no
	// factory IO and no CLI-HOME fallback for unknown SDK storage.
	pi.on("session_start", async (_event, ctx) => {
		config = { fast: { enableUltrafast: false } };
		const storage = await resolvePickerStorage(ctx.modelRegistry, options.storageOverride);
		if (storage) config = readHibikiConfig(getHibikiConfigPath(storage.agentDir));
	});
	const fast = registerFastPolicy(pi, { ultrafastEnabled: () => config.fast.enableUltrafast });
	registerPicker(pi, { fast, storageOverride: options.storageOverride });
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
				ctx.ui.notify(`${DISPLAY_NAME}\n/hibiki 或 /models、Ctrl+L：原模型矩阵\n/hibiki fast 或 /models fast：当前会话 Fast 面板\n/fast [on|off|ultrafast|status|check]：原快捷入口，status/check 不发请求\nTab/Shift+Tab：对象与可见动作；Alt+数字直达；Alt+M/F6 进入动作\nAlt+1 收藏；原 Alt+N/X/D/T、调序与会话 Fast 保留\n模型选择与管理沿用原数据和受保护归档，不因品牌改名迁移。`, "info");
				return;
			}
			if (!["", "fast", "manage", "providers"].includes(action)) {
				ctx.ui.notify("用法：/hibiki [fast|manage|providers|status|help]", "warning");
				return;
			}
			await openPicker(pi, ctx, action === "manage" || action === "providers", action === "providers", fast, action === "fast", options.storageOverride);
		},
	});
}
