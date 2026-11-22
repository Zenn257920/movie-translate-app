/** Extract 16kHz mono audio from a video file, in the browser. */

export async function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const d = video.duration;
      URL.revokeObjectURL(url);
      if (Number.isFinite(d)) resolve(d);
      else reject(new Error('ဗီဒီယိုအရှည် ဖတ်လို့မရပါ'));
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('ဗီဒီယိုဖိုင် ဖွင့်လို့မရပါ — mp4 / webm ဖိုင် ဖြစ်ကြောင်း စစ်ပါ'));
    };
    video.src = url;
  });
}

/**
 * Decode the file's audio track and resample to 16kHz mono Float32,
 * which is what Whisper expects. Must be called from a user gesture
 * (file picker counts).
 */
export async function extractAudio16k(file: File): Promise<Float32Array> {
  const buffer = await file.arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const decoded = await ctx.decodeAudioData(buffer);
    if (decoded.numberOfChannels === 1) {
      return decoded.getChannelData(0).slice(0);
    }
    // Mix down to mono.
    const len = decoded.length;
    const out = new Float32Array(len);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < len; i++) out[i] += data[i] / decoded.numberOfChannels;
    }
    return out;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/** Split mono 16k audio into ~30s chunks for Whisper. */
export function chunkAudio(
  audio: Float32Array,
  sampleRate = 16000,
  chunkSeconds = 30,
): { chunk: Float32Array; start: number }[] {
  const per = sampleRate * chunkSeconds;
  const out: { chunk: Float32Array; start: number }[] = [];
  for (let offset = 0; offset < audio.length; offset += per) {
    out.push({
      chunk: audio.slice(offset, Math.min(offset + per, audio.length)),
      start: offset / sampleRate,
    });
  }
  return out;
}
