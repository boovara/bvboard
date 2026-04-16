/**
 * /api/create-qb-jobcode
 * GET ?code=<QB Code>
 * Creates a QB Time jobcode (assigned to all) from the given code string.
 * Called by the Airtable "Create QB Customer" button field via Open URL.
 */

const QBT_TOKEN = process.env.QBT_ACCESS_TOKEN;

const html = (title, body, color = '#2d7a4f') => `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: #fff; border-radius: 12px; padding: 32px 40px; max-width: 480px;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; }
  h2 { margin: 0 0 12px; color: ${color}; font-size: 22px; }
  p  { margin: 0; color: #555; font-size: 15px; line-height: 1.5; }
  .code { font-family: monospace; background: #f0f0f0; border-radius: 6px;
          padding: 4px 10px; font-size: 14px; color: #333; display: inline-block;
          margin: 8px 0; }
</style></head>
<body><div class="card">
  <h2>${title}</h2>
  ${body}
  <p style="margin-top:18px;font-size:12px;color:#aaa">You can close this tab.</p>
</div></body></html>`;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { code } = req.query;

  if (!code || !code.trim()) {
    return res.status(400).send(html(
      'No QB Code',
      '<p>This record has no QB Code set.<br>Generate one first, then click this button.</p>',
      '#e67e22'
    ));
  }

  const name = code.trim();

  try {
    const resp = await fetch('https://rest.tsheets.com/api/v1/jobcodes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${QBT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: [{ name, type: 'regular', assigned_to_all: true, connect_with_quickbooks: true }]
      }),
    });

    const data = await resp.json();
    const job  = data?.results?.jobcodes?.['1'];

    if (!resp.ok || !job) {
      console.error('QB Time error:', resp.status, JSON.stringify(data));
      return res.status(500).send(html(
        'QB Time Error',
        `<p>Status ${resp.status}</p><pre style="text-align:left;font-size:12px;overflow:auto">${JSON.stringify(data, null, 2)}</pre>`,
        '#c0392b'
      ));
    }

    // Already exists
    if (job._status_code === 409 || (job._status_message || '').toLowerCase().includes('exist')) {
      return res.status(200).send(html(
        'Already Exists',
        `<p>A QB Customer named</p><span class="code">${name}</span><p>already exists in QB Time.</p>`,
        '#e67e22'
      ));
    }

    return res.status(200).send(html(
      '✓ QB Customer Created',
      `<span class="code">${job.name}</span>
       <p>Assigned to all team members.<br>QB Time ID: ${job.id}</p>`
    ));

  } catch (e) {
    console.error('create-qb-jobcode exception:', e);
    return res.status(500).send(html('Server Error', `<p>${e.message}</p>`, '#c0392b'));
  }
}
