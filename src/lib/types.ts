// Shared types for the client-side pipeline.
export type VoiceId = 'my-MM-ThihaNeural' | 'my-MM-NilarNeural';
export type Mode = 'recap' | 'line';
export type WhisperModel = 'Xenova/whisper-tiny' | 'Xenova/whisper-base';
export type TtsEngine = 'edge-thiha' | 'edge-nilar' | 'google-tts' | 'speech-synthesis';

export interface Segment {
  start: number; // seconds
  end: number; // seconds
  zh: string; // original-language text
  my: string; // Burmese translation ('' if translation failed)
  translated: boolean;
}

export interface JobResult {
  id: string;
  title: string;
  createdAt: string;
  mode: Mode;
  voice: VoiceId;
  engine: TtsEngine;
  engineLabel: string;
  scriptMy: string;
  srtMy: string;
  transcript: Segment[];
  /** Voiceover audio is kept in memory only (blob URL) — it is NOT stored in history. */
  voiceoverUrl?: string;
  voiceoverDownloadable: boolean;
}

export interface ProgressUpdate {
  stage: string;
  stageMy: string;
  percent: number; // 0-100 within the current stage
  detail?: string;
}

export const VOICE_LABELS: Record<VoiceId, string> = {
  'my-MM-ThihaNeural': 'Thiha (ကျား)',
  'my-MM-NilarNeural': 'Nilar (မ)',
};

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** Format seconds as SRT timestamp 00:00:00,000 */
export function formatSrtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(rest, 3)}`;
}
