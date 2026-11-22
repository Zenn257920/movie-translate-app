import { formatSrtTime, type Segment } from './types';

/** Build a Burmese SRT from timed segments. */
export function buildSrt(segments: Segment[]): string {
  const lines: string[] = [];
  let n = 0;
  for (const seg of segments) {
    const text = (seg.my || seg.zh).trim();
    if (!text) continue;
    n += 1;
    lines.push(String(n));
    lines.push(`${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}`);
    lines.push(text);
    lines.push('');
  }
  return lines.join('\n');
}

/** Normalise text for near-duplicate detection. */
function norm(s: string): string {
  return s.replace(/[\s,.!?။၊'"“”‘’()（）]+/g, '').toLowerCase();
}

function isNearDuplicate(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Jaccard on characters, cheap and good enough for short lines.
  const sa = new Set(na);
  const sb = new Set(nb);
  let inter = 0;
  for (const c of sa) if (sb.has(c)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  return union > 0 && inter / union > 0.8;
}

/**
 * Build a natural Burmese recap narration script from translated segments:
 * short intro, deduped narration lines in order, short outro.
 */
export function buildRecapScript(segments: Segment[]): string {
  const lines: string[] = [];
  for (const seg of segments) {
    const text = (seg.my || seg.zh).trim();
    if (!text) continue;
    if (lines.some((l) => isNearDuplicate(l, text))) continue;
    lines.push(text);
  }
  const intro = 'မင်္ဂလာပါ။ ဒီဗီဒီယိုထဲမှာ ဖြစ်ပျက်ခဲ့တာတွေကို အတိုချုပ် ပြန်ပြောပြပါမယ်။';
  const outro = 'ဒီလောက်ပါပဲ။ နောက်ဗီဒီယိုမှာ ပြန်တွေ့ကြမယ်။';
  return [intro, ...lines, outro].join('\n');
}

/** Line-by-line script: one narration line per segment. */
export function buildLineScript(segments: Segment[]): string {
  return segments
    .map((s) => (s.my || s.zh).trim())
    .filter(Boolean)
    .join('\n');
}
