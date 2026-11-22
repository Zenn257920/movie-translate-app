/**
 * Whisper runner: prefers a Web Worker, falls back to the main thread
 * if workers are unavailable. Transcribes 16kHz mono audio chunk by
 * chunk and reports progress.
 */
import type { WhisperModel } from './types';

export interface ChunkResult {
  index: number;
  start: number;
  text: string;
}

type ProgressFn = (done: number, total: number, detail?: string) => void;

interface WorkerMsg {
  type: string;
  id?: string;
  percent?: number;
  detail?: string;
  text?: string;
  message?: string;
  loaded?: number;
  total?: number;
  file?: string;
}

function transcribeOnMainThread(
  audio: Float32Array,
  model: WhisperModel,
  language: string,
): Promise<string> {
  return import('@xenova/transformers').then(async ({ pipeline }) => {
    const pipe = await pipeline('automatic-speech-recognition', model, {});
    const fn = pipe as unknown as (
      audio: Float32Array,
      opts: Record<string, unknown>,
    ) => Promise<{ text?: string }>;
    const out = await fn(audio, {
      language,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });
    return (out.text ?? '').trim();
  });
}

export async function transcribeChunks(
  chunks: { chunk: Float32Array; start: number }[],
  model: WhisperModel,
  language: string,
  onProgress: ProgressFn,
): Promise<ChunkResult[]> {
  // Try the worker path first.
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('../workers/whisper.worker.ts', import.meta.url));
  } catch {
    worker = null;
  }

  if (!worker) {
    const results: ChunkResult[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const text = await transcribeOnMainThread(chunks[i].chunk, model, language);
      results.push({ index: i, start: chunks[i].start, text });
      onProgress(i + 1, chunks.length, 'main thread');
    }
    return results;
  }

  const results: ChunkResult[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const w = worker as Worker;
      // Total budget 10 min (was 120s — too short for a ~75-145 MB model
      // on a phone connection), but give up if NO progress at all for
      // 3 min, so a stalled download does not hang forever. The idle
      // timer resets on every progress message.
      const TOTAL_MS = 600_000;
      const IDLE_MS = 180_000;
      const startedAt = Date.now();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const fail = (err: Error) => {
        if (done) return;
        done = true;
        if (idleTimer) clearTimeout(idleTimer);
        w.removeEventListener('message', onMsg as EventListener);
        reject(err);
      };
      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          fail(
            new Error(
              `Whisper model download ရပ်နေတယ် — ${elapsed} စက္ကန့်အတွင်း တိုးတက်မှု မရှိပါ။ WiFi နဲ့ tiny model နဲ့ ပြန်စမ်းပါ`,
            ),
          );
        }, IDLE_MS);
      };
      const totalTimer = setTimeout(() => {
        fail(
          new Error(
            'Whisper model load timeout (10 မိနစ်) — model download မပြီးသေးပါ။ WiFi နဲ့ tiny model (~75MB) နဲ့ ပြန်စမ်းပါ၊ base (~145MB) က ဖုန်းနဲ့ အရမ်းကြီးပါတယ်',
          ),
        );
      }, TOTAL_MS);
      const onMsg = (e: MessageEvent<WorkerMsg>) => {
        const m = e.data;
        if (m.type === 'ready') {
          if (done) return;
          done = true;
          clearTimeout(totalTimer);
          if (idleTimer) clearTimeout(idleTimer);
          w.removeEventListener('message', onMsg as EventListener);
          resolve();
        } else if (m.type === 'error' && m.id === 'init') {
          clearTimeout(totalTimer);
          fail(new Error(m.message ?? 'worker init failed'));
        } else if (m.type === 'progress' && m.id === 'init') {
          armIdleTimer();
          const pct = m.percent ?? 0;
          // Show MB when the worker reports them, e.g.
          // "model 85.8% — model_quantized.onnx — 64.2/75.0 MB"
          // (percent is per-file, 0-100 — already fixed in the worker).
          let detail = `model ${pct}%`;
          if (m.file) detail += ` — ${m.file}`;
          if (typeof m.loaded === 'number' && typeof m.total === 'number' && m.total > 0) {
            detail += ` — ${(m.loaded / 1024 / 1024).toFixed(1)}/${(m.total / 1024 / 1024).toFixed(1)} MB`;
          }
          onProgress(0, chunks.length, detail);
        }
      };
      w.addEventListener('message', onMsg as EventListener);
      armIdleTimer();
      w.postMessage({ type: 'init', model });
    });

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const text = await new Promise<string>((resolve, reject) => {
        const w = worker as Worker;
        const onMsg = (e: MessageEvent<WorkerMsg>) => {
          const m = e.data;
          if (m.type === 'result' && m.id === `chunk-${i}`) {
            w.removeEventListener('message', onMsg as EventListener);
            resolve(m.text ?? '');
          } else if (m.type === 'error' && m.id === `chunk-${i}`) {
            w.removeEventListener('message', onMsg as EventListener);
            reject(new Error(m.message ?? 'transcribe failed'));
          }
        };
        w.addEventListener('message', onMsg as EventListener);
        const buf = c.chunk.buffer.slice(0) as ArrayBuffer;
        w.postMessage(
          {
            type: 'transcribe',
            id: `chunk-${i}`,
            audio: new Float32Array(buf),
            start: c.start,
            model,
            language,
          },
          [buf],
        );
      });
      results.push({ index: i, start: c.start, text });
      onProgress(i + 1, chunks.length, `chunk ${i + 1}/${chunks.length}`);
    }
    return results;
  } finally {
    worker.terminate();
  }
}
