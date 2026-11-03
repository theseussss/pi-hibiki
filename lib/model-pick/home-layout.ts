import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui';

/** Original compact HOME spec; TASK parameter formatting remains independent. */
export function homeContext(tokens: number | undefined): string {
  if (!tokens) return '';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Original HOME budgets: independent of catalog label lengths and badge state. */
export function homeColumns(width: number, providerWidth: number, counterWidth: number) {
  const modelX = Math.max(1, Math.min(width - 18, providerWidth));
  const available = Math.max(1, width - modelX);
  // Budget +N BEFORE dividing by six; otherwise an exactly divisible span
  // loses a whole cell just to display its counter (96 -> six 15-wide cells).
  return { modelX, available, cellW: Math.min(30, Math.max(14, Math.floor((available - counterWidth) / 6))) };
}
export function middle(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  const keep = Math.max(0, width - 1), head = Math.ceil(keep / 2), tail = keep - head;
  return sliceByColumn(value, 0, head, true) + '…' + sliceByColumn(value, visibleWidth(value) - tail, tail, true);
}
/** Right-anchor only the selected row; reserve an honest, fully visible +N. */
export function homeWindow(total: number, selected: number, available: number, cellW: number) {
  let count = Math.min(total, Math.floor(available / cellW));
  let start = 0;
  while (count > 0) {
    start = Math.max(0, selected - count + 1);
    const remaining = Math.max(0, total - start - count);
    if (count * cellW + (remaining ? String(remaining).length + 1 : 0) <= available) break;
    count--;
  }
  return { start, count, remaining: Math.max(0, total - start - count) };
}

/** Same out-and-back palette sampling as the original title/detail rails. */
export function homeRule(width: number, colors: readonly string[], stepped: boolean, paint: (color: string, text: string) => string): string {
  if (!colors.length) return '─'.repeat(width);
  const stops = colors.map(c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)));
  return Array.from({ length: width }, (_, i) => {
    const pos = i / Math.max(1, width - 1), t = pos <= .5 ? pos * 2 : (1 - pos) * 2;
    if (stepped || stops.length === 1) return paint(colors[Math.min(colors.length - 1, Math.floor(t * colors.length))]!, '─');
    const scaled = t * (stops.length - 1), index = Math.min(stops.length - 2, Math.floor(scaled)), f = scaled - index;
    const color = '#' + stops[index]!.map((v, channel) => Math.round(v + (stops[index + 1]![channel]! - v) * f).toString(16).padStart(2, '0')).join('');
    return paint(color, '─');
  }).join('');
}
