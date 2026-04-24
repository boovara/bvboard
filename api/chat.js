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

function resolveDateContext(tz) {
  const safeTZ = tz || 'America/Los_Angeles';
  const now = new Date();
  const today   = now.toLocaleDateString('en-CA', { timeZone: safeTZ });              // YYYY-MM-DD
  const weekday = now.toLocaleDateString('en-US', { timeZone: safeTZ, weekday: 'long' });
  return { today, weekday, tz: safeTZ };
}

async function buildSnapshot() {
  const [bvBoard, projects, amazonOrders, crewSchedule, crew, daysOff] =
    await Promise.all(Object.values(TABLES).map(atFetchAll));

  const board = compact(bvBoard);
  const bySection = { tasks: [], supply: [], projectCodes: [], notices: [], canvas: [] };
  for (const rec of board) {
    const s = (rec.Section || '').toLowerCase();
    // Actual Airtable values are singular: task / supply / canvas / etc.
    if (s === 'task' || s === 'tasks')           bySection.tasks.push(rec);
    else if (s === 'supply')                     bySection.supply.push(rec);
    else if (s === 'project' || s === 'projects')bySection.projectCodes.push(rec);
    else if (s === 'notice'  || s === 'notices') bySection.notices.push(rec);
    else if (s === 'canvas'  || s === 'sticky')  bySection.canvas.push(rec);
  }

  // Pacific-default window is fine for the ±14d/60d cache-level filter —
  // actual "today" is injected per-request based on the caller's timezone.
  const now = new Date();
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

You can perform actions using tools when the caller's role is "admin". If the caller is not signed in (role is null) or is "crew", do not call tools — politely tell them to sign in as admin first. When a tool succeeds, briefly confirm what you did.

Gated tools (crew changes, event field edits, Slack sends) fire a confirmation chip before running.

CRITICAL rules when calling a gated tool:
1. Your text in that turn must be EXACTLY one short question, max ~10 words, phrased like the user is about to click yes/no. Examples: "Confirming Andrew for shop work tomorrow?" / "Reschedule Gold Gala to Friday?" / "DM Dylan and Perry for Saturday's setup?".
2. Do NOT explain your reasoning. Do NOT list records. Do NOT resolve the date out loud. Do NOT say "I need to identify...". Do NOT say "Looking at the crew schedule...". Just call the tool.
3. The confirmation chip below your message will show the exact details — don't restate them.

When the user gives a date in natural language, silently resolve it from the snapshot and call the tool with the right recordId. If multiple events match the date (or none), ask one brief question instead of guessing.`;

const SCHEDULER_BASE = 'https://bvscheduler.vercel.app';
const SCHEDULE_TABLE = 'tbliRwbSSEznesxhV';

async function fetchEventRecord(recordId) {
  const r = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${SCHEDULE_TABLE}/${recordId}`, {
    headers: { Authorization: `Bearer ${AT_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Airtable fetch ${r.status}: ${await r.text()}`);
  return r.json();
}

const CREW_FIELD_BY_CONTEXT = {
  setup:  { confirmed: 'SETUP \u2013 Confirmed Crew',   tentative: 'SETUP - Tentative',   keyConfirmed: 'setup-confirmed',  keyTentative: 'setup-tentative' },
  strike: { confirmed: 'STRIKE \u2013 Confirmed Crew',  tentative: 'STRIKE - Tentative',  keyConfirmed: 'strike-confirmed', keyTentative: 'strike-tentative' },
  shop:   { confirmed: 'SHOP - Confirmed',              tentative: 'SHOP - Tentative',    keyConfirmed: 'shop-confirmed',   keyTentative: 'shop-tentative' },
  hq:     { confirmed: 'HQ - Confirmed',                tentative: 'HQ - Tentative',      keyConfirmed: 'hq-confirmed',     keyTentative: 'hq-tentative' },
};

async function schedulerPatchCrew(recordId, keyToList, authHeader) {
  const r = await fetch(`${SCHEDULER_BASE}/api/update-crew`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: authHeader,
    },
    body: JSON.stringify({ recordId, fields: keyToList }),
  });
  if (!r.ok) throw new Error(`Scheduler ${r.status}: ${await r.text()}`);
  return r.json();
}

async function schedulerPatchField(recordId, fieldName, value, authHeader) {
  const r = await fetch(`${SCHEDULER_BASE}/api/update-field`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: authHeader,
    },
    body: JSON.stringify({ recordId, fieldName, value }),
  });
  if (!r.ok) throw new Error(`Scheduler ${r.status}: ${await r.text()}`);
  return r.json();
}

async function schedulerSlack(recordId, recipientNames, authHeader) {
  const r = await fetch(`${SCHEDULER_BASE}/api/slack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: authHeader,
    },
    body: JSON.stringify({ recordId, recipientNames }),
  });
  if (!r.ok) throw new Error(`Scheduler ${r.status}: ${await r.text()}`);
  return r.json();
}

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
            Section:   'task',
            LocalID:   localId,
            Text:      text,
            Name:      text.slice(0, 60),
            Done:      false,
            UpdatedAt: now,
          },
        }),
      });
      if (!r.ok) return { error: `Airtable ${r.status}: ${await r.text()}` };
      _snapshot = null;
      return { ok: true, message: `Added task: "${text}"` };
    },
  },
  {
    name: 'confirm_crew_member',
    description: 'Add a crew member to the CONFIRMED list for a given event + context (setup/strike/shop/hq). Gated — user confirms first.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Airtable recordId of the CREW SCHEDULE event' },
        context: { type: 'string', enum: ['setup','strike','shop','hq'] },
        name:    { type: 'string', description: 'Crew short name (e.g. "Dylan")' },
      },
      required: ['eventId','context','name'],
    },
    summarize: (i) => `Confirm ${i.name} for ${i.context} on the selected event?`,
    async execute(input, role, authHeader) {
      const map = CREW_FIELD_BY_CONTEXT[input.context];
      if (!map) return { error: 'Invalid context' };
      const rec = await fetchEventRecord(input.eventId);
      const confirmed = rec.fields[map.confirmed] || [];
      const tentative = rec.fields[map.tentative] || [];
      if (confirmed.includes(input.name)) return { ok: true, message: `${input.name} was already confirmed.` };
      const newConfirmed = [...confirmed, input.name];
      const newTentative = tentative.filter(n => n !== input.name);
      const fields = {};
      fields[map.keyConfirmed] = newConfirmed;
      fields[map.keyTentative] = newTentative;
      await schedulerPatchCrew(input.eventId, fields, authHeader);
      _snapshot = null;
      return { ok: true, message: `Confirmed ${input.name} for ${input.context}.` };
    },
  },
  {
    name: 'set_tentative_crew',
    description: 'Add a crew member to the TENTATIVE list for an event + context. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        context: { type: 'string', enum: ['setup','strike','shop','hq'] },
        name:    { type: 'string' },
      },
      required: ['eventId','context','name'],
    },
    summarize: (i) => `Add ${i.name} as tentative for ${i.context}?`,
    async execute(input, role, authHeader) {
      const map = CREW_FIELD_BY_CONTEXT[input.context];
      if (!map) return { error: 'Invalid context' };
      const rec = await fetchEventRecord(input.eventId);
      const tentative = rec.fields[map.tentative] || [];
      if (tentative.includes(input.name)) return { ok: true, message: `${input.name} was already tentative.` };
      const fields = {};
      fields[map.keyTentative] = [...tentative, input.name];
      await schedulerPatchCrew(input.eventId, fields, authHeader);
      _snapshot = null;
      return { ok: true, message: `Added ${input.name} as tentative for ${input.context}.` };
    },
  },
  {
    name: 'remove_crew_member',
    description: 'Remove a crew member from tentative AND confirmed lists for an event + context. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        context: { type: 'string', enum: ['setup','strike','shop','hq'] },
        name:    { type: 'string' },
      },
      required: ['eventId','context','name'],
    },
    summarize: (i) => `Remove ${i.name} from ${i.context}?`,
    async execute(input, role, authHeader) {
      const map = CREW_FIELD_BY_CONTEXT[input.context];
      if (!map) return { error: 'Invalid context' };
      const rec = await fetchEventRecord(input.eventId);
      const confirmed = (rec.fields[map.confirmed] || []).filter(n => n !== input.name);
      const tentative = (rec.fields[map.tentative] || []).filter(n => n !== input.name);
      const fields = {};
      fields[map.keyConfirmed] = confirmed;
      fields[map.keyTentative] = tentative;
      await schedulerPatchCrew(input.eventId, fields, authHeader);
      _snapshot = null;
      return { ok: true, message: `Removed ${input.name} from ${input.context}.` };
    },
  },
  {
    name: 'update_event_field',
    description: 'Update an admin-editable field on a CREW SCHEDULE event. Allowed fieldName values: DATE, EVENT, "SETUP \u2013 HQ Call Time", "SETUP \u2013 Venue Start", "SETUP \u2013 Complete By", "SETUP \u2013 Est. Hrs", "STRIKE \u2013 HQ Call Time", "STRIKE \u2013 Venue Start", "STRIKE \u2013 Complete By", "STRIKE \u2013 Est. Hrs", "SETUP \u2013 Crew Needed", "STRIKE \u2013 Crew Needed", "SHOP \u2013 Crew Needed", "CREW NEEDED". Use an en-dash (\u2013), not a hyphen. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        eventId:   { type: 'string' },
        fieldName: { type: 'string' },
        value:     { type: 'string', description: 'New value as string; numbers will be parsed server-side' },
      },
      required: ['eventId','fieldName','value'],
    },
    summarize: (i) => `Set ${i.fieldName} to "${i.value}"?`,
    async execute(input, role, authHeader) {
      await schedulerPatchField(input.eventId, input.fieldName, input.value, authHeader);
      _snapshot = null;
      return { ok: true, message: `Updated ${input.fieldName} → "${input.value}".` };
    },
  },
  {
    name: 'send_slack_to_crew',
    description: 'Send a scheduling Slack DM (with Accept/Decline buttons and a 15-min auto-reminder) to specific crew for a single event. recipientNames is an array of short names, or ["All Crew"] to DM everyone assigned to the event. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        eventId:        { type: 'string' },
        recipientNames: { type: 'array', items: { type: 'string' }, description: 'e.g. ["Dylan","Perry"] or ["All Crew"]' },
      },
      required: ['eventId','recipientNames'],
    },
    summarize: (i) => {
      const who = Array.isArray(i.recipientNames) ? i.recipientNames.join(', ') : '';
      return `DM ${who} about this event?`;
    },
    async execute(input, role, authHeader) {
      const result = await schedulerSlack(input.eventId, input.recipientNames, authHeader);
      const sent = (result.sent || []).join(', ') || 'no one';
      const skipped = (result.skipped || []).length ? ` (no Slack ID: ${result.skipped.join(', ')})` : '';
      return { ok: true, message: `Sent to ${sent}${skipped}.` };
    },
  },
];

function toolsForRole(role) {
  if (role !== 'admin') return []; // only admins get write tools
  return TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

async function runToolLoop(messages, role, authHeader, dateCtx) {
  // Loop: call Anthropic → execute any safe tool_use → feed results back → repeat.
  // Caps at 5 iterations as a safety valve.
  let workingMessages = messages.slice();
  for (let iter = 0; iter < 5; iter++) {
    const snapshot = await getSnapshot(false);
    const snapshotText =
      `Context: today=${dateCtx.today} (${dateCtx.weekday}), caller_timezone=${dateCtx.tz}, caller_role=${role || 'not signed in'}.\n\n`
      + 'Current Airtable snapshot:\n'
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

    const toolUses = content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) {
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      return { text };
    }

    // If any of the requested tools are gated, stop here and return pending info.
    const gatedUse = toolUses.find(u => {
      const def = TOOLS.find(t => t.name === u.name);
      return def && def.gated;
    });
    if (gatedUse) {
      const def = TOOLS.find(t => t.name === gatedUse.name);
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      const summary = def.summarize ? def.summarize(gatedUse.input || {}) : def.name;
      return {
        text,
        pending: {
          toolUseId: gatedUse.id,
          name:      gatedUse.name,
          input:     gatedUse.input,
          summary,
        },
      };
    }

    // All safe — execute, feed back, loop.
    workingMessages.push({ role: 'assistant', content });
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
  }
  return { text: '(too many tool iterations — stopping)' };
}

// Direct execution path — called when the client confirms a gated action.
// Returns { text, pending? } — pending is set when the action should offer
// a natural follow-up (e.g. crew changes offer a Slack notification).
async function executeConfirmed(name, input, role, authHeader) {
  if (role !== 'admin') throw new Error('Admin only');
  const def = TOOLS.find(t => t.name === name);
  if (!def) throw new Error('Unknown tool: ' + name);
  const result = await def.execute(input || {}, role, authHeader);
  if (result.error) throw new Error(result.error);
  const text = result.message || 'Done.';

  // After a crew change on a specific person, offer to Slack them about it.
  const crewTools = new Set(['confirm_crew_member', 'set_tentative_crew', 'remove_crew_member']);
  if (crewTools.has(name) && input.eventId && input.name) {
    return {
      text,
      pending: {
        toolUseId: 'followup-slack-' + Date.now(),
        name: 'send_slack_to_crew',
        input: { eventId: input.eventId, recipientNames: [input.name] },
        summary: `Send ${input.name} a Slack notification of the change?`,
      },
    };
  }
  return { text };
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

  const user = verify(req);
  const role = user?.role || null;
  const authHeader = req.headers['authorization'] || '';
  const dateCtx = resolveDateContext(req.body.tz);

  if (refresh) _snapshot = null;

  // Confirmation path — client confirmed a gated tool; execute and return result text.
  if (req.body.confirm) {
    const { name, input } = req.body.confirm;
    try {
      const result = await executeConfirmed(name, input, role, authHeader);
      return res.status(200).json({ text: result.text, pending: result.pending, role });
    } catch (e) {
      return res.status(200).json({ text: 'Failed: ' + e.message, role });
    }
  }

  // Cancellation path — don't do anything, just acknowledge.
  if (req.body.cancel) {
    return res.status(200).json({ text: 'Cancelled.', role });
  }

  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const result = await runToolLoop(messages, role, authHeader, dateCtx);
    return res.status(200).json({ text: result.text, pending: result.pending, role });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
