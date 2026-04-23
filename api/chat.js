/**
 * /api/chat
 * POST { messages: [{role, content}], refresh?: boolean }
 * Streams an Anthropic response that can answer questions about the current
 * state of the BV Dashboard Airtable base. A compact JSON snapshot of the
 * relevant tables is injected as a cached system block so subsequent turns
 * hit the Anthropic prompt cache.
 */

const verify = require('./_verify');

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
- Reference crew members by first name. Keep answers short unless the user asks for detail.

You can perform actions using tools when the caller's role is "admin". If the caller is not signed in (role is null) or is "crew", do not call tools — politely tell them to sign in as admin first. When a tool succeeds, briefly confirm what you did.`;

// ── Tool definitions ─────────────────────────────────────────────────────
// Each tool has: { name, description, input_schema, gated, execute(input, role, authHeader) }
// gated=true means Betty proposes the action; client shows Confirm/Cancel.
const TOOLS = [
  {
    name: 'add_task',
    description: 'Add a new task to the BV Board Tasks section.',
    gated: false,
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The task description' },
      },
      required: ['text'],
    },
    async execute(input) {
      const text = String(input.text || '').trim();
      if (!text) return { error: 'Empty task text' };
      const now = new Date().toISOString();
      const localId = 'b_' + Math.random().toString(36).slice(2, 10);
      const r = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${TABLES.bvBoard}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AT_TOKEN}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          fields: {
            Section:   'tasks',
            LocalID:   localId,
            Text:      text,
            Name:      text.slice(0, 60),
            Done:      false,
            UpdatedAt: now,
          },
        }),
      });
      if (!r.ok) return { error: `Airtable ${r.status}: ${await r.text()}` };
      _snapshot = null; // invalidate cache so next read reflects the new task
      return { ok: true, message: `Added task: "${text}"` };
    },
  },
];

function toolsForRole(role) {
  if (role !== 'admin') return []; // only admins get write tools
  return TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

async function runToolLoop(messages, role, authHeader) {
  // Loop: call Anthropic → execute any safe tool_use → feed results back → repeat.
  // Caps at 5 iterations as a safety valve.
  let workingMessages = messages.slice();
  for (let iter = 0; iter < 5; iter++) {
    const snapshot = await getSnapshot(false);
    const snapshotText =
      `Current Airtable snapshot (today=${snapshot.today}, weekday=${snapshot.weekday}, caller_role=${role || 'not signed in'}):\n\n`
      + JSON.stringify(snapshot, null, 2);

    const body = {
      model:      MODEL,
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM_INSTRUCTIONS },
        { type: 'text', text: snapshotText, cache_control: { type: 'ephemeral' } },
      ],
      messages: workingMessages,
    };
    const tools = toolsForRole(role);
    if (tools.length) body.tools = tools;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         ANT_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      throw new Error(`Anthropic ${upstream.status}: ${t}`);
    }
    const data = await upstream.json();
    const content = data.content || [];

    // Collect any tool_use blocks
    const toolUses = content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) {
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      return { text };
    }

    // Append the assistant message with its tool_use blocks to the conversation
    workingMessages.push({ role: 'assistant', content });

    // Execute each tool and collect tool_result blocks
    const toolResults = [];
    for (const use of toolUses) {
      const def = TOOLS.find(t => t.name === use.name);
      if (!def) {
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: `Unknown tool: ${use.name}`, is_error: true });
        continue;
      }
      try {
        const result = await def.execute(use.input || {}, role, authHeader);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
          is_error: !!result.error,
        });
      } catch (e) {
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: e.message, is_error: true });
      }
    }

    workingMessages.push({ role: 'user', content: toolResults });
    // Loop back to Anthropic with tool results
  }
  return { text: '(too many tool iterations — stopping)' };
}

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

  const user = verify(req);
  const role = user?.role || null;
  const authHeader = req.headers['authorization'] || '';

  if (refresh) _snapshot = null;

  try {
    const result = await runToolLoop(messages, role, authHeader);
    return res.status(200).json({ text: result.text, role });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
