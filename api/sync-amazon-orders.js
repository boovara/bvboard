/**
 * /api/sync-amazon-orders
 * POST { tasks: [{id, text}] }
 * Fetches all records from the "Amazon Orders" Airtable table, fuzzy-matches
 * each task's text against Product Name + Keywords, and returns match results.
 */

const AT_TOKEN = process.env.AT_ACCESS_TOKEN;
const AT_BASE  = 'app5la8omfQHS9pvf';
const AT_TABLE = 'tblvyFpFAmyt5qDDN';

const STOP_WORDS = new Set([
  'a','an','the','and','or','of','for','to','in','on','at','with',
  'from','by','is','it','this','that','these','are','was','as','be',
  'been','has','have','had','but','not','any','all','can','its','my',
  'our','use','get','set','new','one','two','per','via','used',
]);

function tokenize(str) {
  return (str || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 2 && !STOP_WORDS.has(w); });
}

function matchScore(taskToks, productToks) {
  if (!taskToks.length || !productToks.length) return 0;
  var tSet = new Set(taskToks);
  var pSet = new Set(productToks);
  var overlap = 0;
  tSet.forEach(function(t) { if (pSet.has(t)) overlap++; });
  return overlap / Math.min(tSet.size, pSet.size);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { tasks } = req.body || {};
  if (!Array.isArray(tasks) || !tasks.length) {
    return res.status(400).json({ error: 'tasks array required' });
  }

  // ── Fetch all Amazon Orders records from Airtable ──────────────────────
  let records = [];
  let offset  = null;
  try {
    do {
      const url = `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`
        + `?fields[]=Product+Name&fields[]=Status&fields[]=Order+URL&fields[]=Keywords&fields[]=Thumbnail+URL&fields[]=Product+URL&fields[]=Expected+Delivery`
        + (offset ? `&offset=${encodeURIComponent(offset)}` : '');
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${AT_TOKEN}` },
      });
      if (!resp.ok) {
        const t = await resp.text();
        return res.status(500).json({ error: `Airtable ${resp.status}: ${t}` });
      }
      const data = await resp.json();
      records = records.concat(data.records || []);
      offset = data.offset || null;
    } while (offset);
  } catch (e) {
    console.error('sync-amazon-orders: Airtable fetch error', e);
    return res.status(500).json({ error: e.message });
  }

  // ── Pre-tokenize all Airtable records ─────────────────────────────────
  const THRESHOLD = 0.3;

  const productIndex = records.map(function(rec) {
    const name     = rec.fields['Product Name'] || '';
    const keywords = rec.fields['Keywords']     || '';
    return {
      id:           rec.id,
      name:         name,
      status:           (rec.fields['Status'] || 'Ordered').toLowerCase(),
      url:              rec.fields['Order URL']          || null,
      productUrl:       rec.fields['Product URL']        || null,
      thumbnailUrl:     rec.fields['Thumbnail URL']      || null,
      expectedDelivery: rec.fields['Expected Delivery']  || null,
      tokens:       tokenize(name + ' ' + keywords),
    };
  });

  // ── Match each task ────────────────────────────────────────────────────
  const matches = [];
  const matchedAmazonIds = new Set();

  tasks.forEach(function(task) {
    const taskToks = tokenize(task.text);
    if (!taskToks.length) return;

    let bestScore   = THRESHOLD;
    let bestProduct = null;

    productIndex.forEach(function(p) {
      const s = matchScore(taskToks, p.tokens);
      if (s > bestScore) {
        bestScore   = s;
        bestProduct = p;
      }
    });

    if (bestProduct) {
      matchedAmazonIds.add(bestProduct.id);
      const productUrl = bestProduct.productUrl || bestProduct.url
        || 'https://www.amazon.com/s?k=' + encodeURIComponent(bestProduct.name);
      matches.push({
        taskId:           task.id,
        amazonId:         bestProduct.id,
        productName:      bestProduct.name,
        status:           bestProduct.status,
        orderUrl:         productUrl,
        productUrl:       productUrl,
        thumbnailUrl:     bestProduct.thumbnailUrl     || null,
        expectedDelivery: bestProduct.expectedDelivery || null,
        score:            Math.round(bestScore * 100) / 100,
      });
    }
  });

  // ── Client-side card CREATION is DISABLED (always empty) ────────────────
  // The browser used to create a Supply card for every unmatched Amazon
  // order. But Amazon order identity is NOT persisted to Airtable — the
  // BV Board table has no amazonId field, so a card pulled back from Airtable
  // has no amazonId, the client can't tell it already exists, and re-creates
  // it on every 30-minute sync. Across reloads and multiple devices this
  // multiplied into a flood of duplicate cards (dozens of copies of the same
  // delivered order). The host routine (amazon-sync.js) is now the SOLE card
  // creator; it dedups via a persisted "Amazon Order" linked-record field.
  // The client only UPDATES existing cards' status via `matches` and displays
  // them — it must never create. Do not re-enable without giving BV Board a
  // persisted order-id key the client can dedup on.
  const newItems = [];

  return res.status(200).json({ matches, newItems });
}
