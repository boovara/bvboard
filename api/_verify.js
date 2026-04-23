// Shared JWT verification helper. Mirrors crew-scheduler/api/_verify.js
// so tokens issued by either app are valid in both (same JWT_SECRET).
const jwt = require('jsonwebtoken');

module.exports = function verifyToken(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
};
