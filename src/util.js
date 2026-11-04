'use strict';

// Helpers without a dependency on the vscode module (so they can be tested with plain node).

const fs = require('fs');
const path = require('path');
const os = require('os');

let output = null;

function setOutput(channel) {
  output = channel;
}

function log(msg) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch (_) {
    return null;
  }
}

function stat(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

function tildify(p) {
  const home = os.homedir();
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return path.resolve(p);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function initials(name) {
  const words = String(name).trim().split(/[\s_\-.]+/).filter(Boolean);
  if (!words.length) return '?';
  const first = (w) => Array.from(w)[0].toUpperCase();
  return words.length === 1 ? first(words[0]) : first(words[0]) + first(words[1]);
}

function slug(name, max = 24) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// ------------------------------------------------------------------ time formatting

// The extension host may run on a remote machine in another time zone; times are shown in the
// time zone of the VS Code window, which the panel reports.
let timeZone;

function setTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined });
    timeZone = tz || undefined;
  } catch (_) {
    timeZone = undefined;
  }
}

function clockTime(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone })
    .replace(/\s?([AP]M)$/, (_, x) => ` ${x.toLowerCase()}`);
}

function dayKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone });
}

// "3:00 pm", "tomorrow 9:14 am", "Sat 9:14 am", "Nov 12 9:14 am"
function fmtWhen(ms, now = Date.now()) {
  const d = new Date(ms);
  const time = clockTime(d);
  const day = dayKey(ms);
  if (day === dayKey(now)) return time;
  if (day === dayKey(now + 86400e3)) return `tomorrow ${time}`;
  if (ms > now && ms - now < 6 * 86400e3) return `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone })} ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone })} ${time}`;
}

// "45 min", "2 h 5 min", "3 d 4 h"
function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return 'less than a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

function fmtAgo(ms, now = Date.now()) {
  const diff = now - ms;
  if (diff < 60000) return 'just now';
  return `${fmtDuration(diff)} ago`;
}

module.exports = {
  setOutput, log, lstat, stat, expandHome, tildify, realpathOr, readJson, writeJsonAtomic, shellQuote,
  initials, slug, isInside, setTimeZone, fmtWhen, fmtDuration, fmtAgo,
};
