// POST /api/auth { pin } → { token, role }
// Mirrors crew-scheduler/api/auth.js exactly so either app can mint a
// cs_token that both trust (shared JWT_SECRET, ADMIN_PIN, CREW_PIN env vars).
const jwt    = require('jsonwebtoken');
const verify = require('./_verify');

const ADMIN_PIN = process.env.ADMIN_PIN;
const CREW_PIN  = process.env.CREW_PIN;
const SECRET    = process.env.JWT_SECRET;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pin } = req.body || {};

  if (!pin) {
    const user = verify(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const token = jwt.sign({ role: user.role }, SECRET, { expiresIn: '30d' });
    return res.status(200).json({ token, role: user.role });
  }

  let role = null;
  if (pin === ADMIN_PIN)      role = 'admin';
  else if (pin === CREW_PIN)  role = 'crew';
  else return res.status(401).json({ error: 'Invalid PIN' });

  const token = jwt.sign({ role }, SECRET, { expiresIn: '30d' });
  return res.status(200).json({ token, role });
};
