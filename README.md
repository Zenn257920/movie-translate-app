# Movie Translate App

တရုတ် Video တင်လိုက် → မြန်မာ AI အသံ (recap) + မြန်မာစာတန်းထိုး ပြန်ရတဲ့ web app။
Upload a Chinese video and get back a Burmese AI voiceover recap + Burmese subtitles.

## ဘယ်လိုသုံးလဲ / How to use

1. Video တင်ပါ (၃ မိနစ်အထိ — ပထမအကြိမ် ၁ မိနစ်အောက်နဲ့ စမ်းပါ)
2. Mode ရွေးပါ — **Recap** (ဇာတ်လမ်းပြန်ပြောတဲ့ အသံ) ဒါမှမဟုတ် **Line-by-line** (စကားပြောအတိုင်း)
3. အသံရွေးပါ — **Thiha (ကျား, default)** ဒါမှမဟုတ် **Nilar (မ)**
4. **စတင်ဘာသာပြန်မယ်** ကို နှိပ်ပါ
5. ရလဒ် — အသံကို နားထောင်မယ်၊ MP3 ဆွဲမယ်၊ SRT ဆွဲမယ်၊ Script ကူးမယ်

## အလုပ်လုပ်ပုံ / How it works

1. **Audio** — `AudioContext.decodeAudioData` နဲ့ ဗီဒီယိုထဲက အသံကို 16kHz mono အဖြစ် ထုတ်တယ် (browser ထဲမှာ)
2. **Transcribe** — Whisper (`@xenova/transformers`, tiny/base) ကို Web Worker ထဲမှာ run တယ် — model က HuggingFace CDN ကနေ လာတယ်, browser ထဲ cache ဖြစ်တယ်
3. **Translate** — တရုတ် → မြန်မာ ကို Google Translate free endpoint (`translate.googleapis.com`, key မလို) နဲ့ ပြန်တယ်
4. **Voiceover** — မြန်မာ အသံကို **server** (`POST /api/tts`, Vercel) က ထုတ်ပေးတယ် — Azure Speech key ရှိရင် အရင်ဆုံး Azure (Thiha/Nilar အစစ်)၊ ပြီးရင် Microsoft **Edge TTS** (`my-MM-ThihaNeural` / `my-MM-NilarNeural`)၊ မရရင် server-side Google TTS fallback။ ဖုန်းဘရောက်ဇာကနေ တိုက်ရိုက်ခေါ်တာ မရလို့ (Edge WebSocket ချိတ်မရ + Google fetch CORS ပိတ်တယ်) server ကို ပြောင်းထားတာ
5. **Outputs** — Voiceover MP3, Burmese SRT (Whisper timestamps), မြန်မာ script, မူရင်းစာသား

## အသံ / Voice

- **Default: Thiha (ကျား)** — `my-MM-ThihaNeural`, Microsoft ရဲ့ မြန်မာ အသံအစစ်
- **Alternative: Nilar (မ)** — `my-MM-NilarNeural`
- အသံထုတ်တိုင်း ဘယ် engine က ပြောလဲ ပြတယ် — Thiha မရရင် Google TTS fallback, အဲဒါလဲ မရရင် browser voice (play-only) — ဘယ်တော့မှ Thiha လို့ လိမ်မပြောဘူး
- Google ရဲ့ မြန်မာ အသံကို default အဖြစ် **မသုံးဘူး** (အသံမကောင်းလို့)

## Thiha အသံအစစ် ရဖို့ — Azure Speech key (free) / Real Thiha voice

Edge TTS က Vercel server ကတောင် ချိတ်မရတတ်လို့ (Microsoft က datacenter IP တွေကို ပိတ်တတ်တယ်)၊ အသံအစစ် သေချာရဖို့ အကောင်းဆုံးနည်းက Azure Speech free key ပါ — **F0 free tier, တစ်လ 500,000 စာလုံး အခမဲ့** (recap တစ်ပုဒ်က စာလုံး ရာဂဏန်းပဲ ရှိတယ်၊ လုံးဝ မကုန်ဘူး)။

1. [Azure Portal](https://portal.azure.com) ဖွင့် → **Create a resource** → **Speech** လို့ ရှာပါ
2. Resource group အသစ် (ဥပမာ `movie-translate`) → Region ရွေးပါ (အနီးဆုံး **Southeast Asia**) → Pricing tier **Free F0** ရွေးပါ → **Review + create**
3. Resource ဖွင့်ပြီး **Keys and Endpoint** မှာ **KEY 1** ကို Copy လုပ်ပါ၊ Region ကိုလည်း မှတ်ထားပါ (ဥပမာ `southeastasia`)
4. [Vercel dashboard](https://vercel.com/zenn-s-projects1/movie-translate-app) → Project **Settings → Environment Variables** → ထည့်ပါ
   - `AZURE_SPEECH_KEY` = KEY 1
   - `AZURE_SPEECH_REGION` = `southeastasia`
   - Environment: **Production** (အားလုံးရွေးလည်း ရတယ်)
5. **Deployments** → အပေါ်ဆုံး deployment ရဲ့ `⋯` → **Redeploy** — key ထည့်ပြီးမှ redeploy လုပ်မှ အလုပ်လုပ်ပါတယ်
6. စမ်းပါ — အသံထုတ်တိုင်း provider က `azure` လို့ ပြရင် Thiha အသံအစစ် ရပြီ

Key မထည့်ထားရင်လည်း app က ဆက်အလုပ်လုပ်ပါတယ် — Edge → Google fallback အတိုင်းပဲ။ Key ကို code ထဲ ဘယ်တော့မှ မထည့်ပါနဲ့ (Vercel env var ထဲမှာပဲ ထားပါ)။

## ကန့်သတ်ချက်များ / Limits

- **No API keys, no secrets** — Edge TTS မှာ သုံးတဲ့ `TrustedClientToken` က Edge browser ကိုယ်တိုင်မှာ ပါတဲ့ public constant ပါ၊ private key မဟုတ်ဘူး။ အသံကို Vercel server (`/api/tts`, Node runtime, 60s) က ထုတ်ပေးတယ် — static export မဟုတ်တော့ဘူး
- Whisper model ကို ပထမအကြိမ် download လုပ်ရမယ် (~150MB tiny, ~290MB base) — အင်တာနက်လိုတယ်
- Video ၃ မိနစ်အထိပဲ — အရှည်ကြီးတွေ ဖုန်းနဲ့ လုပ်ရင် အရမ်းနှေးမယ်
- Edge TTS က Microsoft ရဲ့ တရားဝင် API မဟုတ်ဘဲ Edge browser သုံးတဲ့ consumer endpoint ပါ — Microsoft က ပြောင်းလဲသွားနိုင်တယ်၊ အဲဒီအခါ fallback အသံပဲ ရမယ်
- Recap mode မှာ SRT က မူရင်းစကားပြောရဲ့ စာတန်းထိုးပါ — recap အသံနဲ့ အချိန်မကိုက်ပါ။ Line-by-line mode မှာတော့ SRT နဲ့ အသံ ကိုက်ပါတယ်
- History က ဒီဖုန်း/browser ရဲ့ localStorage ထဲမှာပဲ သိမ်းတယ် — စာသားနဲ့ SRT ပဲ၊ အသံဖိုင်က ပြန်ထုတ်ရမယ်
- ကိုယ့်ဗီဒီယိုပဲ သုံးပါ — သူများရုပ်ရှင်ကို ပြန်တင်ရင် copyright ဖြစ်နိုင်တယ်

## Run it

```bash
npm install
npm run dev     # http://localhost:3000 (API route /api/tts အပါအဝင်)
npm run build   # Vercel deploy — API routes ပါလို့ static export မဟုတ်ဘူး
```

Deploy: Vercel မှာ GitHub repo ကို import လုပ်ပြီး Deploy နှိပ်ရုံပဲ (env var မထည့်လည်း အလုပ်လုပ်တယ် — Thiha အသံအစစ် လိုချင်ရင် အပေါ်က Azure key ၂ ခုကို ထည့်ပါ)။
