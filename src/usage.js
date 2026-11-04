'use strict';

// Usage limits from what Codex already saves locally. Every turn, Codex appends a `token_count`
// event to the conversation's rollout file (sessions/YYYY/MM/DD/rollout-*.jsonl) with the
// account's current `rate_limits` (used percent, window length, reset time per window). Nothing
// here contacts OpenAI or reads tokens.
//
// Which account a snapshot belongs to:
//   1. A window that sees a rollout file of its own folder grow attributes the new snapshot to the
//      account the window uses, and records it in ~/.codex-profile-switcher/usage.json (shared by
//      all windows). That also marks the conversation as last written by that account.
//   2. Otherwise a snapshot belongs to the account that created the conversation (session_meta
//      creator_account_id), unless a window saw another account write to it, or the plan in the
//      snapshot differs from the account's plan.

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, realpathOr, isInside, fmtWhen, fmtDuration, fmtAgo } = require('./util');

const DAY = 86400e3;
const RECENT_MS = 8 * DAY; // the longest window is 7 days
const STALE_MS = 30 * 60e3; // older numbers are shown as a minimum ("≥48%")
const CHUNK = 1 << 20;
const MAX_TAIL = 64 * CHUNK;

function idFromFilename(file) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file);
  return m ? m[1] : path.basename(file, '.jsonl');
}

function readFirstLine(file, limit = 8 * CHUNK) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const parts = [];
    let pos = 0;
    while (pos < limit) {
      const buf = Buffer.alloc(Math.min(256 * 1024, limit - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl >= 0) {
        parts.push(buf.subarray(0, nl));
        return Buffer.concat(parts).toString('utf8');
      }
      parts.push(buf.subarray(0, n));
      pos += n;
    }
    return parts.length ? Buffer.concat(parts).toString('utf8') : null;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readMeta(file) {
  const meta = { id: idFromFilename(file), cwd: null, accountId: null, userId: null, startedAt: null };
  const line = readFirstLine(file);
  if (!line) return meta;
  try {
    const d = JSON.parse(line);
    if (d.type === 'session_meta' && d.payload) {
      const p = d.payload;
      meta.id = p.id || p.session_id || meta.id;
      meta.cwd = p.cwd || null;
      meta.accountId = p.creator_account_id || null;
      meta.userId = p.creator_user_id || null;
      meta.startedAt = Date.parse(p.timestamp || d.timestamp) || null;
    }
  } catch (_) { /* not JSON: keep the id from the file name */ }
  return meta;
}

function parseSnapshot(line) {
  try {
    const d = JSON.parse(line);
    const p = d.payload;
    if (!p || p.type !== 'token_count' || !p.rate_limits) return null;
    const rl = p.rate_limits;
    if (!rl.primary && !rl.secondary) return null;
    return { at: Date.parse(d.timestamp) || 0, rl };
  } catch (_) {
    return null;
  }
}

// Latest snapshot among the complete lines of file[from, to). Returns { snap, end } where end is
// the offset just past the last complete line, so a half-written line is read again next time.
function scanRegion(file, from, to) {
  if (to <= from) return { snap: null, end: from };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let pos = to;
    let carry = Buffer.alloc(0); // bytes after the first newline of the chunk read before
    let end = null;
    let readTotal = 0;
    while (pos > from && readTotal < MAX_TAIL) {
      const start = Math.max(from, pos - CHUNK);
      const buf = Buffer.alloc(pos - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      readTotal += buf.length;
      let data = Buffer.concat([buf, carry]);
      if (end === null) {
        const lastNl = data.lastIndexOf(10);
        if (lastNl < 0 && start > from) {
          carry = data;
          pos = start;
          continue;
        }
        end = lastNl < 0 ? from : start + lastNl + 1;
        data = data.subarray(0, lastNl + 1);
      }
      // Lines of this chunk; the first one may be incomplete unless the chunk starts at `from`.
      let firstNl = start > from ? data.indexOf(10) : -1;
      if (start > from && firstNl < 0) {
        carry = data;
        pos = start;
        continue;
      }
      const body = data.subarray(firstNl + 1).toString('utf8');
      const lines = body.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (l.length > 40 && l.includes('"rate_limits":{') && l.includes('"token_count"')) {
          const snap = parseSnapshot(l);
          if (snap) return { snap, end };
        }
      }
      carry = start > from ? data.subarray(0, firstNl + 1) : Buffer.alloc(0);
      pos = start;
    }
    return { snap: null, end: end === null ? from : end };
  } catch (_) {
    return { snap: null, end: from };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function listRollouts(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listRollouts(p, out);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
  }
}

class SessionScanner {
  constructor() {
    this.files = new Map(); // real path -> record
    this.primed = false;
  }

  // Scans the given sessions folders. Returns the records that grew since the previous scan (never
  // on the first scan), each with the snapshot found in the part that was added.
  scan(sessionDirs, now = Date.now()) {
    const roots = [...new Set(sessionDirs.map((d) => realpathOr(d)))];
    const seen = new Set();
    const grown = [];
    for (const root of roots) {
      const files = [];
      listRollouts(root, files);
      for (const file of files) {
        let st;
        try {
          st = fs.statSync(file);
        } catch (_) {
          continue;
        }
        seen.add(file);
        let rec = this.files.get(file);
        const isNew = !rec;
        if (isNew) {
          rec = { path: file, root, size: -1, mtimeMs: 0, scannedTo: 0, meta: null, snap: null };
          this.files.set(file, rec);
        }
        if (rec.size === st.size && rec.mtimeMs === st.mtimeMs) continue;
        if (!rec.meta || !rec.meta.cwd) rec.meta = readMeta(file);
        let added = null;
        if (now - st.mtimeMs < RECENT_MS) {
          const from = st.size >= rec.scannedTo ? rec.scannedTo : 0;
          const { snap, end } = scanRegion(file, from, st.size);
          if (snap && (!rec.snap || snap.at >= rec.snap.at)) rec.snap = { ...snap, sessionId: rec.meta.id };
          added = snap ? { ...snap, sessionId: rec.meta.id } : null;
          rec.scannedTo = end;
        } else {
          rec.scannedTo = st.size;
        }
        const grew = this.primed && (isNew || st.size > rec.size);
        rec.size = st.size;
        rec.mtimeMs = st.mtimeMs;
        if (grew) grown.push({ rec, snap: added });
      }
    }
    for (const key of this.files.keys()) if (!seen.has(key)) this.files.delete(key);
    this.primed = true;
    return grown;
  }

  // Conversations whose working folder is inside one of `folders`, newest first.
  conversationsIn(folders) {
    const list = [];
    for (const rec of this.files.values()) {
      const cwd = rec.meta && rec.meta.cwd;
      if (cwd && folders.some((f) => isInside(cwd, f))) list.push(rec);
    }
    return list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  count(root) {
    let n = 0;
    for (const rec of this.files.values()) if (!root || rec.root === root) n++;
    return n;
  }
}

// ------------------------------------------------------------------ shared store of observations

class UsageStore {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, accounts: {}, writers: {} };
    this.key = null;
  }

  load() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch (_) {
      return this.data;
    }
    const key = `${st.size}:${st.mtimeMs}`;
    if (key === this.key) return this.data;
    const d = readJson(this.file, null);
    if (d && typeof d === 'object') {
      this.data = { version: 1, accounts: d.accounts || {}, writers: d.writers || {} };
      this.key = key;
    }
    return this.data;
  }

  record(accountId, snap, now = Date.now()) {
    this.key = null;
    const d = { ...this.load() };
    d.accounts = { ...d.accounts };
    d.writers = { ...d.writers };
    const prev = d.accounts[accountId];
    if (!prev || snap.at >= prev.at) d.accounts[accountId] = snap;
    if (snap.sessionId) d.writers[snap.sessionId] = { accountId, at: snap.at };
    for (const [id, w] of Object.entries(d.writers)) if (now - w.at > RECENT_MS) delete d.writers[id];
    for (const [id, s] of Object.entries(d.accounts)) if (now - s.at > 4 * RECENT_MS) delete d.accounts[id];
    writeJsonAtomic(this.file, d);
    this.data = d;
  }
}

function planMatches(info, snap) {
  return !info.plan || !snap.rl.plan_type || snap.rl.plan_type === info.plan;
}

// Newest snapshot for the account described by `info` (from accounts.accountInfo).
function snapshotFor(info, scanner, store) {
  if (!info || !info.signedIn || info.mode !== 'chatgpt' || !info.accountId) return null;
  const data = store.load();
  let best = null;
  const consider = (s) => {
    if (s && planMatches(info, s) && (!best || s.at > best.at)) best = s;
  };
  consider(data.accounts[info.accountId]);
  for (const rec of scanner.files.values()) {
    if (!rec.snap || !rec.meta || rec.meta.accountId !== info.accountId) continue;
    const w = data.writers[rec.meta.id];
    if (w && w.accountId !== info.accountId) continue;
    consider(rec.snap);
  }
  return best;
}

// ------------------------------------------------------------------ presentation

function windowLabel(minutes) {
  if (!minutes) return '?';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function hasCredits(rl) {
  const c = rl.credits;
  return !!(c && (c.unlimited || (c.has_credits && Number(c.balance) > 0)));
}

// Display model of a snapshot: one meter per window (shortest first), the limit state, and the
// pace projection.
function describe(snap, now = Date.now()) {
  if (!snap) return null;
  const stale = now - snap.at > STALE_MS;
  const raw = [snap.rl.primary, snap.rl.secondary].filter((w) => w && typeof w.used_percent === 'number');
  raw.sort((a, b) => (a.window_minutes || 0) - (b.window_minutes || 0));
  const meters = raw.map((w) => {
    const label = windowLabel(w.window_minutes);
    const windowMs = (w.window_minutes || 0) * 60e3;
    const resetsAt = w.resets_at ? w.resets_at * 1000 : null;
    const reset = resetsAt !== null && now >= resetsAt;
    const pct = reset ? 0 : Math.max(0, Math.min(100, w.used_percent));
    let elapsed = null;
    if (!reset && resetsAt && windowMs) elapsed = Math.max(0, Math.min(1, 1 - (resetsAt - now) / windowMs));
    const ahead = elapsed !== null && pct >= 5 && pct > elapsed * 100 + 2;
    let hitAt = null;
    if (ahead && pct < 100 && elapsed > 0) {
      const rate = pct / (elapsed * windowMs); // percent per ms so far
      const at = now + (100 - pct) / rate;
      if (at < resetsAt) hitAt = at;
    }
    const minimum = stale && !reset;
    return {
      label, pct, elapsed, ahead, hitAt, resetsAt: reset ? null : resetsAt, reset, minimum,
      text: `${minimum && pct < 100 ? '≥' : ''}${Math.round(pct)}%`,
      windowMinutes: w.window_minutes || 0,
    };
  });
  const full = meters.filter((m) => m.pct >= 100);
  const reached = !!snap.rl.rate_limit_reached_type && meters.some((m) => !m.reset);
  const limited = (full.length > 0 || reached) && !hasCredits(snap.rl);
  let resetAt = null;
  if (limited) {
    const blocking = full.length ? full : meters.filter((m) => !m.reset);
    // Usable again when every full window has reset.
    resetAt = Math.max(...blocking.map((m) => m.resetsAt || 0)) || null;
  }
  const pace = meters.find((m) => m.hitAt);
  return {
    at: snap.at,
    stale,
    plan: snap.rl.plan_type || null,
    meters,
    limited,
    resetAt,
    resetText: resetAt ? fmtWhen(resetAt, now) : null,
    paceText: !limited && pace ? `On course to reach the ${pace.label} limit ~${fmtWhen(pace.hitAt, now)}` : null,
    credits: hasCredits(snap.rl),
    sessionId: snap.sessionId || null,
  };
}

function meterTitle(m, now = Date.now()) {
  const parts = [`${m.label}: ${m.text} used`];
  if (m.reset) parts.push('window has reset');
  else if (m.resetsAt) parts.push(`resets ${fmtWhen(m.resetsAt, now)} (in ${fmtDuration(m.resetsAt - now)})`);
  if (m.elapsed !== null) parts.push(`${Math.round(m.elapsed * 100)}% of the window has passed`);
  if (m.hitAt) parts.push(`limit ~${fmtWhen(m.hitAt, now)} at this rate`);
  return parts.join(' · ');
}

function detailLines(u, name, now = Date.now()) {
  if (!u) return [`No usage recorded for ${name} yet. Codex saves it while you use this account.`];
  const lines = u.meters.map((m) => meterTitle(m, now));
  if (u.limited) lines.push(`Limited until ${u.resetText}.`);
  if (u.paceText) lines.push(`${u.paceText}.`);
  if (u.credits) lines.push('Credits are available, so reaching a limit does not stop this account.');
  lines.push(`Recorded ${fmtAgo(u.at, now)}${u.stale ? `; Codex records new figures when ${name} is used` : ''}.`);
  return lines;
}

module.exports = {
  SessionScanner, UsageStore, snapshotFor, describe, meterTitle, detailLines, readMeta, scanRegion, windowLabel,
};
