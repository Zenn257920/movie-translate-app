/// <reference lib="webworker" />
/**
 * Whisper transcription worker. Loads @xenova/transformers in a worker
 * so the UI stays responsive while the model runs.
 * Messages in:  { type: 'init', model } | { type: 'transcribe', id, audio, start, language }
 * Messages out: { type: 'ready' } | { type: 'progress', id, percent, detail }
 *                { type: 'result', id, text } | { type: 'error', id, message }
 */
import { env, pipeline } from '@xenova/transformers';

env.allowLocalModels = false;

type Pipe = unknown;

let transcriber: Pipe | null = null;
let currentModel = '';

const ctx = self as unknown as {
  postMessage: (msg: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
};

async function load(model: string) {
  if (transcriber && currentModel === model) return transcriber;
  transcriber = await pipeline(
    'automatic-speech-recognition',
    model,
    {
      progress_callback: (p: unknown) => {
        const prog = p as {
          status?: string;
          progress?: number;
          file?: string;
          loaded?: number;
          total?: number;
        };
        // NOTE: @xenova/transformers already reports progress as 0-100
        // PER FILE (see hub.js readResponse: (loaded/total)*100).
        // Do NOT multiply by 100 again — that was the "8583%" bug.
        // Pass loaded/total through so the UI can show MB.
        const pct =
          typeof prog.progress === 'number'
            ? Math.max(0, Math.min(100, prog.progress))
            : 0;
        ctx.postMessage({
          type: 'progress',
          id: 'init',
          percent: Math.round(pct * 10) / 10,
          detail: prog.file ? `${prog.status ?? ''} ${prog.file}` : prog.status,
          loaded: prog.loaded,
          total: prog.total,
          file: prog.file,
        });
      },
    } as never,
  );
  currentModel = model;
  ctx.postMessage({ type: 'ready' });
  return transcriber;
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data as {
    type: string;
    id?: string;
    model?: string;
    audio?: Float32Array;
    start?: number;
    language?: string;
  };
  try {
    if (msg.type === 'init' && msg.model) {
      await load(msg.model);
      return;
    }
    if (msg.type === 'transcribe' && msg.audio && msg.model) {
      const pipe = await load(msg.model);
      const fn = pipe as unknown as (
        audio: Float32Array,
        opts: Record<string, unknown>,
      ) => Promise<{ text?: string }>;
      const out = await fn(msg.audio, {
        language: msg.language ?? 'chinese',
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      });
      ctx.postMessage({ type: 'result', id: msg.id, text: (out.text ?? '').trim() });
      return;
    }
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id: msg.id ?? 'init',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
