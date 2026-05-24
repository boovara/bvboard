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
const MODEL    = 'claude-sonnet-4-5-20250929';

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
  const today   = now.toLocaleDateString('en-CA', { timeZone: safeTZ });
  const weekday = now.toLocaleDateString('en-US', { timeZone: safeTZ, weekday: 'long' });

  // Precomputed date ladder for the next 14 days so Claude can't miscount.
  // Each entry: "YYYY-MM-DD (Weekday, Month D)" keyed by relative label.
  const labels = ['today','tomorrow','day after tomorrow'];
  const ladder = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const ymd = d.toLocaleDateString('en-CA', { timeZone: safeTZ });
    const wk  = d.toLocaleDateString('en-US', { timeZone: safeTZ, weekday: 'long' });
    const md  = d.toLocaleDateString('en-US', { timeZone: safeTZ, month: 'long', day: 'numeric' });
    const label = labels[i] || wk;
    ladder.push(`${label === wk ? '' : label + ' = '}${wk}, ${md} (${ymd})`);
  }
  return { today, weekday, tz: safeTZ, ladder };
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

  // Pacific-default window is fine for the cache-level filter — actual "today"
  // is injected per-request based on the caller's timezone. Widened to -30/+60
  // so the day-by-day digest can show a full month of history.
  const now = new Date();
  const minDate = new Date(now); minDate.setDate(minDate.getDate() - 30);
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

  // DAYS OFF uses "Date Start" / "Date End". Keep a record if either end of the
  // range falls inside the visible window so Betty can see upcoming + recent PTO.
  const daysOffRecent = daysOff.filter(r => {
    const s = r.fields?.['Date Start'];
    const e = r.fields?.['Date End'];
    return (!s && !e) || inWindow(s) || inWindow(e);
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

// Build a per-day digest covering [today - 30d, today + 30d]. Each day lists
// ONLY the CREW SCHEDULE rows whose DATE field is that literal day. Empty
// days are explicit. Eliminates Betty's ability to pattern-match across days.
const DIGEST_BACK_DAYS    = 30;
const DIGEST_FORWARD_DAYS = 30;

function buildDayByDayDigest(snapshot, dateCtx) {
  const safeTZ = dateCtx.tz;
  const today = new Date();
  const lines = [];
  for (let i = -DIGEST_BACK_DAYS; i <= DIGEST_FORWARD_DAYS; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const ymd = d.toLocaleDateString('en-CA', { timeZone: safeTZ });
    const wk  = d.toLocaleDateString('en-US', { timeZone: safeTZ, weekday: 'long' });
    const md  = d.toLocaleDateString('en-US', { timeZone: safeTZ, month: 'long', day: 'numeric' });
    const allRows = (snapshot.crewSchedule || []).filter(r => r.DATE === ymd);
    // Skip rows whose linked Project Status is canceled / closed / no-response /
    // thank-you. Those events are dead; Betty shouldn't surface them.
    // Also skip rows that are empty placeholders (no event, no crew anywhere)
    // — they're calendar clutter and should be treated as "nothing scheduled".
    const rows = allRows.filter(r => {
      if (rowIsEmptyPlaceholder(r)) return false;
      const status = r['Status (from Project Link)'];
      if (!status) return true;
      const joined = (Array.isArray(status) ? status.join(' ') : String(status)).toLowerCase();
      return !joined.includes('cancel') && !joined.includes('closed')
          && !joined.includes('no response') && !joined.includes('thank you');
    });
    let header = `${wk}, ${md} (${ymd})`;
    if (i === 0) header += ' [today]';
    else if (i === 1) header += ' [tomorrow]';
    else if (i === -1) header += ' [yesterday]';
    if (rows.length === 0) {
      lines.push(`${header}: NO ROWS — nobody assigned, no events.`);
      continue;
    }
    const parts = [];
    for (const r of rows) {
      const fragments = [];
      fragments.push(`eventId=${r.id}`);
      if (r.EVENT) fragments.push(`event "${String(r.EVENT).trim()}"${r.TYPE ? ` (${r.TYPE})` : ''}`);
      if (r['SHOP - Confirmed'])     fragments.push(`shop confirmed: ${r['SHOP - Confirmed'].join(', ')}`);
      if (r['SHOP - Tentative'])     fragments.push(`shop tentative: ${r['SHOP - Tentative'].join(', ')}`);
      if (r['HQ - Confirmed'])       fragments.push(`HQ confirmed: ${r['HQ - Confirmed'].join(', ')}`);
      if (r['HQ - Tentative'])       fragments.push(`HQ tentative: ${r['HQ - Tentative'].join(', ')}`);
      if (r['SETUP – Confirmed Crew']) fragments.push(`setup confirmed: ${r['SETUP – Confirmed Crew'].join(', ')}`);
      if (r['SETUP - Tentative'])           fragments.push(`setup tentative: ${r['SETUP - Tentative'].join(', ')}`);
      if (r['STRIKE – Confirmed Crew'])fragments.push(`strike confirmed: ${r['STRIKE – Confirmed Crew'].join(', ')}`);
      if (r['STRIKE - Tentative'])          fragments.push(`strike tentative: ${r['STRIKE - Tentative'].join(', ')}`);
      if (r['DAY OFF CREW'])         fragments.push(`day off: ${r['DAY OFF CREW'].join(', ')}`);
      if (fragments.length === 0) {
        parts.push(`row ${r.id} present but no event/crew fields`);
      } else {
        parts.push(fragments.join('; '));
      }
    }
    lines.push(`${header}: ${parts.join(' | ')}`);
  }
  return lines.join('\n');
}

const SYSTEM_INSTRUCTIONS = `You are Betty, a voice assistant for BooVara Designs — a small event-fabrication shop. Your replies will be spoken aloud.

You have a live JSON snapshot of the company's Airtable base (tasks, supply needs, project codes, Amazon orders, crew roster, crew schedule, days off). Answer directly and concisely.

RESPONSE STYLE — your replies are read by text-to-speech, so write like you're casually talking to a coworker:
- Conversational and flowing, like you'd say it out loud.
- No markdown, no asterisks, no underscores, no backticks, no pound signs, no brackets, no parentheses.
- No em dashes, no en dashes, no hyphens between words, no colons. Use commas, "and", or restructure.
- No bullet points, no headers, no labels like "Setup:" or "Confirmed:". Weave that info into the sentence.
- No disclaimers like "let me check" or "based on the data". Just answer.

For day summaries, model your response on this example exactly:

Q: What's happening Wednesday?
A: Wednesday the 27th, you have Derrick, Dylan and Dejah in the shop, and Andrew and Michelle for HQ. There's also an install for Google in Oakland, of which Elijah and Javier are confirmed, and Perry is still tentative.

Notice: short date phrasing ("Wednesday the 27th"), names listed naturally, "you have" / "there's also" connectors, tentative vs confirmed worked into the prose. Skip any segment that has no people or no event.

Data conventions:
- CREW SCHEDULE has separate Tentative vs Confirmed lists per SETUP / STRIKE / SHOP / HQ. Someone is "not yet confirmed" if they're tentative but not confirmed.
- CREW SCHEDULE DATE is the ONLY authoritative dispatch date — it's when our crew is actually working that event. NEVER pull dates from the PROJECTS table's "Event Date" field (which is when the client's event happens) and mention them as if our crew were dispatched then. If a date doesn't appear in CREW SCHEDULE, our crew isn't going on that day, period.
- Projects without a QB Code field value are "missing a QB code".
- Reference crew by first name.

When summarizing what's happening over a date range (a day, week, month):
- List ONLY rows in CREW SCHEDULE whose DATE is inside that range. Do not invent or supplement from elsewhere.
- Skip rows whose Status (from Project Link) contains "Canceled", "Cancelled", or "Closed" UNLESS the user explicitly asks about canceled work.
- Group multi-day events (setup + strike of the same project) into one mention when adjacent.
- Use the conversational example style above.

Interpreting time references — be strict, never include past dates in forward-looking summaries:
- "today" = today's date in the ladder
- "tomorrow" = the next day in the ladder
- "this week" / "the rest of this week" = today through the upcoming Sunday (i.e. today and the next 6 days max). Do NOT include past weekdays from earlier in the calendar week.
- "next week" = the Monday after the upcoming Sunday, through that Sunday (a full 7-day window starting the next Monday).
- "this month" = today through the last day of the current month. Do NOT include earlier dates in the month.
- For any "past" reference ("last week", "yesterday", "this past Monday") the user must phrase it explicitly; otherwise default to forward-looking.
- ALWAYS state the date range you're summarizing in the first sentence so the user can sanity-check it. E.g. "From today through Sunday May 30, the shop is empty." or "May 25 to May 31: only Adobe setup on Monday."
- If the resolved range has zero CREW SCHEDULE rows, say so plainly. E.g. "Nothing is on the calendar from today through Sunday." Do not pad with old data.

ABSOLUTE NEVER-DO list when summarizing crew assignments:
1. NEVER copy a crew list from one date to another date. If May 25 has no CREW SCHEDULE row, the correct answer for May 25 is "no one assigned" — not whatever was on May 18.
2. NEVER assume schedules repeat week-to-week. Past weeks are NOT a template for future weeks.
3. NEVER infer, guess, or pattern-match crew names. The ONLY valid source is a CREW SCHEDULE row whose DATE field is the literal date you're reporting.
4. If you find yourself about to say "[name] is in the shop on [date]", confirm: is there a row in the snapshot with DATE = that exact date AND that name in SHOP - Confirmed (or Tentative)? If not, do NOT say it.
5. When in doubt, report "no one assigned" — it is far better to under-report than to fabricate.

You can perform actions using tools when the caller's role is "admin". If the caller is not signed in (role is null) or is "crew", do not call tools — politely tell them to sign in as admin first. When a tool succeeds, briefly confirm what you did.

Gated tools (crew changes, event field edits, Slack sends) fire a confirmation chip before running.

CRITICAL rules when calling a gated tool:
1. Your text in that turn must be EXACTLY one short question, max ~10 words, phrased like the user is about to click yes/no. Examples: "Confirming Andrew for shop work tomorrow?" / "Reschedule Gold Gala to Friday?" / "DM Dylan and Perry for Saturday's setup?".
2. Do NOT explain your reasoning. Do NOT list records. Do NOT resolve the date out loud. Do NOT say "I need to identify...". Do NOT say "Looking at the crew schedule...". Just call the tool.
3. The confirmation chip below your message will show the exact details — don't restate them.

When the user gives a date in natural language:
- ALWAYS resolve it using the "Date ladder" above — never compute days of the week yourself. The ladder is the source of truth.
- Then find the CREW SCHEDULE row whose DATE field EXACTLY matches the resolved YYYY-MM-DD.
- If NO row exactly matches, do NOT substitute a nearby date. Ask briefly: "I don't see an event on Friday, April 24. Did you mean another date?"
- If multiple rows match, ask which one.

When calling crew-change tools, ALWAYS populate a dateLabel from the snapshot's DATE field (e.g. "Mon Apr 27") so the confirmation chip shows the actual date. Don't omit dateLabel.

Choosing the right crew tool:
- SHOP or HQ assignments are NOT tied to any event. Always use assign_shop_or_hq(name, date, context, status, dateLabel). This tool will reuse the day's existing placeholder row or create one if the date has no rows yet. Never refuse a shop/HQ assignment because the day has no events scheduled.
- MOVE a crew member from one shop/HQ day to another: use move_shop_or_hq(name, fromDate, toDate, context, status, fromDateLabel, toDateLabel) — ONE tool call, atomic remove+add. NEVER use remove + assign as separate calls. Watch for the words "move", "switch", "reschedule", "instead", "change [X]'s day".
- SETUP or STRIKE assignments belong to a specific event. Use confirm_crew_member / set_tentative_crew / remove_crew_member with the eventId of that event row (the eventId is shown in each digest line).
- If the user just says "add Perry to Tuesday" with no context, default to shop.

When the user requests crew assignment for multiple days/events at once (e.g. "Monday through Wednesday", "Friday and Saturday", "the next three shop days"):
- Use confirm_crew_member_batch ONCE with all the assignments — never fire confirm_crew_member multiple times.
- Resolve each date to its eventId + context from the snapshot.
- The chip will list all dates so the user can confirm everything in one tap.`;

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

async function schedulerAddDayOff(crewName, startDate, endDate, note, authHeader) {
  const r = await fetch(`${SCHEDULER_BASE}/api/days-off`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: authHeader },
    body: JSON.stringify({ crew: crewName, start: startDate, end: endDate, note: note || '' }),
  });
  if (!r.ok) throw new Error(`Scheduler ${r.status}: ${await r.text()}`);
  return r.json();
}

async function schedulerDeleteDayOff(id, authHeader) {
  const r = await fetch(`${SCHEDULER_BASE}/api/days-off?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: authHeader },
  });
  if (!r.ok) throw new Error(`Scheduler ${r.status}: ${await r.text()}`);
  return r.json();
}

async function schedulerCreateShopRecord(date, authHeader) {
  const r = await fetch(`${SCHEDULER_BASE}/api/create-shop-record`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: authHeader },
    body: JSON.stringify({ date }),
  });
  if (!r.ok) throw new Error(`Scheduler create-shop-record ${r.status}: ${await r.text()}`);
  return r.json();
}

async function deleteScheduleRow(rowId) {
  const url = `https://api.airtable.com/v0/${AT_BASE}/${SCHEDULE_TABLE}/${rowId}`;
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${AT_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Airtable delete ${r.status}: ${await r.text()}`);
  return r.json();
}

// True if a CREW SCHEDULE row has no event AND no crew assigned anywhere.
// Such rows are dead placeholders and should be deleted to keep the calendar
// from accumulating empty cards on a date.
function rowIsEmptyPlaceholder(fields) {
  const f = fields || {};
  if (f.EVENT || f.TYPE) return false;
  const crewFields = [
    'SHOP - Confirmed', 'SHOP - Tentative',
    'HQ - Confirmed', 'HQ - Tentative',
    'SETUP – Confirmed Crew', 'SETUP - Tentative',
    'STRIKE – Confirmed Crew', 'STRIKE - Tentative',
    'DAY OFF CREW',
  ];
  for (const fn of crewFields) {
    if (Array.isArray(f[fn]) && f[fn].length > 0) return false;
  }
  return true;
}

async function fetchScheduleRowsForDate(date) {
  // Airtable's DATE field is a datetime under the hood — direct string
  // comparison like {DATE}='2026-05-27' doesn't match. DATETIME_FORMAT
  // coerces it to a YYYY-MM-DD string for reliable equality.
  const formula = `DATETIME_FORMAT({DATE}, 'YYYY-MM-DD')='${date}'`;
  const url = `https://api.airtable.com/v0/${AT_BASE}/${SCHEDULE_TABLE}`
    + `?filterByFormula=${encodeURIComponent(formula)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.records || [];
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
// Direct Airtable fetch for arbitrary date ranges — used by the lookup tool
// so Betty can answer questions outside the day-by-day digest window
// (which covers -30 to +30 days).
async function lookupScheduleRange(startDate, endDate) {
  const formula = `AND(IS_AFTER({DATE},'${startDate}'),IS_BEFORE({DATE},'${endDate}'))`;
  const url = `https://api.airtable.com/v0/${AT_BASE}/${SCHEDULE_TABLE}`
    + `?filterByFormula=${encodeURIComponent(formula)}`
    + `&fields[]=DATE&fields[]=DAY&fields[]=EVENT&fields[]=TYPE`
    + `&fields[]=SHOP%20-%20Confirmed&fields[]=SHOP%20-%20Tentative`
    + `&fields[]=HQ%20-%20Confirmed&fields[]=HQ%20-%20Tentative`
    + `&fields[]=SETUP%20%E2%80%93%20Confirmed%20Crew&fields[]=SETUP%20-%20Tentative`
    + `&fields[]=STRIKE%20%E2%80%93%20Confirmed%20Crew&fields[]=STRIKE%20-%20Tentative`
    + `&fields[]=DAY%20OFF%20CREW`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.records || []).map(rec => ({ id: rec.id, ...rec.fields }));
}

const TOOLS = [
  {
    name: 'lookup_schedule_by_date_range',
    description: 'Fetch CREW SCHEDULE rows for an arbitrary date range, useful for questions outside the day-by-day digest window (more than 30 days in the past or future). startDate and endDate are inclusive YYYY-MM-DD. Returns an array of rows with their crew assignments. Read-only — does not require admin.',
    gated: false,
    public: true, // anyone signed in OR not can call this read-only tool
    input_schema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        endDate:   { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      },
      required: ['startDate','endDate'],
    },
    async execute(input) {
      // Filter uses IS_AFTER/BEFORE which are exclusive — pad by one day on each side.
      const padBefore = new Date(input.startDate + 'T00:00:00Z'); padBefore.setUTCDate(padBefore.getUTCDate() - 1);
      const padAfter  = new Date(input.endDate   + 'T00:00:00Z'); padAfter.setUTCDate(padAfter.getUTCDate() + 1);
      const pad = (d) => d.toISOString().slice(0, 10);
      const rows = await lookupScheduleRange(pad(padBefore), pad(padAfter));
      if (rows.length === 0) {
        return { ok: true, rows: [], message: `No CREW SCHEDULE rows between ${input.startDate} and ${input.endDate}.` };
      }
      return { ok: true, rows };
    },
  },
  {
    name: 'scan_empty_placeholders',
    description: 'Scan CREW SCHEDULE for empty placeholder rows in a date range (rows with no event AND no crew assigned anywhere). Returns a list with dates and recordIds. Read-only — use this to see what cleanup_empty_placeholders would delete.',
    gated: false,
    public: true,
    input_schema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        endDate:   { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      },
      required: ['startDate','endDate'],
    },
    async execute(input) {
      const padBefore = new Date(input.startDate + 'T00:00:00Z'); padBefore.setUTCDate(padBefore.getUTCDate() - 1);
      const padAfter  = new Date(input.endDate   + 'T00:00:00Z'); padAfter.setUTCDate(padAfter.getUTCDate() + 1);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const rows = await lookupScheduleRange(fmt(padBefore), fmt(padAfter));
      const empties = rows.filter(r => rowIsEmptyPlaceholder(r));
      return {
        ok: true,
        count: empties.length,
        empties: empties.map(r => ({ id: r.id, date: r.DATE })),
      };
    },
  },
  {
    name: 'cleanup_empty_placeholders',
    description: 'Delete empty CREW SCHEDULE placeholder rows in a date range. A row is "empty" if it has no event AND no crew assigned in any field. Safe to run — events and rows with real crew assignments are never touched. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        endDate:   { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        rangeLabel:{ type: 'string', description: 'Human-readable range for the chip (e.g. "May 2026")' },
      },
      required: ['startDate','endDate','rangeLabel'],
    },
    summarize: (i) => `Delete empty placeholder rows in ${i.rangeLabel}?`,
    async execute(input, role, authHeader) {
      const padBefore = new Date(input.startDate + 'T00:00:00Z'); padBefore.setUTCDate(padBefore.getUTCDate() - 1);
      const padAfter  = new Date(input.endDate   + 'T00:00:00Z'); padAfter.setUTCDate(padAfter.getUTCDate() + 1);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const rows = await lookupScheduleRange(fmt(padBefore), fmt(padAfter));
      const empties = rows.filter(r => rowIsEmptyPlaceholder(r));
      let deleted = 0;
      const failed = [];
      for (const r of empties) {
        try { await deleteScheduleRow(r.id); deleted++; }
        catch (e) { failed.push(`${r.DATE || r.id}: ${e.message}`); }
      }
      _snapshot = null;
      if (failed.length === 0) {
        return { ok: true, message: `Deleted ${deleted} empty row${deleted === 1 ? '' : 's'} in ${input.rangeLabel}.` };
      }
      return { ok: true, message: `Deleted ${deleted}, ${failed.length} failed: ${failed.join('; ')}.` };
    },
  },
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
    name: 'assign_shop_or_hq',
    description: 'Assign a crew member to SHOP or HQ for a given date — independent of any event. Use this for any shop or HQ assignment, NOT confirm_crew_member. If no row exists for the date yet, this tool will auto-create a shop-day placeholder row first. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        name:      { type: 'string',  description: 'Crew short name (e.g. "Dylan")' },
        date:      { type: 'string',  description: 'YYYY-MM-DD' },
        context:   { type: 'string',  enum: ['shop','hq'] },
        status:    { type: 'string',  enum: ['confirmed','tentative'], description: 'Defaults to confirmed' },
        dateLabel: { type: 'string',  description: 'Human-readable date for the chip (e.g. "Mon May 25")' },
      },
      required: ['name','date','context','dateLabel'],
    },
    summarize: (i) => {
      const st = (i.status || 'confirmed');
      const ctxLabel = i.context === 'hq' ? 'HQ' : 'shop';
      return st === 'confirmed'
        ? `Confirm ${i.name} for ${ctxLabel} on ${i.dateLabel}?`
        : `Add ${i.name} as tentative for ${ctxLabel} on ${i.dateLabel}?`;
    },
    async execute(input, role, authHeader) {
      const status  = input.status || 'confirmed';
      const ctxMap  = CREW_FIELD_BY_CONTEXT[input.context];
      if (!ctxMap) return { error: 'Invalid context (must be shop or hq)' };

      // Find an existing placeholder row for this date — prefer one with
      // SHOP CREW=true or one without an EVENT/TYPE. If none, create one.
      const rows = await fetchScheduleRowsForDate(input.date);
      let placeholder = rows.find(r => r.fields['SHOP CREW'] === true);
      if (!placeholder) placeholder = rows.find(r => !r.fields.EVENT && !r.fields.TYPE);
      if (!placeholder) {
        const created = await schedulerCreateShopRecord(input.date, authHeader);
        placeholder = { id: created.id, fields: created.fields || {} };
      }

      const confirmedField = ctxMap.confirmed;
      const tentativeField = ctxMap.tentative;
      const targetField    = status === 'confirmed' ? confirmedField : tentativeField;
      const targetKey      = status === 'confirmed' ? ctxMap.keyConfirmed : ctxMap.keyTentative;
      const existing       = placeholder.fields[targetField] || [];
      if (existing.includes(input.name)) {
        return { ok: true, message: `${input.name} is already ${status} for ${input.context} on ${input.dateLabel}.` };
      }
      // If they were on the opposite list (e.g. tentative → confirmed), drop from there.
      const otherField   = status === 'confirmed' ? tentativeField : confirmedField;
      const otherKey     = status === 'confirmed' ? ctxMap.keyTentative : ctxMap.keyConfirmed;
      const otherList    = (placeholder.fields[otherField] || []).filter(n => n !== input.name);

      const fields = {};
      fields[targetKey] = [...existing, input.name];
      fields[otherKey]  = otherList;
      await schedulerPatchCrew(placeholder.id, fields, authHeader);
      _snapshot = null;
      return {
        ok: true,
        eventId: placeholder.id,
        message: `Added ${input.name} to ${input.context} ${status} on ${input.dateLabel}.`,
      };
    },
  },
  {
    name: 'move_shop_or_hq',
    description: 'Move a crew member from SHOP or HQ on one date to the same context on another date — atomic remove + add. Use this whenever the user says "move", "switch", "reschedule", or "instead". One chip, one tap, both rows updated. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        name:          { type: 'string',  description: 'Crew short name' },
        fromDate:      { type: 'string',  description: 'YYYY-MM-DD they are leaving' },
        toDate:        { type: 'string',  description: 'YYYY-MM-DD they are moving to' },
        context:       { type: 'string',  enum: ['shop','hq'] },
        status:        { type: 'string',  enum: ['confirmed','tentative'], description: 'Defaults to confirmed' },
        fromDateLabel: { type: 'string',  description: 'Human label e.g. "Mon May 26"' },
        toDateLabel:   { type: 'string',  description: 'Human label e.g. "Tue May 27"' },
      },
      required: ['name','fromDate','toDate','context','fromDateLabel','toDateLabel'],
    },
    summarize: (i) => {
      const ctx = i.context === 'hq' ? 'HQ' : 'shop';
      return `Move ${i.name} from ${ctx} on ${i.fromDateLabel} to ${ctx} on ${i.toDateLabel}?`;
    },
    async execute(input, role, authHeader) {
      const status  = input.status || 'confirmed';
      const ctxMap  = CREW_FIELD_BY_CONTEXT[input.context];
      if (!ctxMap) return { error: 'Invalid context (must be shop or hq)' };

      // ── Remove from EVERY row on the FROM date that contains the name ────
      // We can't reliably guess which placeholder Perry is on — find by
      // membership in the relevant field on any row for the date.
      const fromRows = await fetchScheduleRowsForDate(input.fromDate);
      const fromRowsWithName = fromRows.filter(r => {
        const conf = r.fields[ctxMap.confirmed] || [];
        const tent = r.fields[ctxMap.tentative] || [];
        return conf.includes(input.name) || tent.includes(input.name);
      });
      let fromPlaceholder = fromRowsWithName[0] || null; // pick any matching row for the slack/result eventId
      for (const r of fromRowsWithName) {
        const confirmed = (r.fields[ctxMap.confirmed] || []).filter(n => n !== input.name);
        const tentative = (r.fields[ctxMap.tentative] || []).filter(n => n !== input.name);
        const removeFields = {};
        removeFields[ctxMap.keyConfirmed] = confirmed;
        removeFields[ctxMap.keyTentative] = tentative;
        await schedulerPatchCrew(r.id, removeFields, authHeader);
        // If this leaves the row totally empty (no event, no crew), delete it.
        const post = Object.assign({}, r.fields);
        post[ctxMap.confirmed] = confirmed;
        post[ctxMap.tentative] = tentative;
        if (rowIsEmptyPlaceholder(post)) {
          try { await deleteScheduleRow(r.id); } catch (_) {}
        }
      }

      // ── Add to the TO date (auto-create row if needed) ────────────────────
      const toRows = await fetchScheduleRowsForDate(input.toDate);
      let toPlaceholder = toRows.find(r => r.fields['SHOP CREW'] === true);
      if (!toPlaceholder) toPlaceholder = toRows.find(r => !r.fields.EVENT && !r.fields.TYPE);
      if (!toPlaceholder) {
        const created = await schedulerCreateShopRecord(input.toDate, authHeader);
        toPlaceholder = { id: created.id, fields: created.fields || {} };
      }
      const targetField = status === 'confirmed' ? ctxMap.confirmed : ctxMap.tentative;
      const targetKey   = status === 'confirmed' ? ctxMap.keyConfirmed : ctxMap.keyTentative;
      const otherKey    = status === 'confirmed' ? ctxMap.keyTentative : ctxMap.keyConfirmed;
      const otherField  = status === 'confirmed' ? ctxMap.tentative : ctxMap.confirmed;
      const existing    = toPlaceholder.fields[targetField] || [];
      const otherList   = (toPlaceholder.fields[otherField] || []).filter(n => n !== input.name);
      const addFields = {};
      addFields[targetKey] = existing.includes(input.name) ? existing : [...existing, input.name];
      addFields[otherKey]  = otherList;
      await schedulerPatchCrew(toPlaceholder.id, addFields, authHeader);

      _snapshot = null;
      return {
        ok: true,
        eventId: toPlaceholder.id,
        fromEventId: fromPlaceholder ? fromPlaceholder.id : null,
        message: `Moved ${input.name} from ${input.fromDateLabel} to ${input.toDateLabel} (${input.context} ${status}).`,
      };
    },
  },
  {
    name: 'confirm_crew_member',
    description: 'Add a crew member to the CONFIRMED list for a given event + context (setup/strike/shop/hq). Gated — user confirms first.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        eventId:   { type: 'string', description: 'Airtable recordId of the CREW SCHEDULE event' },
        context:   { type: 'string', enum: ['setup','strike','shop','hq'] },
        name:      { type: 'string', description: 'Crew short name (e.g. "Dylan")' },
        dateLabel: { type: 'string', description: 'Human-readable date label for the confirmation chip, e.g. "Monday Apr 27" (extracted from the snapshot DATE field)' },
      },
      required: ['eventId','context','name','dateLabel'],
    },
    summarize: (i) => `Confirm ${i.name} for ${i.context} on ${i.dateLabel}?`,
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
        eventId:   { type: 'string' },
        context:   { type: 'string', enum: ['setup','strike','shop','hq'] },
        name:      { type: 'string' },
        dateLabel: { type: 'string', description: 'Human-readable date for the chip (e.g. "Monday Apr 27")' },
      },
      required: ['eventId','context','name','dateLabel'],
    },
    summarize: (i) => `Add ${i.name} as tentative for ${i.context} on ${i.dateLabel}?`,
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
    name: 'confirm_crew_member_batch',
    description: 'Confirm the SAME crew member for MULTIPLE event/context pairs at once. Use when the user requests several days in one breath, e.g. "confirm Andrew for shop Monday through Wednesday" or "set Dylan as confirmed for setup on Friday and strike on Saturday". Single chip, single confirmation, batch execution.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Crew short name' },
        assignments: {
          type:  'array',
          minItems: 1,
          description: 'List of event+context pairs to confirm this crew member for',
          items: {
            type: 'object',
            properties: {
              eventId:   { type: 'string' },
              context:   { type: 'string', enum: ['setup','strike','shop','hq'] },
              dateLabel: { type: 'string', description: 'Human-readable date label, e.g. "Mon Apr 27"' },
            },
            required: ['eventId','context','dateLabel'],
          },
        },
      },
      required: ['name','assignments'],
    },
    summarize: (i) => {
      const list = (i.assignments || []).map(a => `${a.context} on ${a.dateLabel}`);
      const joined = list.length <= 1 ? list.join('') :
        list.length === 2 ? list.join(' and ') :
        list.slice(0, -1).join(', ') + ', and ' + list.slice(-1);
      return `Confirm ${i.name} for ${joined}?`;
    },
    async execute(input, role, authHeader) {
      const results = [];
      for (const a of (input.assignments || [])) {
        const map = CREW_FIELD_BY_CONTEXT[a.context];
        if (!map) { results.push(`skip ${a.context}: invalid context`); continue; }
        try {
          const rec = await fetchEventRecord(a.eventId);
          const confirmed = rec.fields[map.confirmed] || [];
          const tentative = rec.fields[map.tentative] || [];
          if (confirmed.includes(input.name)) { results.push(`${a.dateLabel}: already confirmed`); continue; }
          const fields = {};
          fields[map.keyConfirmed] = [...confirmed, input.name];
          fields[map.keyTentative] = tentative.filter(n => n !== input.name);
          await schedulerPatchCrew(a.eventId, fields, authHeader);
          results.push(`${a.dateLabel} ✓`);
        } catch (e) {
          results.push(`${a.dateLabel}: ${e.message}`);
        }
      }
      _snapshot = null;
      return { ok: true, message: `Done. ${results.join(', ')}.` };
    },
  },
  {
    name: 'remove_crew_member',
    description: 'Remove a crew member from tentative AND confirmed lists for an event + context. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        eventId:   { type: 'string' },
        context:   { type: 'string', enum: ['setup','strike','shop','hq'] },
        name:      { type: 'string' },
        dateLabel: { type: 'string', description: 'Human-readable date for the chip (e.g. "Monday Apr 27")' },
      },
      required: ['eventId','context','name','dateLabel'],
    },
    summarize: (i) => `Remove ${i.name} from ${i.context} on ${i.dateLabel}?`,
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
      // Delete the row if it's now an empty placeholder.
      const post = Object.assign({}, rec.fields);
      post[map.confirmed] = confirmed;
      post[map.tentative] = tentative;
      if (rowIsEmptyPlaceholder(post)) {
        try { await deleteScheduleRow(input.eventId); } catch (_) {}
      }
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
    name: 'add_day_off',
    description: 'Add a DAYS OFF record for a crew member. startDate/endDate are YYYY-MM-DD. For a single day, use the same value for both. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        crewName:  { type: 'string', description: 'Crew short name (e.g. "Dylan")' },
        startDate: { type: 'string', description: 'YYYY-MM-DD (resolve from the date ladder)' },
        endDate:   { type: 'string', description: 'YYYY-MM-DD (same as startDate for a single day)' },
        note:      { type: 'string', description: 'Optional reason/note' },
      },
      required: ['crewName','startDate','endDate'],
    },
    summarize: (i) => {
      const range = i.startDate === i.endDate ? i.startDate : `${i.startDate} to ${i.endDate}`;
      return `Mark ${i.crewName} off ${range}?`;
    },
    async execute(input, role, authHeader) {
      await schedulerAddDayOff(input.crewName, input.startDate, input.endDate, input.note, authHeader);
      _snapshot = null;
      const range = input.startDate === input.endDate ? input.startDate : `${input.startDate}–${input.endDate}`;
      return { ok: true, message: `Marked ${input.crewName} off ${range}.` };
    },
  },
  {
    name: 'delete_day_off',
    description: 'Delete a DAYS OFF record by its Airtable recordId (from the snapshot daysOff list). Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        recordId: { type: 'string', description: 'Airtable recordId of the days-off record to delete' },
      },
      required: ['recordId'],
    },
    summarize: (i) => `Delete this days-off record?`,
    async execute(input, role, authHeader) {
      await schedulerDeleteDayOff(input.recordId, authHeader);
      _snapshot = null;
      return { ok: true, message: `Days-off record deleted.` };
    },
  },
  {
    name: 'send_slack_to_crew_batch',
    description: 'Send the standard scheduling Slack DM (with Accept/Decline buttons + auto-reminder) to specific crew for MULTIPLE events. One DM per event. Used after a batch crew confirmation. Gated.',
    gated: true,
    input_schema: {
      type: 'object',
      properties: {
        eventIds:       { type: 'array', items: { type: 'string' }, minItems: 1 },
        recipientNames: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Crew short names, or ["All Crew"]' },
        dateLabels:     { type: 'array', items: { type: 'string' }, description: 'Optional human dates aligned with eventIds for the chip summary' },
      },
      required: ['eventIds','recipientNames'],
    },
    summarize: (i) => {
      const who   = (i.recipientNames || []).join(', ');
      const dates = (i.dateLabels || []).join(', ');
      return dates
        ? `DM ${who} about ${dates}?`
        : `DM ${who} about ${i.eventIds.length} events?`;
    },
    async execute(input, role, authHeader) {
      const lines = [];
      for (let i = 0; i < input.eventIds.length; i++) {
        const eid   = input.eventIds[i];
        const label = (input.dateLabels && input.dateLabels[i]) || eid;
        try {
          const r = await schedulerSlack(eid, input.recipientNames, authHeader);
          const sent = (r.sent || []).join(', ') || 'no one';
          lines.push(`${label}: ${sent}`);
        } catch (e) {
          lines.push(`${label}: error ${e.message}`);
        }
      }
      return { ok: true, message: `Sent. ${lines.join(' · ')}.` };
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
  // Read-only "public" tools are available to everyone (including unsigned-in).
  // Other tools are admin-only.
  const allowed = TOOLS.filter(t => t.public || role === 'admin');
  return allowed.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

async function runToolLoop(messages, role, authHeader, dateCtx) {
  // Loop: call Anthropic → execute any safe tool_use → feed results back → repeat.
  // Caps at 5 iterations as a safety valve.
  let workingMessages = messages.slice();
  for (let iter = 0; iter < 5; iter++) {
    const snapshot = await getSnapshot(false);
    const dayDigest = buildDayByDayDigest(snapshot, dateCtx);
    // Hide the raw crewSchedule from the JSON dump — the digest is authoritative.
    // Leaving it visible let Haiku pattern-match across dates. Out-of-window
    // schedule questions are rare; reroute via "I can only see the next 14 days".
    const snapshotForPrompt = Object.assign({}, snapshot);
    delete snapshotForPrompt.crewSchedule;
    const snapshotText =
      `Context: today=${dateCtx.today} (${dateCtx.weekday}), caller_timezone=${dateCtx.tz}, caller_role=${role || 'not signed in'}.\n`
      + 'Date ladder (use these — do not compute your own):\n'
      + dateCtx.ladder.map(l => '  ' + l).join('\n')
      + `\n\n=== DAY-BY-DAY SCHEDULE DIGEST (the ONLY in-prompt source for crew + events, covers 30 days back through 30 days forward) ===\n`
      + 'For any question about who is working or what is scheduled on a date IN THIS WINDOW, the answer must come from the matching line below — and ONLY that line. Days marked "NO ROWS" have nobody assigned and no events; for those days, the answer is literally "no one assigned" / "nothing scheduled". Do NOT copy crew names from a different day. Do NOT assume weeks repeat. Canceled / closed projects are already filtered out — they never appear in the digest.\n\n'
      + 'Each non-empty day begins with eventId=<recXXX> for each row on that date. When you call any crew or event tool, you MUST pass that exact eventId from the digest line whose date matches the user request. NEVER invent an eventId or reuse one from a different date.\n\n'
      + 'For dates OUTSIDE this window (more than 30 days past or future), call the lookup_schedule_by_date_range tool to fetch them on demand. Do not guess.\n\n'
      + dayDigest
      + '\n=== END DIGEST ===\n\n'
      + 'Other Airtable data (projects, supply, Amazon orders, crew roster, days off). This data does NOT contain crew assignments — for those, use the digest above or the lookup tool:\n'
      + JSON.stringify(snapshotForPrompt, null, 2);

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
  const singleCrewTools = new Set(['confirm_crew_member', 'set_tentative_crew', 'remove_crew_member']);
  if (singleCrewTools.has(name) && input.eventId && input.name) {
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
  // Batch crew confirm → batch Slack offer (one DM per event).
  if (name === 'confirm_crew_member_batch' && input.name && Array.isArray(input.assignments) && input.assignments.length) {
    const eventIds   = input.assignments.map(a => a.eventId);
    const dateLabels = input.assignments.map(a => a.dateLabel || a.eventId);
    return {
      text,
      pending: {
        toolUseId: 'followup-slack-batch-' + Date.now(),
        name: 'send_slack_to_crew_batch',
        input: { eventIds, dateLabels, recipientNames: [input.name] },
        summary: `Send ${input.name} a Slack DM for each: ${dateLabels.join(', ')}?`,
      },
    };
  }
  // Shop/HQ assignment (single date) → Slack offer using the row's eventId.
  if (name === 'assign_shop_or_hq' && input.name && result.eventId) {
    return {
      text,
      pending: {
        toolUseId: 'followup-slack-' + Date.now(),
        name: 'send_slack_to_crew',
        input: { eventId: result.eventId, recipientNames: [input.name] },
        summary: `Send ${input.name} a Slack notification about ${input.dateLabel}?`,
      },
    };
  }
  // Shop/HQ move → Slack offer for the NEW date (the new placeholder row).
  if (name === 'move_shop_or_hq' && input.name && result.eventId) {
    return {
      text,
      pending: {
        toolUseId: 'followup-slack-' + Date.now(),
        name: 'send_slack_to_crew',
        input: { eventId: result.eventId, recipientNames: [input.name] },
        summary: `Send ${input.name} a Slack notification of the move to ${input.toDateLabel}?`,
      },
    };
  }
  return { text };
}

module.exports = async function handler(req, res) {
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
    const cancelledName = (req.body.cancel && req.body.cancel.name) || '';
    let text = 'Cancelled.';
    // Slack offer is a non-critical follow-up to an already-completed action
    // (e.g. crew confirmation). Make it crystal clear the prior action stands.
    if (cancelledName === 'send_slack_to_crew') {
      text = 'No Slack sent. The change is still saved.';
    }
    return res.status(200).json({ text, role });
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
