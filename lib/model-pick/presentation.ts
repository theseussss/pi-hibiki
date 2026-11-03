import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { NativeMenu, type Paint, type MenuAction } from './controls.js';

export interface SheetRow { label: string; value: string; source?: string; tone?: 'text' | 'accent' | 'success' | 'warning' }
export interface SheetSection { title?: string; rows?: SheetRow[]; lines?: string[]; tone?: 'text' | 'dim' | 'warning' }
export interface SheetContent { stage: string; title: string; subtitle?: string; sections: SheetSection[] }
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');

/** Keep shortcut tokens intact. No partial key labels at the right edge. */
export function packHints(hints: readonly string[], width: number): string[] {
  const available = Math.max(1, width - 1); const lines: string[] = []; let line = '';
  for (const hint of hints) {
    if (visibleWidth(hint) > available) continue;
    const next = line ? `${line} · ${hint}` : hint;
    if (visibleWidth(next) <= available) line = next;
    else { if (line) lines.push(` ${line}`); line = hint; }
  }
  if (line) lines.push(` ${line}`);
  return lines;
}

/** Pure data-to-lines rendering shared by the report, consent and progress page. */
export function sheetLines(content: SheetContent, width: number, paint: Paint): { header: string[]; body: string[] } {
  const w = Math.max(1, width - 1); const header: string[] = [];
  const wrap = (value: string, indent = ' ') => wrapTextWithAnsi(value, Math.max(1, w - visibleWidth(indent))).map(line => indent + line);
  header.push(paint('accent', ' Hibiki · 模型工作台'));
  header.push(paint('dim', ` 添加模型 / ${content.stage}`));
  header.push(...wrap(paint('text', clean(content.title))));
  const body: string[] = [];
  if (content.subtitle) body.push(...wrap(paint('dim', clean(content.subtitle))));
  let firstSection = true;
  for (const section of content.sections) {
    if (section.title) {
      if (body.length && !firstSection) body.push('');
      body.push(...wrap(paint('accent', clean(section.title))));
    }
    firstSection = false;
    const rows = section.rows ?? [];
    const labelWidth = Math.min(16, Math.max(0, ...rows.map(row => visibleWidth(clean(row.label)))));
    for (const row of rows) {
      const label = clean(row.label), value = clean(row.value), source = row.source ? clean(row.source) : '';
      if (w >= 58) {
        const prefix = `   ${label}${' '.repeat(Math.max(0, labelWidth - visibleWidth(label)))}  `;
        const tail = paint(row.tone ?? 'text', value) + (source ? paint('dim', `  · ${source}`) : '');
        const parts = wrapTextWithAnsi(tail, Math.max(1, w - visibleWidth(prefix)));
        parts.forEach((part, index) => body.push((index === 0 ? paint('text', prefix) : ' '.repeat(visibleWidth(prefix))) + part));
      } else {
        body.push(...wrap(paint('text', label), '   '));
        body.push(...wrap(paint(row.tone ?? 'text', value) + (source ? paint('dim', ` · ${source}`) : ''), '     '));
      }
    }
    for (const line of section.lines ?? []) body.push(...wrap(paint(section.tone ?? 'text', clean(line))));
  }
  return { header, body };
}

export interface SheetAction extends MenuAction { requiresReview?: boolean }
/** A scrollable sheet above one native action list. No I/O or probe policy. */
export class ReviewSheet {
  private menu: NativeMenu;
  private offset = 0;
  private page = 1;
  private total = 0;
  private size = '';
  private seen = new Set<number>();
  private ready = false;
  private error = '';
  constructor(private readonly content: SheetContent, private readonly paint: Paint,
    actions: SheetAction[], private readonly back: () => void, private readonly redraw: () => void,
    private readonly viewport?: () => { width: number; height: number } | undefined) {
    this.menu = new NativeMenu(actions.map(action => ({ ...action, run: () => {
      if (!this.ready) return;
      if (action.requiresReview && this.seen.size < this.total) {
        this.error = '请先读完说明 · → 继续'; this.redraw(); return;
      }
      action.run();
    } })), paint, back);
  }
  invalidate(): void { this.ready = false; this.size = ''; this.seen.clear(); this.offset = 0; }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.back(); return; }
    const live = this.viewport?.();
    if (live && this.size !== `${live.width}/${live.height}`) this.invalidate();
    if (!this.ready) { this.redraw(); return; }
    const forward = matchesKey(data, Key.right) || matchesKey(data, Key.pageDown);
    if (forward || matchesKey(data, Key.left) || matchesKey(data, Key.pageUp)) {
      this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.page), this.offset + (forward ? this.page : -this.page)));
      this.error = ''; this.redraw(); return;
    }
    this.menu.handleInput(data); this.redraw();
  }
  render(width: number, height: number): string[] {
    const w = Math.max(1, width - 1); const h = Math.max(0, height);
    if (this.size !== `${width}/${height}`) { this.size = `${width}/${height}`; this.seen.clear(); this.ready = false; this.offset = 0; }
    const { header, body } = sheetLines(this.content, width, this.paint);
    // Keep at least one content and one action row; too-small views cannot confirm.
    const footer = packHints(['←→ 内容', '↑↓ 操作', 'Enter 确认', 'Esc 返回'], width - 1);
    if (width < 24 || h < header.length + footer.length + 5) {
      this.ready = false;
      return [this.paint('accent', ' Hibiki'), this.paint('warning', ' 窗口太小，请扩大后继续'), this.paint('dim', ' Esc 返回')].slice(0, h).map(line => truncateToWidth(line, w, ''));
    }
    const actionRows = Math.min(4, Math.max(1, Math.floor((h - header.length - footer.length - 3) / 3)));
    const menu = this.menu.render(width, actionRows);
    const needsScroll = body.length > h - header.length - menu.length - footer.length - 1;
    this.page = Math.max(1, h - header.length - menu.length - footer.length - 1 - Number(needsScroll));
    this.total = body.length;
    this.offset = Math.min(this.offset, Math.max(0, this.total - this.page));
    const visible = body.slice(this.offset, this.offset + this.page);
    for (let i = this.offset; i < this.offset + visible.length; i++) this.seen.add(i);
    this.ready = true;
    const scroll = this.error || (body.length > this.page
      ? ` 内容 ${this.offset + 1}–${Math.min(body.length, this.offset + this.page)}/${body.length} · ←→${this.seen.size < body.length ? ' · 未读完' : ''}` : '');
    return [...header, ...visible, ...(scroll ? [this.paint(this.error ? 'warning' : 'dim', scroll)] : []),
      this.paint('dim', '─'.repeat(w)), ...menu,
      ...footer.map(line => this.paint('dim', line))]
      .slice(0, h).map(line => truncateToWidth(line, w, ''));
  }
}
