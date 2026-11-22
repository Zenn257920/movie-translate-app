# Movie Translate App

တရုတ် Video တင်လိုက် → မြန်မာ AI အသံ (recap) + မြန်မာစာတန်းထိုး ပြန်ရတဲ့ web app။
Upload a Chinese video and get back a Burmese AI voiceover recap + Burmese subtitles.

## ဘယ်လိုသုံးလဲ / How to use

1. Video တင်ပါ (၃ မိနစ်အထိ — ပထမအကြိမ် ၁ မိနစ်အောက်နဲ့ စမ်းပါ)
2. Mode ရွေးပါ — **Recap** (ဇာတ်လမ်းပြန်ပြောတဲ့ အသံ) ဒါမှမဟုတ် **Line-by-line** (စကားပြောအတိုင်း)
3. အသံရွေးပါ — **Thiha (ကျား, default)** ဒါမှမဟုတ် **Nilar (မ)**
4. **စတင်ဘာသာပြန်မယ်** ကို နှိပ်ပါ
5. ရလဒ် — အသံကို နားထောင်မယ်၊ MP3 ဆွဲမယ်၊ SRT ဆွဲမယ်၊ Script ကူးမယ်

## အလုပ်လုပ်ပုံ / How it works (all in the browser)

1. **Audio** — `AudioContext.decodeAudioData` နဲ့ ဗီဒီယိုထဲက အသံကို 16kHz mono အဖြစ် ထုတ်တယ်
2. **Transcribe** — Whisper (`@xenova/transformers`, tiny/base) ကို Web Worker ထဲမှာ run တယ် — model က HuggingFace CDN ကနေ လာတယ်, browser ထဲ cache ဖြစ်တယ်
3. **Translate** — တရုတ် → မြန်မာ ကို Google Translate free endpoint (`translate.googleapis.com`, key မလို) နဲ့ ပြန်တယ်
4. **Voiceover** — Microsoft **Edge TTS** ကို browser ကနေတိုက်ရိုက် ခေါ်တယ် (key မလို) — `my-MM-ThihaNeural` / `my-MM-NilarNeural`
5. **Outputs** — Voiceover MP3, Burmese SRT (Whisper timestamps), မြန်မာ script, မူရင်းစာသား

## အသံ / Voice

- **Default: Thiha (ကျား)** — `my-MM-ThihaNeural`, Microsoft ရဲ့ မြန်မာ အသံအစစ်
- **Alternative: Nilar (မ)** — `my-MM-NilarNeural`
- အသံထုတ်တိုင်း ဘယ် engine က ပြောလဲ ပြတယ် — Thiha မရရင် Google TTS fallback, အဲဒါလဲ မရရင် browser voice (play-only) — ဘယ်တော့မှ Thiha လို့ လိမ်မပြောဘူး
- Google ရဲ့ မြန်မာ အသံကို default အဖြစ် **မသုံးဘူး** (အသံမကောင်းလို့)

## ကန့်သတ်ချက်များ / Limits

- **No server, no API keys, no secrets** — အကုန်လုံး browser ထဲမှာပဲ လုပ်တယ် (Edge TTS မှာ သုံးတဲ့ `TrustedClientToken` က Edge browser ကိုယ်တိုင်မှာ ပါတဲ့ public constant ပါ၊ private key မဟုတ်ဘူး)
- Whisper model ကို ပထမအကြိမ် download လုပ်ရမယ် (~150MB tiny, ~290MB base) — အင်တာနက်လိုတယ်
- Video ၃ မိနစ်အထိပဲ — အရှည်ကြီးတွေ ဖုန်းနဲ့ လုပ်ရင် အရမ်းနှေးမယ်
- Edge TTS က Microsoft ရဲ့ တရားဝင် API မဟုတ်ဘဲ Edge browser သုံးတဲ့ consumer endpoint ပါ — Microsoft က ပြောင်းလဲသွားနိုင်တယ်၊ အဲဒီအခါ fallback အသံပဲ ရမယ်
- Recap mode မှာ SRT က မူရင်းစကားပြောရဲ့ စာတန်းထိုးပါ — recap အသံနဲ့ အချိန်မကိုက်ပါ။ Line-by-line mode မှာတော့ SRT နဲ့ အသံ ကိုက်ပါတယ်
- History က ဒီဖုန်း/browser ရဲ့ localStorage ထဲမှာပဲ သိမ်းတယ် — စာသားနဲ့ SRT ပဲ၊ အသံဖိုင်က ပြန်ထုတ်ရမယ်
- ကိုယ့်ဗီဒီယိုပဲ သုံးပါ — သူများရုပ်ရှင်ကို ပြန်တင်ရင် copyright ဖြစ်နိုင်တယ်

## Run it

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # static export -> out/
```

Deploy the `out/` folder to any static host (Vercel, Netlify, GitHub Pages).
