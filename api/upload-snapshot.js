/**
 * /api/upload-snapshot
 * Receives raw PNG from the browser, converts to base64,
 * and uploads to Airtable using the confirmed-working JSON+base64 format
 * (same approach as BV Detail Sheet Generator).
 */
export const config = { api: { bodyParser: false } };

const AT_TOKEN        = process.env.AT_TOKEN;
const AT_BASE         = 'app5la8omfQHS9pvf';
const AT_TID          = 'tblMcvsvQg5vRgwgG';
const AT_SNAPSHOT_REC = 'recXTLodSlq3SPYmC';
const AT_ATTACH_FID   = 'flddFx9yRPR2w20Cx';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Read raw PNG body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const imageBuffer = Buffer.concat(chunks);
    const base64Data  = imageBuffer.toString('base64');
    const filename    = `notices-${new Date().toISOString().slice(0,16).replace('T','_').replace(':','h')}m.png`;

    // Clear existing attachment first
    const clearRes = await fetch(
      `https://api.airtable.com/v0/${AT_BASE}/${AT_TID}/${AT_SNAPSHOT_REC}`,
      {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { [AT_ATTACH_FID]: [] } }),
      }
    );
    // Log but don't abort if clear fails — upload will still add the new screenshot
    if (!clearRes.ok) console.warn('Clear step failed:', clearRes.status, await clearRes.text());

    // Upload via JSON+base64 (confirmed working format from BV Detail Sheet Generator)
    const uploadRes = await fetch(
      `https://content.airtable.com/v0/${AT_BASE}/${AT_SNAPSHOT_REC}/${AT_ATTACH_FID}/uploadAttachment`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contentType: 'image/png',
          filename,
          file: base64Data,
        }),
      }
    );

    const result = await uploadRes.text();
    if (!uploadRes.ok) return res.status(500).json({ error: 'upload failed', status: uploadRes.status, detail: result });

    res.status(200).json({ ok: true, filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
