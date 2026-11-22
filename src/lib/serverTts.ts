/**
 * Server-side Burmese TTS — runs in the Next.js API route on Vercel.
 *
 * Why server-side: the browser on the user's phone could not reach either
 * TTS service — the Edge WebSocket failed and the Google Translate TTS
 * fetch is CORS-blocked from the browser. From the server there is no
 * CORS problem and no browser WebSocket limitation.
 *
 * Order: Azure Speech first — but ONLY when AZURE_SPEECH_KEY +
 * AZURE_SPEECH_REGION are set (official REST API, F0 free tier,
 * the reliable way to get the real Thiha/Nilar voices). Then
 * ElevenLabs (only when ELEVENLABS_API_KEY is set — free tier, no
 * bank card; an ElevenLabs voice speaking Burmese, not Thiha).
 * Then Microsoft Edge TTS (native Thiha/Nilar voices, no API key —
 * the same consumer endpoint the Edge browser uses), Google
 * Translate TTS last. The caller reports the real provider via
 * X-TTS-Provider.
 *
 * Edge handshake (kept in sync with rany2/edge-tts 7.3.0+): since ~Oct 2024
 * (edge-tts issue #290) the endpoint 403s any handshake that lacks the
 * Sec-MS-GEC token, and since ~Nov 2025 it requires the v2 token
 * (edge-tts release 7.3.0, commit ba61d94): `Sec-MS-GEC-Version: 2-...`
 * plus a token value in the form `<CS64>-<SHA256>` produced by the
 * custom DRM hash in ./edgeGecV2 (a tweaked SHA-256 variant + CS64
 * checksum — plain SHA-256 gives a different digest and still 403s).
 * The hash INPUT is unchanged from v1: Windows file-time ticks floored
 * to 5 minutes concatenated with the TrustedClientToken. The User-Agent's
 * Edg/ version must match the Sec-MS-GEC-Version's Chromium version.
 * Sending only TrustedClientToken, or a v1 token, is why Edge failed
 * even from Vercel and everything fell back to Google.
 *
 * Edge MESSAGE FRAMING (kept in sync with edge-tts communicate.py —
 * this is where the empty-turn bug lived, 2026-11-22): TEXT frames
 * (turn.start / turn.end / response / audio.metadata) are ASCII
 * `Header: value\r\n...` + `\r\n\r\n` + body. BINARY frames are
 * DIFFERENT: a 2-byte big-endian header length, then that many bytes
 * of ASCII headers (each `Key: value` line ending `\r\n`, NO blank
 * line), then the raw MP3 bytes. There is NO `\r\n\r\n` in a binary
 * audio frame — searching for one finds nothing and the audio is
 * silently dropped, so the turn ends with zero audio. parseEdgeFrame
 * below implements the upstream framing exactly.
 */
import WebSocket from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
import { generateSecMsGecV2 } from './edgeGecV2';

export type ServerVoice = 'thiha' | 'nilar';
export type ServerProvider = 'azure' | 'elevenlabs' | 'edge' | 'google';

const VOICE_NAMES: Record<ServerVoice, string> = {
  thiha: 'my-MM-ThihaNeural',
  nilar: 'my-MM-NilarNeural',
};

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// NOTE: NOT a private key — the public constant shipped in the Edge
// browser itself and in every edge-tts client. No secret is used.
const WS_BASE =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

// Chromium version Edge's own client currently reports; feeds both
// Sec-MS-GEC-Version and the User-Agent below — Microsoft's edge
// (WAF-level, not just the GEC hash) rejects the handshake if the two
// disagree, so this constant is the single source for both. Bump it to
// a current Edge version if handshakes start 403ing again.
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
// v2 since edge-tts 7.3.0 — Microsoft now rejects the v1 (`1-...`) token.
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
// Origin of the Edge Read Aloud extension (what edge-tts sends).
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';

/** Fresh 32-hex MUID per connection, uppercase, as edge-tts sends. */
function generateMuid(): string {
  return randomBytes(16).toString('hex').toUpperCase();
}

/** X-Timestamp in the format edge-tts sends, day zero-padded. */
function edgeTimestamp(): string {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ` +
    `${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
    'GMT+0000 (Coordinated Universal Time)'
  );
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

/** Pull the `Path:` header value out of ASCII `Key: value` header lines. */
function edgePathFromHeaders(headerText: string): string | null {
  for (const line of headerText.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === 'path') {
      return line.slice(idx + 1).trim();
    }
  }
  return null;
}

export interface EdgeFrame {
  /** The `Path:` header value (e.g. "audio", "turn.end"), or null. */
  path: string | null;
  /** Raw MP3 bytes for audio frames (null for text frames). */
  audio: Buffer | null;
  /** First 500 chars of the frame's text, for logging non-audio frames. */
  textPreview: string | null;
}

/**
 * Parse one Edge WebSocket message exactly like edge-tts 7.3.1
 * (communicate.py) does. `isBinary` is the `ws` message flag — with
 * `ws` both text and binary frames arrive as Buffers, so the flag is
 * the only reliable way to tell them apart.
 *
 * Binary: [2-byte BE header length L][L bytes of headers][raw audio].
 * Text:   headers + "\r\n\r\n" + body.
 */
export function parseEdgeFrame(data: Buffer, isBinary: boolean): EdgeFrame {
  if (isBinary) {
    if (data.length < 2) return { path: null, audio: null, textPreview: null };
    const headerLen = data.readUInt16BE(0);
    // Header text occupies bytes [2, 2+headerLen); audio starts at 2+headerLen.
    if (2 + headerLen > data.length) {
      // Implausible length — fall back to the old "\r\n\r\n" search so a
      // differently-shaped frame is not silently lost; log it via the caller.
      const sep = data.indexOf('\r\n\r\n');
      if (sep === -1) return { path: null, audio: null, textPreview: null };
      const headerText = data.subarray(0, sep).toString('utf8');
      const path = edgePathFromHeaders(headerText);
      return {
        path,
        audio: path === 'audio' ? data.subarray(sep + 4) : null,
        textPreview: headerText.slice(0, 500),
      };
    }
    const headerText = data.subarray(2, 2 + headerLen).toString('utf8');
    const path = edgePathFromHeaders(headerText);
    return {
      path,
      audio: path === 'audio' ? data.subarray(2 + headerLen) : null,
      textPreview: headerText.slice(0, 500),
    };
  }
  const text = data.toString('utf8');
  const sep = text.indexOf('\r\n\r\n');
  const headerText = sep === -1 ? text : text.slice(0, sep);
  const body = sep === -1 ? '' : text.slice(sep + 4);
  return {
    path: edgePathFromHeaders(headerText),
    audio: null,
    textPreview: (headerText + (body ? '\r\n\r\n' + body : '')).slice(0, 500),
  };
}

/** One Edge TTS chunk -> MP3 bytes. A single WebSocket turn. */
function synthesizeEdgeChunkOnce(
  text: string,
  voiceName: string,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Same no-dash id for ConnectionId and X-RequestId, as edge-tts does.
    const connectionId = randomUUID().replace(/-/g, '');
    const url =
      `${WS_BASE}?TrustedClientToken=${TRUSTED_TOKEN}` +
      `&Sec-MS-GEC=${generateSecMsGecV2()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
      `&ConnectionId=${connectionId}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: {
          'User-Agent': EDGE_UA,
          Origin: EDGE_ORIGIN,
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Cookie: `muid=${generateMuid()};`,
        },
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
    }, timeoutMs);
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
      // A turn that ends with no audio at all is a failure, not silence —
      // the caller retries it instead of returning an empty MP3.
      else if (!data || data.length === 0)
        reject(new Error('Edge TTS မှ အသံမရပါ'));
      else {
        console.error(
          `[tts] Edge turn end: ${audioParts.length} audio parts, ${data.length} bytes`,
        );
        resolve(data);
      }
    };

    ws.on('open', () => {
      // speech.config — upstream defaults (SentenceBoundary): sentence
      // metadata on, word metadata off; trailing CRLF after the JSON.
      const config =
        `X-Timestamp:${edgeTimestamp()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":' +
        '{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n';
      ws.send(config);
      // Upstream sends a FRESH request id here, different from the
      // ConnectionId in the URL. SSML matches upstream byte-for-byte:
      // xml:lang is 'en-US' for every voice, prosody carries all three
      // attributes in upstream order.
      const requestId = randomUUID().replace(/-/g, '');
      const ssml =
        `X-RequestId:${requestId}\r\n` +
        'Content-Type:application/ssml+xml\r\n' +
        // Upstream appends a trailing "Z" here (an Edge bug it preserves).
        `X-Timestamp:${edgeTimestamp()}Z\r\n` +
        'Path:ssml\r\n\r\n' +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${voiceName}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(ssml);
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : typeof data === 'string'
          ? Buffer.from(data, 'utf8')
          : Buffer.from(data as ArrayBuffer);
      const frame = parseEdgeFrame(buf, isBinary);
      if (frame.path === 'audio') {
        // Upstream: a binary audio frame with no Content-Type and no data
        // is the expected end-of-stream marker — skip it, don't count it.
        if (frame.audio && frame.audio.length > 0) {
          audioParts.push(frame.audio);
        }
        return;
      }
      if (frame.path === 'turn.end') {
        done(undefined, Buffer.concat(audioParts));
        return;
      }
      // Any other TEXT frame (turn.start, response, audio.metadata, or
      // an error frame the service sends when it rejects the SSML) is
      // logged so a rejected turn never goes blind again. Never contains
      // the token — frames carry no credentials.
      if (!isBinary && frame.textPreview) {
        console.error(`[tts] Edge frame (${frame.path ?? 'unknown'}):`, frame.textPreview);
      } else if (isBinary && frame.path) {
        console.error(`[tts] Edge binary frame (${frame.path})`);
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

/**
 * Edge TTS chunk with one retry: the Read Aloud endpoint is intermittent
 * by nature (403/503 handshakes, turns that end with no audio). Both
 * attempts together stay inside the 25s budget for the chunk.
 */
async function synthesizeEdgeChunk(text: string, voiceName: string): Promise<Buffer> {
  const deadline = Date.now() + 25_000;
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) break;
    try {
      return await synthesizeEdgeChunkOnce(text, voiceName, remaining);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error('Edge TTS မရပါ');
      if (attempt === 0 && Date.now() < deadline - 1000) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastErr ?? new Error('Edge TTS မရပါ');
}

/** Azure Speech REST API — official endpoint, one chunk. */
async function synthesizeAzureChunk(
  text: string,
  voiceName: string,
  key: string,
  region: string,
): Promise<Buffer> {
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='my-MM'>` +
    `<voice name='${voiceName}'>${escapeXml(text)}</voice></speak>`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'movie-translate-app',
    },
    body: ssml,
  });
  // Never log the key — only the HTTP status.
  if (!res.ok) throw new Error(`Azure Speech HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** ElevenLabs TTS — official REST API, one chunk. */
async function synthesizeElevenLabsChunk(
  text: string,
  apiKey: string,
  voiceId: string,
): Promise<Buffer> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
    '?output_format=mp3_44100_128';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_v4', // supports Burmese (my)
      language_code: 'my',
    }),
  });
  // Never log the key — only the HTTP status.
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
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
 * Synthesize Burmese speech.
 * Order: Azure Speech (only when AZURE_SPEECH_KEY + AZURE_SPEECH_REGION
 * are set) → ElevenLabs (only when ELEVENLABS_API_KEY is set) →
 * Edge TTS (Thiha/Nilar, no key) → Google TTS fallback.
 * Throws only if ALL tried providers fail, naming each failure.
 */
export async function synthesizeBurmese(
  text: string,
  voice: ServerVoice,
): Promise<TtsResult> {
  // The Edge service errors on C0 control characters (Whisper output can
  // contain them) — upstream replaces them with a space, so do the same.
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
  if (!text.trim()) throw new Error('မြန်မာအသံ ထုတ်မရပါ — စာမပါဘူး');
  const voiceName = VOICE_NAMES[voice];
  const failures: string[] = [];

  // 1. Azure Speech — official REST API, real Thiha/Nilar.
  const azureKey = process.env.AZURE_SPEECH_KEY?.trim();
  const azureRegion = process.env.AZURE_SPEECH_REGION?.trim();
  if (azureKey && azureRegion) {
    try {
      const chunks = splitForTts(text);
      const parts: Buffer[] = [];
      for (const chunk of chunks) {
        parts.push(await synthesizeAzureChunk(chunk, voiceName, azureKey, azureRegion));
      }
      const audio = Buffer.concat(parts);
      if (audio.length === 0) throw new Error('Azure Speech မှ အသံဗလာ ပြန်လာတယ်');
      return { audio, provider: 'azure' };
    } catch (azureErr) {
      // Log status only — the key must never appear in logs.
      console.error(
        '[tts] Azure Speech failed:',
        azureErr instanceof Error ? azureErr.message : 'unknown',
      );
      failures.push(
        `Azure: ${azureErr instanceof Error ? azureErr.message : 'Azure မရပါ'}`,
      );
    }
  }

  // 2. ElevenLabs — official REST API, free tier needs no bank card.
  // Premade voices the free plan can use: George (male) for Thiha,
  // Sarah (female) for Nilar. ELEVENLABS_VOICE_ID overrides both.
  const elevenKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (elevenKey) {
    const elevenVoiceId =
      process.env.ELEVENLABS_VOICE_ID?.trim() ||
      (voice === 'nilar' ? 'EXAVITQu4vr4xnSDxMaL' : 'JBFqnCBsd6RMkjVDRZzb');
    try {
      const chunks = splitForTts(text);
      const parts: Buffer[] = [];
      for (const chunk of chunks) {
        parts.push(await synthesizeElevenLabsChunk(chunk, elevenKey, elevenVoiceId));
      }
      const audio = Buffer.concat(parts);
      if (audio.length === 0) throw new Error('ElevenLabs မှ အသံဗလာ ပြန်လာတယ်');
      return { audio, provider: 'elevenlabs' };
    } catch (elevenErr) {
      // Log status only — the key must never appear in logs.
      console.error(
        '[tts] ElevenLabs failed:',
        elevenErr instanceof Error ? elevenErr.message : 'unknown',
      );
      failures.push(
        `ElevenLabs: ${elevenErr instanceof Error ? elevenErr.message : 'ElevenLabs မရပါ'}`,
      );
    }
  }

  // 3. Edge TTS, chunk by chunk.
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
    // Diagnostic: the real reason (403 handshake, timeout, close code)
    // is otherwise swallowed when Google succeeds — it only shows in
    // Vercel's function logs. Never includes the Sec-MS-GEC token.
    console.error('[tts] Edge failed:', edgeMsg);
    failures.push(`Edge: ${edgeMsg}`);
    // 4. Google TTS fallback, server-side.
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
      failures.push(`Google: ${googleMsg}`);
      throw new Error(`မြန်မာအသံ ထုတ်မရပါ — ${failures.join(' | ')}`);
    }
  }
}
