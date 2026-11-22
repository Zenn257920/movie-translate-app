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
 * Edge handshake (kept in sync with rany2/edge-tts): since ~Oct 2024
 * (edge-tts issue #290) the endpoint 403s any handshake that lacks the
 * Sec-MS-GEC token — SHA-256 of the Windows file-time (floored to 5
 * minutes) concatenated with the TrustedClientToken — plus a
 * Sec-MS-GEC-Version whose floor Microsoft raises over time (below
 * 1-133 now 403s). The User-Agent's Edg/ version must match that
 * version. Sending only TrustedClientToken (as this code did before)
 * is why Edge failed even from Vercel and everything fell back to
 * Google.
 */
import WebSocket from 'ws';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

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
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
// Origin of the Edge Read Aloud extension (what edge-tts sends).
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpoljnfkkaacifdlj';

/**
 * Sec-MS-GEC: uppercase hex SHA-256 of
 * "<windows file-time ticks floored to 5 minutes><TrustedClientToken>".
 * Ticks exceed Number.MAX_SAFE_INTEGER, so this uses BigInt — float math
 * would silently lose precision on the ~1.3e17 tick value.
 */
function generateSecMsGec(): string {
  const unixSeconds = BigInt(Math.floor(Date.now() / 1000));
  const winSeconds = unixSeconds + 11_644_473_600n; // 1601-01-01 -> 1970-01-01
  const floored = winSeconds - (winSeconds % 300n);
  const ticks = floored * 10_000_000n; // seconds -> 100ns intervals
  return createHash('sha256')
    .update(`${ticks.toString()}${TRUSTED_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

/** Fresh 32-hex muid cookie per connection, as edge-tts sends. */
function generateMuid(): string {
  return randomBytes(16).toString('hex');
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
      `&Sec-MS-GEC=${generateSecMsGec()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
      `&ConnectionId=${connectionId}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: {
          'User-Agent': EDGE_UA,
          Origin: EDGE_ORIGIN,
          'Accept-Encoding': 'gzip, deflate, br',
          'Accept-Language': 'en-US,en;q=0.9',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Cookie: `muid=${generateMuid()}`,
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
      else resolve(data);
    };

    const SEP = Buffer.from('\r\n\r\n');
    ws.on('open', () => {
      const config =
        `X-Timestamp:${edgeTimestamp()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":' +
        '{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
      ws.send(config);
      const ssml =
        `X-RequestId:${connectionId}\r\n` +
        'Content-Type:application/ssml+xml\r\n' +
        `X-Timestamp:${edgeTimestamp()}\r\n` +
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
  // contain them) — strip them before any provider sees the text.
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
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
