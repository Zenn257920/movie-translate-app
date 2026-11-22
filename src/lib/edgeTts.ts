/**
 * Microsoft Edge Read Aloud TTS, called directly from the browser.
 *
 * No API key is needed: this is the same consumer endpoint the Edge
 * browser uses for Read Aloud. It is unofficial and Microsoft can change
 * it without notice — that is why the app falls back to Google TTS and
 * then to the browser's own speechSynthesis, and always reports which
 * engine actually spoke.
 *
 * Voices: my-MM-ThihaNeural (male, default) / my-MM-NilarNeural (female).
 */
import type { TtsEngine, VoiceId } from './types';

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// NOTE: this is NOT a private key — it is the public constant shipped in
// the Edge browser itself and in every edge-tts client. No secret is used.
const WS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function timestamp(): string {
  return new Date().toUTCString().replace('GMT', 'GMT');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface EdgeResult {
  blob: Blob;
  engine: TtsEngine;
}

/** Split text into chunks Edge accepts comfortably (by sentence). */
export function splitForTts(text: string, maxLen = 700): string[] {
  const sentences = text
    .split(/(?<=[။.!?！？\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).trim().length > maxLen && cur) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur = (cur + ' ' + s).trim();
    }
  }
  if (cur) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}

/** Synthesize one chunk with Edge TTS and return its MP3 bytes. */
function synthesizeEdgeChunk(text: string, voice: VoiceId): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const connectionId = uuid();
    const requestId = uuid();
    const url = `${WS_BASE}?TrustedClientToken=${TRUSTED_TOKEN}&ConnectionId=${connectionId}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error('WebSocket မဖွင့်နိုင်ပါ'));
      return;
    }
    ws.binaryType = 'arraybuffer';
    const audioParts: ArrayBuffer[] = [];
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('Edge TTS အချိန်ကုန်သွားတယ် (timeout)'));
      }
    }, 60_000);

    const done = (err?: Error, data?: ArrayBuffer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else if (data) resolve(data);
      else reject(new Error('Edge TTS မှ အသံမရပါ'));
    };

    ws.onopen = () => {
      const config =
        `X-Timestamp:${timestamp()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":' +
        '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
      ws.send(config);
      const ssml =
        `X-RequestId:${requestId}\r\n` +
        'Content-Type:application/ssml+xml\r\n' +
        `X-Timestamp:${timestamp()}\r\n` +
        'Path:ssml\r\n\r\n' +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='my-MM'>` +
        `<voice name='${voice}'><prosody rate='+0%' pitch='+0Hz'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(ssml);
    };

    ws.onmessage = (event) => {
      const data = event.data as ArrayBuffer | string;
      if (typeof data === 'string') {
        if (data.includes('Path:turn.end')) {
          const total = audioParts.reduce((n, p) => n + p.byteLength, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const p of audioParts) {
            out.set(new Uint8Array(p), off);
            off += p.byteLength;
          }
          done(undefined, out.buffer);
        } else if (data.includes('Path:turn.start')) {
          // synthesis started — nothing to do
        }
        return;
      }
      // Binary message: headers, blank line, then audio bytes.
      const bytes = new Uint8Array(data);
      const text = new TextDecoder().decode(bytes);
      const sep = text.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const header = text.slice(0, sep);
      if (header.includes('Path:audio')) {
        // Header is ASCII; audio starts right after the separator.
        const headerBytes = new TextEncoder().encode(text.slice(0, sep + 4));
        audioParts.push(bytes.slice(headerBytes.length).buffer as ArrayBuffer);
      } else if (header.includes('Path:turn.end')) {
        const total = audioParts.reduce((n, p) => n + p.byteLength, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of audioParts) {
          out.set(new Uint8Array(p), off);
          off += p.byteLength;
        }
        done(undefined, out.buffer);
      }
    };

    ws.onerror = () => {
      done(new Error('Edge TTS ချိတ်ဆက်လို့မရပါ — အင်တာနက် (သို့) Microsoft ဆာဗာကို စစ်ပါ'));
    };
    ws.onclose = (ev) => {
      if (!finished) {
        done(
          new Error(
            `Edge TTS ချိတ်ဆက်မှု ပြတ်သွားတယ်${ev.code ? ` (code ${ev.code})` : ''}`,
          ),
        );
      }
    };
  });
}

/** Synthesize a full script with Edge TTS (Thiha/Nilar). */
export async function synthesizeEdge(
  script: string,
  voice: VoiceId,
  onProgress?: (done: number, total: number) => void,
): Promise<EdgeResult> {
  const chunks = splitForTts(script);
  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const bytes = await synthesizeEdgeChunk(chunks[i], voice);
    parts.push(bytes);
    onProgress?.(i + 1, chunks.length);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  return {
    blob: new Blob([out.buffer], { type: 'audio/mpeg' }),
    engine: voice === 'my-MM-ThihaNeural' ? 'edge-thiha' : 'edge-nilar',
  };
}

/** Google Translate TTS (fallback). Returns MP3 bytes if fetch works. */
export async function synthesizeGoogleChunk(text: string): Promise<ArrayBuffer> {
  const url =
    'https://translate.google.com/translate_tts?ie=UTF-8&tl=my&client=tw-ob' +
    `&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google TTS ${res.status}`);
  return res.arrayBuffer();
}

/** Browser speechSynthesis fallback — play-only, no downloadable audio. */
export function speakWithBrowser(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) {
      reject(new Error('ဒီဘရောက်ဇာမှာ speechSynthesis မရှိပါ'));
      return;
    }
    const pickVoice = (): SpeechSynthesisVoice | null => {
      const voices = window.speechSynthesis.getVoices();
      return (
        voices.find((v) => v.lang?.toLowerCase().startsWith('my')) ?? null
      );
    };
    const utter = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) utter.voice = v;
    utter.lang = 'my-MM';
    utter.onend = () => resolve();
    utter.onerror = (e) => reject(new Error(`speechSynthesis error: ${e.error}`));
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}

export function engineLabel(engine: TtsEngine): string {
  switch (engine) {
    case 'edge-thiha':
      return 'Thiha (Microsoft Edge)';
    case 'edge-nilar':
      return 'Nilar (Microsoft Edge)';
    case 'google-tts':
      return 'Google TTS (fallback)';
    case 'speech-synthesis':
      return 'Browser voice (fallback)';
  }
}
