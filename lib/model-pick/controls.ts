import {
	decodeKittyPrintable, getKeybindings, Input, isKeyRelease, isKeyRepeat, Key, matchesKey,
	SelectList, type SelectListTheme, truncateToWidth,
} from "@earendil-works/pi-tui";

export type Paint = (kind: "accent" | "text" | "dim" | "error", value: string) => string;
export interface MenuAction { label: string; run(): void; description?: string }

const rows = (value: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
const singleLine = (value: string) => value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");

/** A frame-free native list. maxRows includes SelectList's own scroll-info row. */
export class NativeMenu {
	private readonly items: MenuAction[];
	private list!: SelectList;
	private index = 0;
	private visible = 1;

	constructor(items: MenuAction[], private readonly paint: Paint, private readonly onBack: () => void, selected = 0) {
		this.items = [...items];
		this.index = Math.max(0, Math.min(rows(selected), this.items.length - 1));
		this.rebuild();
	}

	get selected(): number {
		const item = this.list.getSelectedItem();
		if (item) this.index = Number(item.value);
		return this.index;
	}

	setSelectedIndex(index: number): void {
		this.index = Math.max(0, Math.min(rows(index), this.items.length - 1));
		this.list.setSelectedIndex(this.index);
	}

	private rebuild(): void {
		const theme: SelectListTheme = {
			selectedPrefix: (s) => this.paint("accent", s),
			selectedText: (s) => this.paint("accent", s),
			description: (s) => this.paint("dim", s),
			scrollInfo: (s) => this.paint("dim", s),
			noMatch: () => this.paint("dim", "  暂无选项"),
		};
		this.list = new SelectList(this.items.map((item, index) => ({
			value: String(index), label: singleLine(item.label), description: item.description,
		})), this.visible, theme);
		this.list.setSelectedIndex(this.index);
		this.list.onSelectionChange = (item) => { this.index = Number(item.value); };
		this.list.onSelect = (item) => { this.items[Number(item.value)]?.run(); };
		this.list.onCancel = this.onBack;
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		const kb = getKeybindings();
		if (isKeyRepeat(data) && (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel"))) return;
		this.list.handleInput(data);
	}

	render(width: number, maxRows: number): string[] {
		const height = rows(maxRows);
		width = rows(width);
		if (!height || !width) return [];
		const visible = Math.max(1, height - (this.items.length > height ? 1 : 0));
		if (visible !== this.visible) {
			this.index = this.selected;
			this.visible = visible;
			// SelectList has no public maxVisible setter. Recreate it via its public API.
			this.rebuild();
		}
		// At height 1 only the native selected row fits; omit the scroll-info row.
		return this.list.render(width).slice(0, height).map((line) => truncateToWidth(line, width, ""));
	}
}

export interface ModelBasketOptions {
	candidates: readonly string[];
	blockedIds?: readonly string[];
	selected?: readonly string[];
	query?: string;
	paint: Paint;
	onChange: (ids: string[]) => void;
	onEdit: (id: string) => void;
	onSubmit: (ids: string[]) => void;
	onBack: () => void;
	onCancel?: () => void;
	requestRender: () => void;
	describe?: (id: string) => string;
	onDiscover?: () => void;
	saveLabel?: (count: number) => string;
}

type Focus = "search" | "candidates" | "selected" | "actions";
const focusOrder: Focus[] = ["search", "candidates", "selected", "actions"];
const validId = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+\-]{0,255}$/;
const MAX_PICKED = 100;

/** In-memory selection only. The parent owns discovery, parameters and persistence. */
export class ModelBasket {
	private readonly input: Input;
	private candidates: string[] = [];
	private matches: string[] = [];
	private picked: string[];
	private readonly blocked: Set<string>;
	private descriptions = new Map<string, string>();
	private candidateMenu!: NativeMenu;
	private pickedMenu!: NativeMenu;
	private actionMenu!: NativeMenu;
	private actionCount = 0;
	private actionKeys: string[] = [];
	private focus: Focus = "search";
	private pane: "candidates" | "selected" = "candidates";
	private focused = true;
	private status = "";
	private error = "";
	private pasting = false;
	private pasteTail = "";

	constructor(private readonly options: ModelBasketOptions) {
		this.blocked = new Set(options.blockedIds ?? []);
		this.picked = [...(options.selected ?? [])];
		if (this.picked.length > MAX_PICKED || new Set(this.picked).size !== this.picked.length || this.picked.some((id) => !validId.test(id) || this.blocked.has(id))) {
			throw new Error("已选模型须为不超过100个、不重复的准确模型 ID");
		}
		this.input = new Input({ prompt: "› ", placeholder: "搜索或输入模型 ID", placeholderStyle: (s) => options.paint("dim", s) });
		this.input.setValue(options.query ?? "");
		this.input.handleInput("\x1b[F"); // Public Input editing API: start an initial query at its end.
		this.input.onSubmit = () => this.addManual();
		this.input.onEscape = options.onBack;
		this.input.focused = true;
		this.candidates = [...new Set(options.candidates)].filter((id) => validId.test(id) && !this.blocked.has(id));
		this.cacheDescriptions();
		this.rebuildCandidates();
		this.rebuildPicked();
		this.rebuildActions();
	}

	get selectedIds(): string[] { return [...this.picked]; }
	get query(): string { return this.input.getValue(); }

	setFocused(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
		if (!focused && this.pasting) {
			this.input.handleInput("\x1b[201~"); this.pasting = false; this.pasteTail = "";
			this.rebuildCandidates();
		}
		this.input.focused = focused && this.focus === "search";
		this.options.requestRender();
	}

	setCandidates(ids: readonly string[]): void {
		this.candidates = [...new Set(ids)].filter((id) => validId.test(id) && !this.blocked.has(id));
		// Explicit parent refresh also refreshes cached summaries after a parameter edit.
		this.cacheDescriptions();
		this.rebuildCandidates();
		this.rebuildPicked();
		if (this.focus === "candidates" && !this.matches.length) this.changeFocus("search");
		this.options.requestRender();
	}

	setStatus(status: string): void { this.status = singleLine(status); this.options.requestRender(); }
	setError(error: string): void { this.error = singleLine(error); this.options.requestRender(); }

	private cacheDescriptions(): void {
		this.descriptions = new Map([...new Set([...this.candidates, ...this.picked])].map((id) => [id, singleLine(this.options.describe?.(id) ?? "")]));
	}

	private menu(items: MenuAction[], area: Focus, selected = 0): NativeMenu {
		return new NativeMenu(items, (kind, value) => {
			const active = this.focused && this.focus === area;
			return this.options.paint(kind === "accent" && !active ? "text" : kind, !active ? value.replace(/^→ /, "  ") : value);
		}, this.options.onBack, selected);
	}

	private rebuildCandidates(): void {
		const previous = this.candidateMenu ? this.matches[this.candidateMenu.selected] : undefined;
		const query = this.query.trim().toLowerCase();
		this.matches = this.candidates.filter((id) => id.toLowerCase().includes(query));
		this.candidateMenu = this.menu(this.matches.map((id) => ({
			label: `[${this.picked.includes(id) ? "x" : " "}] ${id}`,
			description: this.descriptions.get(id), run: () => this.toggle(id),
		})), "candidates", previous === undefined ? 0 : Math.max(0, this.matches.indexOf(previous)));
	}

	private rebuildPicked(): void {
		const previous = this.pickedMenu?.selected ?? 0;
		this.pickedMenu = this.menu(this.picked.map((id) => ({
			label: `参数 · ${id}`, description: this.descriptions.get(id), run: () => this.options.onEdit(id),
		})), "selected", previous);
	}

	private rebuildActions(): void {
		const previous = this.actionKeys[this.actionMenu?.selected ?? 0];
		const keys = [...(this.picked.length ? ["save"] : []), "manual", ...(this.options.onDiscover ? ["discover"] : [])];
		const items: MenuAction[] = [
			...(this.picked.length ? [{ label: `${this.options.saveLabel?.(this.picked.length) ?? `添加${this.picked.length}个模型`} · Ctrl+S`, run: () => this.submit() }] : []),
			{ label: "手动输入模型 ID", run: () => { if (this.query.trim()) this.addManual(); else this.changeFocus("search"); } },
		];
		if (this.options.onDiscover) items.push({ label: "读取模型清单…", run: this.options.onDiscover });
		this.actionCount = items.length;
		this.actionKeys = keys;
		this.actionMenu = this.menu(items, "actions", Math.max(0, keys.indexOf(previous)));
	}

	private changeFocus(focus: Focus, preservePane = false): void {
		this.focus = focus;
		if (focus === "candidates" || focus === "selected") this.pane = focus;
		if (focus === "search" && !preservePane) this.pane = "candidates";
		this.input.focused = this.focused && focus === "search";
	}

	private enterBrowser(last: boolean): void {
		const area = this.pane === "selected" && this.picked.length ? "selected" : this.matches.length ? "candidates" : this.picked.length ? "selected" : undefined;
		if (!area) { this.changeFocus("search", true); return; }
		this.changeFocus(area);
		const menu = area === "candidates" ? this.candidateMenu : this.pickedMenu;
		menu.setSelectedIndex(last ? (area === "candidates" ? this.matches.length : this.picked.length) - 1 : 0);
	}

	private navigate(data: string, down: boolean): void {
		if (this.focus === "search") {
			if (down && (this.matches.length || this.picked.length)) this.enterBrowser(false);
			else { this.changeFocus("actions"); this.actionMenu.setSelectedIndex(down ? 0 : this.actionCount - 1); }
			return;
		}
		const menu = this.focus === "candidates" ? this.candidateMenu : this.focus === "selected" ? this.pickedMenu : this.actionMenu;
		const count = this.focus === "candidates" ? this.matches.length : this.focus === "selected" ? this.picked.length : this.actionCount;
		const edge = down ? menu.selected >= count - 1 : menu.selected === 0;
		if (!edge) { menu.handleInput(data); return; }
		if (this.focus === "actions") {
			if (down) this.changeFocus("search", true);
			else this.enterBrowser(true);
		} else if (down) { this.changeFocus("actions"); this.actionMenu.setSelectedIndex(0); }
		else this.changeFocus("search", true);
	}

	private changed(): void {
		this.error = "";
		// The parent resolves picked parameters from its cache in this explicit callback.
		this.options.onChange(this.selectedIds);
		this.cacheDescriptions();
		this.rebuildCandidates();
		this.rebuildPicked();
		this.rebuildActions();
	}

	private addManual(): void {
		const ids = this.query.split(/[,，]/).map((id) => id.trim());
		if (!ids.length || ids.some((id) => !validId.test(id))) {
			this.error = "请输入准确模型 ID，多个用逗号分隔";
		} else if (new Set(ids).size !== ids.length || ids.some((id) => this.picked.includes(id))) {
			this.error = "模型 ID 重复，本次未添加";
		} else if (ids.some((id) => this.blocked.has(id))) {
			this.error = "模型已存在，本次未添加";
		} else if (this.picked.length + ids.length > MAX_PICKED) {
			this.error = "最多选择100个模型，本次未添加";
		} else {
			this.picked.push(...ids);
			this.input.setValue("");
			this.changed();
		}
	}

	private toggle(id: string): void {
		const index = this.picked.indexOf(id);
		if (index >= 0) this.picked.splice(index, 1);
		else if (this.blocked.has(id)) { this.error = "模型已存在，本次未添加"; return; }
		else if (!validId.test(id)) { this.error = "请输入准确模型 ID"; return; }
		else if (this.picked.length >= MAX_PICKED) { this.error = "最多选择100个模型"; return; }
		else this.picked.push(id);
		this.changed();
	}

	private submit(): void {
		if (!this.picked.length) { this.error = "请先选择至少一个模型"; return; }
		this.error = "";
		this.options.onSubmit(this.selectedIds);
	}

	private editSearch(data: string): void {
		const before = this.query;
		this.input.handleInput(data);
		if (before !== this.query) {
			this.error = "";
			this.pane = "candidates";
			this.rebuildCandidates();
		}
	}

	handleInput(data: string): void {
		if (!this.focused) return;
		// Let Input own bracketed paste, including chunks that look like commands.
		if (this.pasting || data.includes("\x1b[200~")) {
			this.changeFocus("search");
			this.pasting = !(this.pasteTail + data).includes("\x1b[201~");
			this.pasteTail = this.pasting ? (this.pasteTail + data).slice(-5) : "";
			this.editSearch(data);
			this.options.requestRender();
			return;
		}
		if (isKeyRelease(data)) return;
		const kb = getKeybindings();
		const cancel = kb.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
		const save = matchesKey(data, Key.ctrl("s"));
		const tab = kb.matches(data, "tui.input.tab");
		const backTab = matchesKey(data, Key.shift("tab"));
		const confirm = kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.input.submit") || data === "\n";
		const remove = this.focus === "selected" && (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace));
		if (isKeyRepeat(data) && (cancel || save || tab || backTab || confirm || remove)) return;
		if (cancel) { if (matchesKey(data, Key.ctrl("c"))) (this.options.onCancel ?? this.options.onBack)(); else this.options.onBack(); }
		else if (save) this.submit();
		else if (tab || backTab) {
			const available = focusOrder.filter((area) => area !== "candidates" && area !== "selected" || area === "candidates" && this.matches.length > 0 || area === "selected" && this.picked.length > 0);
			const index = Math.max(0, available.indexOf(this.focus));
			this.changeFocus(available[(index + (backTab ? available.length - 1 : 1)) % available.length]);
		} else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.navigate(data, kb.matches(data, "tui.select.down"));
		} else if (this.focus === "search") this.editSearch(data);
		else if (this.focus === "candidates" && matchesKey(data, Key.right)) {
			if (this.picked.length) this.changeFocus("selected");
		} else if (this.focus === "selected" && matchesKey(data, Key.left)) {
			this.changeFocus(this.matches.length ? "candidates" : "search");
		} else if (remove) {
			this.picked.splice(this.pickedMenu.selected, 1); this.changed();
			if (!this.picked.length) this.changeFocus("search");
		} else if (confirm) {
			const menu = this.focus === "candidates" ? this.candidateMenu : this.focus === "selected" ? this.pickedMenu : this.actionMenu;
			menu.handleInput(data);
		} else if (data.length > 0 && (decodeKittyPrintable(data) !== undefined || !/[\x00-\x1f\x7f-\x9f]/.test(data) || matchesKey(data, Key.backspace) || matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("w")))) {
			this.changeFocus("search");
			this.editSearch(data);
		}
		this.options.requestRender();
	}

	render(width: number, height: number): string[] {
		width = rows(width); height = rows(height);
		if (!width || !height) return [];
		// One switchable browsing pane keeps 100 picked items from pushing Save away.
		const selectedPane = this.pane === "selected";
		const menu = selectedPane ? this.pickedMenu : this.candidateMenu;
		const id = selectedPane ? this.picked[menu.selected] : this.matches[menu.selected];
		const title = selectedPane ? `已选 ${this.picked.length} · ← 候选 · Enter 参数 · Delete 取消选择` : `候选 ${this.matches.length} · 已选 ${this.picked.length}${this.picked.length ? `（→）：${this.picked.join("、")}` : ""}`;
		const summaryId = this.focus === "search" || this.focus === "actions" ? this.picked.at(-1) ?? id : id;
		const summary = this.error || this.status || (summaryId && `${summaryId}${this.descriptions.get(summaryId) ? ` · ${this.descriptions.get(summaryId)}` : ""}`) || "回车添加 ID，或勾选候选";
		const actionRows = Math.min(this.actionCount, Math.max(1, height - 3));
		const showHint = height >= 9;
		const listRows = Math.max(0, Math.min(20, height - 3 - actionRows - Number(showHint)));
		const lines = [
			...this.input.render(width),
			this.options.paint(this.focus === this.pane && this.focused ? "accent" : "text", title),
			...menu.render(width, listRows),
			this.options.paint(this.error ? "error" : "dim", summary),
			...this.actionMenu.render(width, actionRows),
		];
		if (showHint) lines.push(this.options.paint("dim", this.focus === "search" ? "↑↓ 导航 · Enter 加入 ID · Ctrl+S 添加" : `↑↓ 导航${this.focus === "candidates" && this.picked.length ? " · → 已选" : this.focus === "selected" ? " · ← 候选" : ""} · Ctrl+S 添加`));
		return lines.slice(0, height).map((line) => truncateToWidth(line, width, ""));
	}
}
