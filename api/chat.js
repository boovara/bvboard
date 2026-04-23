/**
 * /api/chat
 * POST { messages: [{role, content}], refresh?: boolean }
 * Streams an Anthropic response that can answer questions about the current
 * state of the BV Dashboard Airtable base. A compact JSON snapshot of the
 * relevant tables is injected as a cached system block so subsequent turns
 * hit the Anthropic prompt cache.
 */

const AT_TOKEN = process.env.AT_ACCESS_TOKEN;
const AT_BASE  = 'app5la8omfQHS9pvf';
const ANT_KEY  = process.env.ANTHROPIC_API_KEY;
const MODEL    = 'claude-haiku-4-5-20251001';

const TABLES = {
  bvBoard:       'tblMcvsvQg5vRgwgG', // BV Board (tasks, supply, project codes)
  projects:      'tblUul2v9r4QZQj0a', // Projects
  amazonOrders:  'tblvyFpFAmyt5qDDN', // Amazon Orders
  crewSchedule:  'tbliRwbSSEznesxhV', // CREW SCHEDULE
  crew:          'tblpTf7YgHMl6Tc1Q', // Crew
  daysOff:       'tblXVzHBF5YBYz4Jx', // DAYS OFF
};

// ── Module-level snapshot cache (60s TTL) ──────────────────────────────────
let _snapshot      = null;
let _snapshotAt    = 0;
const SNAPSHOT_TTL = 60 * 1000;

async function atFetchAll(tableId) {
  const out = [];
  let offset = null;
  do {
    const url = `https://api.airtable.com/v0/${AT_BASE}/${tableId}`
      + (offset ? `?offset=${encodeURIComponent(offset)}` : '');
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AT_TOKEN}` },
    });
    if (!r.ok) throw new Error(`Airtable ${tableId} ${r.status}: ${await r.text()}`);
    const d = await r.json();
    out.push(...(d.records || []));
    offset = d.offset || null;
  } while (offset);
  return out;
}

// Strip empty fields, attachment blobs, and optional-skip field names.
function compact(records, opts = {}) {
  const skip = new Set(opts.skip || []);
  const keep = opts.keep ? new Set(opts.keep) : null;
  return records.map(r => {
    const f = {};
    for (const [k, v] of Object.entries(r.fields || {})) {
      if (skip.has(k)) continue;
      if (keep && !keep.has(k)) continue;
      if (v === '' || v == null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (Array.isArray(v) && v[0] && typeof v[0] === 'object' && v[0].url) {
        f[k] = v.map(a => a.url).filter(Boolean);
      } else if (typeof v === 'string' && v.length > 500) {
        f[k] = v.slice(0, 500) + '…';
      } else {
        f[k] = v;
      }
    }
    return { id: r.id, ...f };
  });
}

async function buildSnapshot() {
  const [bvBoard, projects, amazonOrders, crewSchedule, crew, daysOff] =
    await Promise.all(Object.values(TABLES).map(atFetchAll));

  const board = compact(bvBoard);
  const bySection = { tasks: [], supply: [], projectCodes: [], notices: [] };
  for (const rec of board) {
    const s = (rec.Section || '').toLowerCase();
    if (s === 'tasks')         bySection.tasks.push(rec);
    else if (s === 'supply')   bySection.supply.push(rec);
    else if (s === 'projects') bySection.projectCodes.push(rec);
    else if (s === 'notices')  bySection.notices.push(rec);
  }

  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const today = now.toISOString().slice(0, 10);

  // CREW SCHEDULE: only keep rows in a 14-day-back / 60-day-forward window.
  const minDate = new Date(now); minDate.setDate(minDate.getDate() - 14);
  const maxDate = new Date(now); maxDate.setDate(maxDate.getDate() + 60);
  const inWindow = (dstr) => {
    if (!dstr) return false;
    const d = new Date(dstr);
    return d >= minDate && d <= maxDate;
  };
  const crewScheduleTrim = crewSchedule.filter(r => inWindow(r.fields?.DATE));

  const scheduleKeep = [
    'DATE','DAY','EVENT','TYPE','VENUE','CITY','NOTES',
    'SETUP - Tentative','SETUP – Confirmed Crew','SETUP – Crew Needed',
    'STRIKE - Tentative','STRIKE – Confirmed Crew','STRIKE – Crew Needed',
    'SHOP - Tentative','SHOP - Confirmed','SHOP – Crew Needed',
    'HQ - Tentative','HQ - Confirmed',
    'DAY OFF CREW','DAY OFF DATE',
    'PID (from Project Link)','Status (from Project Link)',
    'SETUP – HQ Call Time','STRIKE – HQ Call Time',
  ];

  const projectKeep = [
    'Name','PID','QB Code','Status','Event Date','Client','Venue','City',
    'Project Value','Deposit Received','Final Payment Received',
    'Notes','Type','Created','Last Modified',
  ];
  // Only keep projects whose status is operationally active (drop finished/cancelled).
  const activeProjects = projects.filter(r => {
    const s = (r.fields?.Status || '').toString().toLowerCase();
    return !s.includes('completed') && !s.includes('canceled') && !s.includes('cancelled')
        && !s.includes('closed') && !s.includes('no response') && !s.includes('send thank you');
  });

  const daysOffRecent = daysOff.filter(r => {
    const d = r.fields?.Date || r.fields?.DATE || r.fields?.['Day Off Date'];
    return !d || inWindow(d);
  });

  return {
    today,
    weekday,
    bvBoard:      bySection,
    projects:     compact(activeProjects, { keep: projectKeep }),
    amazonOrders: compact(amazonOrders),
    crewSchedule: compact(crewScheduleTrim, { keep: scheduleKeep }),
    crew:         compact(crew),
    daysOff:      compact(daysOffRecent),
  };
}

async function getSnapshot(refresh) {
  const age = Date.now() - _snapshotAt;
  if (!refresh && _snapshot && age < SNAPSHOT_TTL) return _snapshot;
  _snapshot   = await buildSnapshot();
  _snapshotAt = Date.now();
  return _snapshot;
}

const SYSTEM_INSTRUCTIONS = `You are Betty, the BV Dashboard assistant for BooVara Designs — a small event-fabrication shop.

You have a live JSON snapshot of the company's Airtable base (tasks, supply needs, project codes, Amazon orders, crew roster, crew schedule, days off). Answer the user's questions directly and concisely from that snapshot. Do not add disclaimers about data freshness unless the user asks.

Key conventions in the data:
- The CREW SCHEDULE table has separate Tentative vs Confirmed fields for SETUP, STRIKE, SHOP, and HQ on each day. Someone is "not yet confirmed" if they appear in a Tentative field but not the matching Confirmed field for that row.
- "Working in the shop today" = a crew name in SHOP - Confirmed (or SHOP - Tentative if no confirmed list) for a row whose DATE equals today.
- Projects have a QB Code field; a project without one is missing a QB code.
- Supply items live in bvBoard.supply. An item is "ordered" or "arrived" based on its fields.
- today's date and weekday are provided at the top of the snapshot — use them for relative queries ("today", "this week", "Friday").
- Reference crew members by first name. Keep answers short unless the user asks for detail.`;

export default async function handler(req, res) {
  // GET /api/chat?debug=1 → size breakdown per section (no Anthropic call).
  if (req.method === 'GET' && req.query?.debug) {
    try {
      const snap = await getSnapshot(true);
      const sizes = Object.fromEntries(
        Object.entries(snap).map(([k, v]) => [k, JSON.stringify(v).length])
      );
      return res.status(200).json({
        totalChars: JSON.stringify(snap).length,
        approxTokens: Math.round(JSON.stringify(snap).length / 4),
        sectionChars: sizes,
        counts: {
          tasks:        snap.bvBoard.tasks.length,
          supply:       snap.bvBoard.supply.length,
          projectCodes: snap.bvBoard.projectCodes.length,
          notices:      snap.bvBoard.notices.length,
          projects:     snap.projects.length,
          amazonOrders: snap.amazonOrders.length,
          crewSchedule: snap.crewSchedule.length,
          crew:         snap.crew.length,
          daysOff:      snap.daysOff.length,
        },
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (req.method !== 'POST') return res.status(405).end();
  if (!ANT_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { messages, refresh } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }

  let snapshot;
  try { snapshot = await getSnapshot(!!refresh); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const snapshotText =
    `Current Airtable snapshot (today=${snapshot.today}, weekday=${snapshot.weekday}):\n\n`
    + JSON.stringify(snapshot, null, 2);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         ANT_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 1024,
        stream:     true,
        system: [
          { type: 'text', text: SYSTEM_INSTRUCTIONS },
          { type: 'text', text: snapshotText, cache_control: { type: 'ephemeral' } },
        ],
        messages,
      }),
    });
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    return res.end();
  }

  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text().catch(() => '');
    res.write(`event: error\ndata: ${JSON.stringify({ error: `Anthropic ${upstream.status}: ${t}` })}\n\n`);
    return res.end();
  }

  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const evt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = evt.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const json = JSON.parse(dataLine.slice(6));
          if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
            res.write(`data: ${JSON.stringify({ text: json.delta.text })}\n\n`);
          } else if (json.type === 'message_stop') {
            res.write(`event: done\ndata: {}\n\n`);
          }
        } catch {}
      }
    }
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
}
