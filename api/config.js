/**
 * /api/config
 * GET — returns non-sensitive runtime config for the dashboard front-end.
 * The Airtable token lives in Vercel env vars (AT_ACCESS_TOKEN), never in HTML.
 */
export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  res.status(200).json({
    atToken: process.env.AT_ACCESS_TOKEN || '',
  });
}
