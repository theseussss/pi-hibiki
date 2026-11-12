import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerPicker, { type PickerHostOptions } from "./model-pick.js";
import { resolvePickerStorage } from "../lib/model-pick/storage-context.js";
import { registerFastPolicy } from "../lib/fast.js";
import { getHibikiConfigPath, readHibikiConfig } from "../lib/config.js";
import { DISPLAY_NAME } from "../lib/identity.js";

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
	const picker = registerPicker(pi, { fast, storageOverride: options.storageOverride });
	// Keep the old command/entry/config identities; this is a product rename,
	// not a user-data migration or a second picker/Fast instance.
	pi.registerCommand("hibiki", {
		...picker,
		description: `${DISPLAY_NAME}：兼容旧命令；请用 /models [manage|providers|fast|status|help]`,
	});
}
