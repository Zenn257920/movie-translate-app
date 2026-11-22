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
      const onMsg = (e: MessageEvent<WorkerMsg>) => {
        const m = e.data;
        if (m.type === 'ready') resolve();
        else if (m.type === 'error' && m.id === 'init')
          reject(new Error(m.message ?? 'worker init failed'));
        else if (m.type === 'progress' && m.id === 'init') {
          onProgress(0, chunks.length, `model ${(m.percent ?? 0)}%`);
        }
      };
      w.addEventListener('message', onMsg as EventListener);
      w.postMessage({ type: 'init', model });
      setTimeout(() => reject(new Error('Whisper model load timeout (120s)')), 120_000);
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
