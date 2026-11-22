'use client';

import { useEffect, useRef, useState } from 'react';
import { chunkAudio, extractAudio16k, getVideoDuration } from '@/lib/audio';
import {
  engineLabel,
  speakWithBrowser,
  synthesizeViaServer,
} from '@/lib/edgeTts';
import { buildLineScript, buildRecapScript, buildSrt } from '@/lib/recap';
import { translateSegments } from '@/lib/translate';
import { formatTime, VOICE_LABELS, type JobResult, type Mode, type Segment, type TtsEngine, type VoiceId, type WhisperModel } from '@/lib/types';
import { transcribeChunks } from '@/lib/whisper';

const MAX_SECONDS = 180;
const HISTORY_KEY = 'movie-translate-history-v1';

interface HistoryItem {
  id: string;
  title: string;
  createdAt: string;
  mode: Mode;
  voice: VoiceId;
  engineLabel: string;
  scriptMy: string;
  srtMy: string;
  transcript: Segment[];
}

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [duration, setDuration] = useState(0);
  const [mode, setMode] = useState<Mode>('recap');
  const [model, setModel] = useState<WhisperModel>('Xenova/whisper-tiny');
  const [voice, setVoice] = useState<VoiceId>('my-MM-ThihaNeural');
  const [sourceLang, setSourceLang] = useState<'zh' | 'en'>('zh');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [percent, setPercent] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [result, setResult] = useState<JobResult | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const voiceoverUrlRef = useRef('');

  useEffect(() => {
    setHistory(loadHistory());
    return () => {
      if (voiceoverUrlRef.current) URL.revokeObjectURL(voiceoverUrlRef.current);
    };
  }, []);

  const pushLog = (line: string) => setLog((prev) => [...prev.slice(-60), line]);

  const onPickFile = async (f: File | null) => {
    setError('');
    setResult(null);
    if (!f) {
      setFile(null);
      setVideoUrl('');
      setDuration(0);
      return;
    }
    try {
      const d = await getVideoDuration(f);
      if (d > MAX_SECONDS) {
        setError(
          `ဗီဒီယိုက ${formatTime(d)} ရှည်တယ် — ၃ မိနစ်အထိပဲ လက်ခံပါတယ်။ အတိုဖြတ်ပြီး ပြန်တင်ပေးပါ။`,
        );
        return;
      }
      setFile(f);
      setDuration(d);
      setVideoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(f);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ဖိုင်ဖတ်လို့မရပါ');
    }
  };

  const runPipeline = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    setResult(null);
    setLog([]);
    setPercent(0);
    try {
      // 1. Extract audio
      setStage('အသံထုတ်နေတယ်…');
      pushLog('1/5 အသံထုတ်နေတယ်…');
      const audio = await extractAudio16k(file);
      setPercent(10);
      pushLog(`အသံ ${formatTime(audio.length / 16000)} ရပြီ`);

      // 2. Transcribe with Whisper (in-browser)
      setStage('တရုတ်စကားကို စာသားပြောင်းနေတယ်… (Whisper model ပထမအကြိမ် download လုပ်ရမယ်)');
      const chunks = chunkAudio(audio);
      pushLog(`2/5 Whisper — အပိုင်း ${chunks.length} ခု`);
      const lang = sourceLang === 'zh' ? 'chinese' : 'english';
      const transcribed = await transcribeChunks(
        chunks,
        model,
        lang,
        (done, total, detail) => {
          if (detail?.startsWith('model')) {
            const m = detail.match(/(\d+)%/);
            setPercent(m ? Math.round(Number(m[1]) * 0.3) : 15);
            pushLog(`model download ${detail}`);
          } else {
            setPercent(10 + Math.round((done / total) * 30));
            if (detail) pushLog(detail);
          }
        },
      );
      const segments: Segment[] = transcribed
        .filter((c) => c.text.trim())
        .map((c) => ({
          start: c.start,
          end: Math.min(c.start + 30, duration || c.start + 30),
          zh: c.text.trim(),
          my: '',
          translated: false,
        }));
      if (segments.length === 0) {
        throw new Error('အသံထဲမှာ စကားမတွေ့ပါ — အသံပါတဲ့ ဗီဒီယို ဖြစ်ကြောင်း စစ်ပါ။');
      }
      pushLog(`စာသား အပိုင်း ${segments.length} ခု ရပြီ`);
      setPercent(45);

      // 3. Translate zh -> my
      setStage('မြန်မာလို ဘာသာပြန်နေတယ်…');
      pushLog('3/5 မြန်မာလို ဘာသာပြန်နေတယ်…');
      const translated = await translateSegments(
        segments.map((s) => s.zh),
        sourceLang === 'zh' ? 'zh-CN' : 'en',
        (done, total) => setPercent(45 + Math.round((done / total) * 20)),
      );
      const merged: Segment[] = segments.map((s, i) => ({
        ...s,
        my: translated[i].my,
        translated: translated[i].translated,
      }));
      const untranslated = merged.filter((s) => !s.translated).length;
      if (untranslated > 0) {
        pushLog(`သတိ — အပိုင်း ${untranslated} ခု ဘာသာပြန်မရလို့ မူရင်းစာအတိုင်း ထားထားတယ်`);
      }

      // 4. Build script
      const scriptMy =
        mode === 'recap' ? buildRecapScript(merged) : buildLineScript(merged);
      const srtMy = buildSrt(merged);
      setPercent(70);

      // 5. Voiceover — made on the server (POST /api/tts): Edge TTS
      // (Thiha/Nilar) first, Google fallback on the server. The phone
      // browser could not reach either service directly, so the server
      // does it and the phone only downloads the finished MP3.
      setStage('မြန်မာအသံ ထုတ်နေတယ်… (server က ထုတ်ပေးနေတယ်)');
      pushLog('4/5 မြန်မာအသံ ထုတ်နေတယ်… (server)');
      let voiceoverUrl = '';
      let engine: TtsEngine =
        voice === 'my-MM-ThihaNeural' ? 'edge-thiha' : 'edge-nilar';
      let downloadable = true;
      try {
        const res = await synthesizeViaServer(scriptMy, voice);
        voiceoverUrl = URL.createObjectURL(res.blob);
        engine = res.engine;
        setPercent(95);
        pushLog(`အသံ ရပြီ — ${engineLabel(engine)}`);
      } catch (serverErr) {
        pushLog(
          `Server အသံ မရပါ (${serverErr instanceof Error ? serverErr.message : 'error'}) — browser အသံနဲ့ ဖွင့်ပြမယ် (download မရပါ)`,
        );
        try {
          await speakWithBrowser(scriptMy);
          engine = 'speech-synthesis';
          downloadable = false;
        } catch {
          throw new Error(
            `မြန်မာအသံ ထုတ်မရပါ — ${serverErr instanceof Error ? serverErr.message : 'server error'} — အင်တာနက်စစ်ပြီး ပြန်စမ်းပါ`,
          );
        }
      }

      setPercent(100);
      setStage('ပြီးပြီ');
      pushLog('5/5 ပြီးပြီ');
      if (voiceoverUrlRef.current) URL.revokeObjectURL(voiceoverUrlRef.current);
      voiceoverUrlRef.current = voiceoverUrl;

      const job: JobResult = {
        id: `${Date.now()}`,
        title: file.name,
        createdAt: new Date().toISOString(),
        mode,
        voice,
        engine,
        engineLabel: engineLabel(engine),
        scriptMy,
        srtMy,
        transcript: merged,
        voiceoverUrl: voiceoverUrl || undefined,
        voiceoverDownloadable: downloadable,
      };
      setResult(job);
      const item: HistoryItem = {
        id: job.id,
        title: job.title,
        createdAt: job.createdAt,
        mode: job.mode,
        voice: job.voice,
        engineLabel: job.engineLabel,
        scriptMy: job.scriptMy,
        srtMy: job.srtMy,
        transcript: job.transcript,
      };
      const next = [item, ...loadHistory()].slice(0, 10);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      setHistory(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'မထင်မှတ်တဲ့ အမှား ဖြစ်သွားတယ်');
      pushLog(`ERROR: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setBusy(false);
    }
  };

  const openHistory = (item: HistoryItem) => {
    setResult({
      ...item,
      engine: 'edge-thiha',
      voiceoverUrl: undefined,
      voiceoverDownloadable: false,
    });
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="container">
      <header>
        <h1>🎬 Movie Translate</h1>
        <p>တရုတ် Video တင်လိုက် → မြန်မာ AI အသံ + မြန်မာစာတန်းထိုး ပြန်ရမယ်</p>
        <p className="muted">Whisper + ဘာသာပြန်က ဖုန်းထဲမှာ လုပ်တယ် — မြန်မာအသံကို server (Vercel) က ထုတ်ပေးတယ်၊ API key မလို</p>
      </header>

      <div className="card">
        <h2>1. ဗီဒီယို တင်ပါ</h2>
        <input
          type="file"
          accept="video/*"
          disabled={busy}
          onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        />
        <p className="hint">
          ၃ မိနစ်အထိပဲ — ပထမအကြိမ် စမ်းရင် ၁ မိနစ်အောက် အတိုလေးနဲ့ စမ်းပါ။
          Whisper model ကို ပထမအကြိမ် download လုပ်ရမယ် (~150MB)၊ အင်တာနက်လိုတယ်။
        </p>
        {videoUrl && (
          <>
            <video src={videoUrl} controls playsInline />
            <p className="muted">
              {file?.name} · {file ? (file.size / 1024 / 1024).toFixed(1) : ''} MB ·{' '}
              {formatTime(duration)}
            </p>
          </>
        )}

        <label>မူရင်းစကား / Original language</label>
        <div className="radio-row">
          <label>
            <input
              type="radio"
              checked={sourceLang === 'zh'}
              onChange={() => setSourceLang('zh')}
            />
            တရုတ် (Chinese)
          </label>
          <label>
            <input
              type="radio"
              checked={sourceLang === 'en'}
              onChange={() => setSourceLang('en')}
            />
            English
          </label>
        </div>

        <label>ပုံစံ / Mode</label>
        <div className="radio-row">
          <label>
            <input
              type="radio"
              checked={mode === 'recap'}
              onChange={() => setMode('recap')}
            />
            Recap — ဇာတ်လမ်းပြန်ပြောတဲ့ အသံ
          </label>
          <label>
            <input
              type="radio"
              checked={mode === 'line'}
              onChange={() => setMode('line')}
            />
            တစ်ကြောင်းချင်း — စကားပြောအတိုင်း
          </label>
        </div>

        <label>အသံ / Voice (မြန်မာ)</label>
        <div className="radio-row">
          <label>
            <input
              type="radio"
              checked={voice === 'my-MM-ThihaNeural'}
              onChange={() => setVoice('my-MM-ThihaNeural')}
            />
            Thiha (ကျား) — default
          </label>
          <label>
            <input
              type="radio"
              checked={voice === 'my-MM-NilarNeural'}
              onChange={() => setVoice('my-MM-NilarNeural')}
            />
            Nilar (မ)
          </label>
        </div>

        <label>Whisper model</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value as WhisperModel)}
        >
          <option value="Xenova/whisper-tiny">tiny — မြန်တယ်၊ အတိုလေးတွေအတွက်</option>
          <option value="Xenova/whisper-base">base — ပိုတိကျတယ်၊ နှေးတယ်</option>
        </select>

        <button disabled={!file || busy} onClick={() => void runPipeline()}>
          {busy ? 'လုပ်နေတယ်…' : 'စတင်ဘာသာပြန်မယ် ▶'}
        </button>

        {busy && (
          <>
            <p className="hint">{stage}</p>
            <div className="progress">
              <div style={{ width: `${percent}%` }} />
            </div>
          </>
        )}
        {log.length > 0 && <div className="log">{log.join('\n')}</div>}
        {error && <div className="error">⚠️ {error}</div>}
      </div>

      {result && (
        <div className="card">
          <h2>2. ရလဒ်</h2>
          <span className="badge">အသံ: {result.engineLabel}</span>
          {result.engine === 'google-tts' && (
            <p className="hint">
              ⚠️ ဒီအသံက Google TTS fallback ပါ — server မှာ Edge (Thiha/Nilar)
              မရလို့ပါ။ ပြန်စမ်းကြည့်ပါ၊ မရသေးရင် ခဏစောင့်ပြီးမှ ပြန်လုပ်ပါ။
            </p>
          )}
          {result.engine === 'speech-synthesis' && (
            <p className="hint">
              ⚠️ Browser အသံနဲ့ပဲ ဖွင့်ပြထားတယ် — download ဆွဲလို့မရပါ။
            </p>
          )}
          {result.voiceoverUrl && (
            <audio src={result.voiceoverUrl} controls />
          )}

          <div>
            {result.voiceoverUrl && result.voiceoverDownloadable && (
              <button
                className="secondary"
                onClick={() => {
                  fetch(result.voiceoverUrl as string)
                    .then((r) => r.blob())
                    .then((b) =>
                      downloadBlob(b, `${result.title.replace(/\.[^.]+$/, '')}-voiceover.mp3`),
                    )
                    .catch(() => setError('အသံဖိုင် download လုပ်လို့မရပါ'));
                }}
              >
                ⬇ အသံ MP3 ဆွဲမယ်
              </button>
            )}
            <button
              className="secondary"
              onClick={() =>
                downloadBlob(
                  new Blob([result.srtMy], { type: 'text/plain;charset=utf-8' }),
                  `${result.title.replace(/\.[^.]+$/, '')}-my.srt`,
                )
              }
            >
              ⬇ စာတန်းထိုး SRT ဆွဲမယ်
            </button>
            <button
              className="secondary"
              onClick={() => {
                navigator.clipboard?.writeText(result.scriptMy).catch(() => undefined);
              }}
            >
              📋 Script ကူးမယ်
            </button>
          </div>

          <label>မြန်မာ Script</label>
          <textarea readOnly value={result.scriptMy} />
          <p className="hint">
            Recap mode မှာ SRT က မူရင်းစကားပြောရဲ့ စာတန်းထိုးပါ — recap အသံနဲ့
            အချိန်မကိုက်ပါ။ Line-by-line mode မှာတော့ SRT နဲ့ အသံ ကိုက်ပါတယ်။
          </p>

          <label>စာသား — မူရင်း + မြန်မာ</label>
          <table>
            <thead>
              <tr>
                <th>အချိန်</th>
                <th>မူရင်း</th>
                <th>မြန်မာ</th>
              </tr>
            </thead>
            <tbody>
              {result.transcript.map((s, i) => (
                <tr key={i}>
                  <td>{formatTime(s.start)}</td>
                  <td>{s.zh}</td>
                  <td>
                    {s.my}
                    {!s.translated && ' ⚠️'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {history.length > 0 && (
        <div className="card">
          <h2>မှတ်တမ်း / History (ဒီဖုန်းထဲမှာပဲ)</h2>
          <p className="hint">
            စာသားနဲ့ SRT ပဲ သိမ်းထားတယ် — အသံဖိုင်ကို ပြန်လိုချင်ရင် ပြန်ထုတ်ရမယ်။
          </p>
          {history.map((h) => (
            <div key={h.id} className="history-item" onClick={() => openHistory(h)}>
              <strong>{h.title}</strong>
              <br />
              <span className="muted">
                {new Date(h.createdAt).toLocaleString()} ·{' '}
                {h.mode === 'recap' ? 'Recap' : 'Line-by-line'} · {VOICE_LABELS[h.voice]} ·{' '}
                {h.engineLabel}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>သတိပြုရန်</h2>
        <p className="hint">
          • Whisper model ကို ပထမအကြိမ် download လုပ်ရမယ် (~150MB)၊ ပြီးရင်
          browser ထဲ cache ဖြစ်သွားမယ်။
          <br />
          • မြန်မာအသံကို server (Vercel, /api/tts) က ထုတ်ပေးတယ် — Microsoft
          Edge TTS (Thiha/Nilar) အရင်၊ မရရင် Google TTS fallback။ ဖုန်းဘရောက်ဇာကနေ
          တိုက်ရိုက်ခေါ်တာ မရလို့ server ကို ပြောင်းထားတာ။
          <br />
          • Edge TTS က Microsoft ရဲ့ တရားဝင် API မဟုတ်ဘဲ Edge browser သုံးတဲ့
          consumer endpoint ပါ — key မလိုဘူး၊ ဒါပေမယ့် Microsoft က ပြောင်းလဲသွားနိုင်တယ်။
          <br />• ဗီဒီယိုအရှည်ကြီးတွေ ဖုန်းနဲ့ လုပ်ရင် နှေးမယ်၊ အရင် ၁ မိနစ်အောက်နဲ့
          စမ်းပါ။
          <br />• ကိုယ့်ဗီဒီယိုပဲ သုံးပါ — သူများရုပ်ရှင်ကို ပြန်တင်ရင် copyright
          ဖြစ်နိုင်တယ်။
        </p>
      </div>
    </div>
  );
}
