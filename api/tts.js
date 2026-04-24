/**
 * /api/tts
 * POST { text } → streams MP3 audio from ElevenLabs.
 * Keeps the ELEVENLABS_API_KEY server-side.
 */

const KEY      = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel
const MODEL_ID = 'eleven_flash_v2_5'; // ~3× faster first-byte than turbo

// Strip characters that make TTS stumble. Normalizes dashes to commas so
// Betty doesn't say "seven dash thirty"; strips markdown emphasis markers.
function sanitizeForTTS(text) {
  if (!text) return '';
  return String(text)
    .replace(/[*_~`#\[\]()<>|]/g, '')   // markdown + punctuation noise
    .replace(/\s*[—–-]\s*/g, ', ')      // em/en/hyphen between words → comma
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });

  const rawText = (req.body || {}).text;
  const text = sanitizeForTTS(rawText);
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key':   KEY,
          'content-type': 'application/json',
          'accept':       'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.status(502).json({ error: `ElevenLabs ${r.status}: ${t}` });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
