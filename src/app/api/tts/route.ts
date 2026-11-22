/**
 * POST /api/tts — Burmese voiceover, generated on the server (Vercel).
 *
 * Body: { text: string, voice?: 'thiha' | 'nilar' }  (thiha = default)
 * Success: MP3 bytes, Content-Type audio/mpeg,
 *   X-TTS-Provider: 'azure' (Thiha/Nilar via Azure Speech key),
 *   'edge' (Thiha/Nilar) or 'google' (fallback)
 * Failure: JSON { error: string } with status 400/502 — never fake audio.
 *
 * The browser on the user's phone could not reach Edge TTS (WebSocket) or
 * Google TTS (CORS), so the server does it instead and the phone only
 * downloads the finished MP3.
 */
import { synthesizeBurmese, type ServerVoice } from '@/lib/serverTts';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_CHARS = 5000;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Request body က JSON မဟုတ်ဘူး' }, { status: 400 });
  }
  const text =
    typeof (body as { text?: unknown })?.text === 'string'
      ? (body as { text: string }).text.trim()
      : '';
  const voiceRaw = (body as { voice?: unknown })?.voice;
  const voice: ServerVoice = voiceRaw === 'nilar' ? 'nilar' : 'thiha';

  if (!text) {
    return Response.json({ error: 'text မပါဘူး — အသံထုတ်ဖို့ စာလိုတယ်' }, { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return Response.json(
      { error: `စာရှည်လွန်းတယ် — ${MAX_CHARS} လုံးအထိပဲ လက်ခံပါတယ်` },
      { status: 400 },
    );
  }

  try {
    const { audio, provider } = await synthesizeBurmese(text, voice);
    return new Response(audio as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.length),
        'X-TTS-Provider': provider,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'မြန်မာအသံ ထုတ်မရပါ';
    return Response.json({ error: msg }, { status: 502 });
  }
}
