/** Free Google Translate web endpoint (no key). Used for zh -> my. */

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

export async function translateText(
  text: string,
  source: string,
  target = 'my',
): Promise<string> {
  const url =
    `${ENDPOINT}?client=gtx&sl=${encodeURIComponent(source)}` +
    `&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`translate ${res.status}`);
  const data = (await res.json()) as unknown;
  // Response shape: [[["translated","original",...], ...], ...]
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('translate: unexpected response');
  }
  let out = '';
  for (const part of data[0] as unknown[]) {
    if (Array.isArray(part) && typeof part[0] === 'string') out += part[0];
  }
  return out.trim();
}

/** Translate segments one by one; a failed segment keeps its original text. */
export async function translateSegments(
  texts: string[],
  source: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ my: string; translated: boolean }[]> {
  const out: { my: string; translated: boolean }[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i].trim();
    if (!t) {
      out.push({ my: '', translated: false });
    } else {
      try {
        const my = await translateText(t, source, 'my');
        out.push({ my: my || t, translated: Boolean(my) });
      } catch {
        out.push({ my: t, translated: false });
      }
    }
    onProgress?.(i + 1, texts.length);
    // Be gentle with the free endpoint.
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}
