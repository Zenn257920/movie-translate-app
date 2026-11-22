/**
 * Server-side Burmese TTS — runs in the Next.js API route on Vercel.
 *
 * Why server-side: the browser on the user's phone could not reach either
 * TTS service — the Edge WebSocket failed and the Google Translate TTS
 * fetch is CORS-blocked from the browser. From the server there is no
 * CORS problem and no browser WebSocket limitation.
 *
 * Order: Microsoft Edge TTS first (native Thiha/Nilar voices, no API key —
 * the same consumer endpoint the Edge browser uses), Google Translate TTS
 * second. The caller reports the real provider via X-TTS-Provider.
 */
import WebSocket from 'ws';

export type ServerVoice = 'thiha' | 'nilar';
export type ServerProvider = 'edge' | 'google';

const VOICE_NAMES: Record<ServerVoice, string> = {
  thiha: 'my-MM-ThihaNeural',
  nilar: 'my-MM-NilarNeural',
};

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// NOTE: NOT a private key — the public constant shipped in the Edge
// browser itself and in every edge-tts client. No secret is used.
const WS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';

function uuid(): string {
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

/** Google TTS accepts only short text per request — split harder. */
function splitForGoogle(text: string, maxLen = 180): string[] {
  const out: string[] = [];
  for (const chunk of splitForTts(text, 700)) {
    if (chunk.length <= maxLen) {
      out.push(chunk);
      continue;
    }
    // Hard-split a long chunk on spaces, keeping words whole.
    const words = chunk.split(/\s+/);
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxLen && cur) {
        out.push(cur.trim());
        cur = w;
      } else {
        cur = (cur + ' ' + w).trim();
      }
    }
    if (cur) out.push(cur.trim());
  }
  return out.filter(Boolean);
}

/** One Edge TTS chunk -> MP3 bytes. */
function synthesizeEdgeChunk(text: string, voiceName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const connectionId = uuid();
    const requestId = uuid();
    const url = `${WS_BASE}?TrustedClientToken=${TRUSTED_TOKEN}&ConnectionId=${connectionId}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: { 'User-Agent': EDGE_UA, Origin: 'https://www.bing.com' },
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error('Edge WebSocket မဖွင့်နိုင်ပါ'));
      return;
    }
    const audioParts: Buffer[] = [];
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
    }, 25_000);
    timer.unref?.();

    const done = (err?: Error, data?: Buffer) => {
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

    const SEP = Buffer.from('\r\n\r\n');
    ws.on('open', () => {
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
        `<voice name='${voiceName}'><prosody rate='+0%' pitch='+0Hz'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(ssml);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      // Text frames (turn.start / turn.end) are ASCII; binary frames carry audio.
      const sepIdx = buf.indexOf(SEP);
      if (sepIdx === -1) {
        const asText = buf.toString('utf8');
        if (asText.includes('Path:turn.end')) {
          done(undefined, Buffer.concat(audioParts));
        }
        return;
      }
      const header = buf.subarray(0, sepIdx).toString('utf8');
      if (header.includes('Path:audio')) {
        audioParts.push(buf.subarray(sepIdx + SEP.length));
      } else if (header.includes('Path:turn.end')) {
        done(undefined, Buffer.concat(audioParts));
      }
    });

    ws.on('error', (err) => {
      done(new Error(`Edge TTS ချိတ်ဆက်လို့မရပါ — ${err.message}`));
    });
    ws.on('close', (code) => {
      if (!finished) {
        done(new Error(`Edge TTS ချိတ်ဆက်မှု ပြတ်သွားတယ် (code ${code})`));
      }
    });
  });
}

/** Google Translate TTS, server-side (no CORS here). One short chunk. */
async function synthesizeGoogleChunk(text: string): Promise<Buffer> {
  const url =
    'https://translate.google.com/translate_tts?ie=UTF-8&tl=my&client=tw-ob' +
    `&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': EDGE_UA,
      Referer: 'https://translate.google.com/',
    },
  });
  if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export interface TtsResult {
  audio: Buffer;
  provider: ServerProvider;
}

/**
 * Synthesize Burmese speech. Edge (Thiha/Nilar) first; Google fallback.
 * Throws only if BOTH fail, with the Edge error as the main reason.
 */
export async function synthesizeBurmese(
  text: string,
  voice: ServerVoice,
): Promise<TtsResult> {
  const voiceName = VOICE_NAMES[voice];
  // 1. Edge TTS, chunk by chunk.
  try {
    const chunks = splitForTts(text);
    const parts: Buffer[] = [];
    for (const chunk of chunks) {
      parts.push(await synthesizeEdgeChunk(chunk, voiceName));
    }
    const audio = Buffer.concat(parts);
    if (audio.length === 0) throw new Error('Edge TTS မှ အသံဗလာ ပြန်လာတယ်');
    return { audio, provider: 'edge' };
  } catch (edgeErr) {
    const edgeMsg = edgeErr instanceof Error ? edgeErr.message : 'Edge TTS မရပါ';
    // 2. Google TTS fallback, server-side.
    try {
      const pieces = splitForGoogle(text);
      const parts: Buffer[] = [];
      for (const piece of pieces) {
        parts.push(await synthesizeGoogleChunk(piece));
      }
      const audio = Buffer.concat(parts);
      if (audio.length === 0) throw new Error('Google TTS မှ အသံဗလာ ပြန်လာတယ်');
      return { audio, provider: 'google' };
    } catch (googleErr) {
      const googleMsg =
        googleErr instanceof Error ? googleErr.message : 'Google TTS မရပါ';
      throw new Error(
        `မြန်မာအသံ ထုတ်မရပါ — Edge: ${edgeMsg} | Google: ${googleMsg}`,
      );
    }
  }
}
