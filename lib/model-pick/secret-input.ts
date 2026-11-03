import { CURSOR_MARKER, Input, renderFakeCursor, visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

/** Real editing/cursor movement; rendering exposes only mask characters. */
export class SecretInput extends Input {
  constructor() { super({ prompt: '' }); }
  override render(width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    const length = this.getValue().length;
    if (!this.focused) return ['*'.repeat(Math.min(w, length))];
    const raw = super.render(w)[0] ?? '';
    const at = raw.indexOf(CURSOR_MARKER);
    const prefix = at < 0 ? '' : raw.slice(0, at);
    const suffix = stripVTControlCharacters(at < 0 ? raw : raw.slice(at + CURSOR_MARKER.length)).trimEnd();
    const left = Math.min(Math.max(0, w - 1), visibleWidth(prefix));
    const right = Math.min(Math.max(0, w - left), visibleWidth(suffix));
    return ['*'.repeat(left) + CURSOR_MARKER + renderFakeCursor(right > 0 ? '*' : ' ') + '*'.repeat(Math.max(0, right - 1))];
  }
}
