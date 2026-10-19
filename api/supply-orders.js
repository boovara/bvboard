/**
 * /api/supply-orders
 * GET -> { orders: [...] }
 *
 * The Supply pane's entire data source for Amazon items. The "Amazon Orders"
 * Airtable table is already a clean, Gmail-fed feed: the BV Agent Host's
 * amazon-sync job reads order confirmation / shipping / delivery emails and
 * writes one row per order number. This endpoint just reads that table back.
 *
 * Deliberately NOT what the old /api/sync-amazon-orders did. That one
 * fuzzy-matched order names against hand-made board cards, which meant a card
 * could be tagged with an unrelated order (wrong thumbnail, wrong link, wrong
 * ETA) and re-tagged differently on the next 30-minute pass. There is no
 * matching here at all: one Amazon order is one card, keyed by its own record
 * id. Nothing to mismatch.
 */

const AT_TOKEN = process.env.AT_ACCESS_TOKEN;
const AT_BASE  = 'app5la8omfQHS9pvf';
const AT_TABLE = 'tblvyFpFAmyt5qDDN'; // "Amazon Orders"

// A delivered order stays on the board this long so there's still a "did that
// land?" glance, then drops off on its own.
const DELIVERED_GRACE_DAYS = 7;

// Amazon often never sends (or the sync never catches) a delivery email, so an
// order can sit at "Shipped" indefinitely — 11 of the first 15 cards on this
// board were stale, some 83 days past their ETA and permanently red. Anything
// this far past its estimated arrival is treated as delivered whatever the
// stored status says. Genuinely-late orders still show OVERDUE for two weeks,
// so that warning stays meaningful instead of becoming permanent noise.
const STALE_ETA_DAYS = 14;

// An order with no ETA at all can't be aged out by the rule above, so fall
// back to its order date with a wider window.
const NO_ETA_DAYS = 30;

// Guard-rail on how much the pane will ever render.
const MAX_CARDS = 40;

// Rows older than this can't survive the age-out rules below (unless their ETA is
// still recent, which the formula also keeps), so don't fetch them at all: the table
// grows forever, the kiosk re-reads it every half hour, and each 100-row page is one
// Airtable call against a workspace with a monthly API-call cap.
const FETCH_WINDOW_DAYS = 90;
const FETCH_FORMULA =
  `OR({Order Date} = BLANK(), ` +
  `IS_AFTER({Order Date}, DATEADD(TODAY(), -${FETCH_WINDOW_DAYS}, 'days')), ` +
  `IS_AFTER({Expected Delivery}, DATEADD(TODAY(), -${STALE_ETA_DAYS}, 'days')))`;

const FIELDS = [
  'Product Name', 'Status', 'Expected Delivery', 'Order Date',
  'Order URL', 'Product URL', 'PO Number', 'Order Number',
];

/**
 * Tidy a stored Product Name for display. Rows created off a shipping email
 * (rather than an order confirmation, which carries real /dp/ product links)
 * fall back to the email subject, so they arrive looking like:
 *   Shipped: \u20662\u2069 "QNCZ 4\" Caster Wheels,..."
 *   Shipped: \u20661\u2069 Bath item
 * Strip the status prefix and the invisible bidi isolates Amazon wraps counts
 * in, so the card reads as the thing that was bought.
 */
function cleanProductName(raw) {
  let s = String(raw || '')
    .replace(/[\u2066-\u2069\u200e\u200f]/g, '')  // bidi isolate / direction marks
    .replace(/^\s*(?:re:\s*)?(?:your\s+)?(?:amazon(?:\.com)?\s+)?(?:order\s+)?(?:ordered|shipped|delivered|out for delivery)\s*[:\-\u2014]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // The subject often wraps the item in quotes and truncates with an ellipsis.
  s = s.replace(/^["\u201c'](.*?)["\u201d']?(?:\.{3}|\u2026)?$/, '$1').trim();
  s = s.replace(/(?:\.{3}|\u2026)$/, '').trim();
  return s || String(raw || '').trim();
}

/** Whole days from `dateStr` (YYYY-MM-DD) to today. Null when unparseable. */
function daysSince(dateStr) {
  if (!dateStr) return null;
  const p = String(dateStr).slice(0, 10).split('-');
  if (p.length !== 3) return null;
  const then = Date.UTC(+p[0], +p[1] - 1, +p[2]);
  if (Number.isNaN(then)) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - then) / 86400000);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!AT_TOKEN) return res.status(500).json({ error: 'AT_ACCESS_TOKEN not configured' });

  let records = [];
  let offset  = null;
  try {
    do {
      const url = `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}?pageSize=100`
        + `&filterByFormula=${encodeURIComponent(FETCH_FORMULA)}`
        + FIELDS.map((f) => `&fields[]=${encodeURIComponent(f)}`).join('')
        + (offset ? `&offset=${encodeURIComponent(offset)}` : '');
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
      if (!resp.ok) {
        const t = await resp.text();
        return res.status(500).json({ error: `Airtable ${resp.status}: ${t.slice(0, 300)}` });
      }
      const data = await resp.json();
      records = records.concat(data.records || []);
      offset = data.offset || null;
    } while (offset);
  } catch (e) {
    console.error('supply-orders: Airtable fetch failed', e);
    return res.status(500).json({ error: e.message });
  }

  const orders = records
    .map(function (rec) {
      const f = rec.fields || {};
      const status = String(f.Status || 'Ordered');
      return {
        id:               rec.id,
        productName:      cleanProductName(f['Product Name']) || '(unnamed order)',
        status:           status,
        expectedDelivery: f['Expected Delivery'] || null,
        orderDate:        f['Order Date']        || null,
        po:               f['PO Number']         || null,
        orderNumber:      f['Order Number']      || null,
        url:              f['Product URL'] || f['Order URL'] || null,
      };
    })
    .filter(function (o) {
      if (o.status.toLowerCase() === 'delivered') {
        // Expected Delivery is the closest thing the table has to a
        // delivered-on date; fall back to the order date so a row missing an
        // ETA still ages out instead of sitting on the board forever.
        const age = daysSince(o.expectedDelivery || o.orderDate);
        return age !== null && age <= DELIVERED_GRACE_DAYS;
      }
      // Still Ordered/Shipped: age out on how far past the ETA it is.
      const pastEta = daysSince(o.expectedDelivery);
      if (pastEta !== null) return pastEta <= STALE_ETA_DAYS;
      const age = daysSince(o.orderDate);
      return age === null || age <= NO_ETA_DAYS;
    })
    .sort(function (a, b) {
      return String(b.orderDate || '').localeCompare(String(a.orderDate || ''));
    })
    .slice(0, MAX_CARDS);

  // Small, stable payload - read on page load and on the pane's ↻ button.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ orders });
}
