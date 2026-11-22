/**
 * Client-side voiceover: the Burmese voice is now made on the server
 * (POST /api/tts on Vercel), NOT in the browser.
 *
 * Why: from the user's phone browser, Edge TTS WebSocket would not connect
 * and Google Translate TTS fetch is CORS-blocked, so both client paths
 * failed. The server has neither problem — the phone only downloads the
 * finished MP3. The response header X-TTS-Provider says honestly which
 * engine spoke ('edge' = Thiha/Nilar, 'google' = fallback).
 *
 * Browser speechSynthesis remains ONLY as a play-only last resort
 * (no download) if the server route itself fails.
 */
import type { TtsEngine, VoiceId } from './types';

export interface ServerTtsResult {
  blob: Blob;
  engine: TtsEngine;
}

/** Ask the server for a Burmese voiceover of the full script. */
export async function synthesizeViaServer(
  script: string,
  voice: VoiceId,
): Promise<ServerTtsResult> {
  const voiceKey = voice === 'my-MM-NilarNeural' ? 'nilar' : 'thiha';
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: script, voice: voiceKey }),
  });
  if (!res.ok) {
    let detail = `server ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) detail = data.error;
    } catch {
      /* keep the status text */
    }
    throw new Error(detail);
  }
  const provider = res.headers.get('X-TTS-Provider') ?? 'edge';
  const blob = await res.blob();
  if (blob.size === 0) throw new Error('Server မှ အသံဗလာ ပြန်လာတယ်');
  const engine: TtsEngine =
    provider === 'google'
      ? 'google-tts'
      : voiceKey === 'nilar'
        ? 'edge-nilar'
        : 'edge-thiha';
  return { blob, engine };
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
