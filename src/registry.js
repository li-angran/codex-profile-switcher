'use strict';

// The profile list, stored in ~/.codex-profile-switcher/profiles.json so that every window (and
// every VS Code instance on this machine) sees the same profiles.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ROOT, REGISTRY, HOMES, DEFAULT_ID, COLORS } = require('./constants');
const { expandHome, lstat, realpathOr, readJson, writeJsonAtomic, slug } = require('./util');
const { accountInfo } = require('./accounts');
const { detectHistoryMode } = require('./homes');

function config() {
  return vscode.workspace.getConfiguration('codexProfileSwitcher');
}

function mainHome() {
  const configured = config().get('mainCodexHome');
  if (configured) return expandHome(configured);
  const env = process.env.CODEX_HOME_BEFORE_PROFILE_SWITCHER || process.env.CODEX_HOME;
  if (env && !path.resolve(env).startsWith(ROOT + path.sep)) return path.resolve(env);
  return path.join(os.homedir(), '.codex');
}

function loadRegistry() {
  let reg = readJson(REGISTRY, null);
  if (!reg || typeof reg !== 'object' || !Array.isArray(reg.profiles)) {
    reg = { version: 2, newWindowProfile: DEFAULT_ID, defaultName: 'Default', profiles: [] };
  }
  reg.profiles = reg.profiles.filter((p) => p && p.id && p.id !== DEFAULT_ID && p.home && !p.removed);
  if (!reg.defaultName) reg.defaultName = 'Default';
  if (!reg.defaultColor) reg.defaultColor = 'blue';
  if (!reg.forgotten || typeof reg.forgotten !== 'object') reg.forgotten = {};
  if (!Array.isArray(reg.hidden)) reg.hidden = [];
  return reg;
}

function saveRegistry(reg) {
  reg.version = 2;
  writeJsonAtomic(REGISTRY, reg);
}

function defaultProfile(reg) {
  return { id: DEFAULT_ID, name: reg.defaultName, home: mainHome(), history: 'main', builtin: true, color: reg.defaultColor };
}

function listProfiles(reg) {
  return [defaultProfile(reg), ...reg.profiles];
}

function findProfile(reg, id) {
  return listProfiles(reg).find((p) => p.id === id) || null;
}

function newWindowProfile(reg) {
  return findProfile(reg, reg.newWindowProfile) || defaultProfile(reg);
}

function makeId(name) {
  return `${slug(name) || 'profile'}-${Math.random().toString(16).slice(2, 6)}`;
}

function nextColor(reg) {
  const used = listProfiles(reg).map((p) => p.color);
  return COLORS.find((c) => !used.includes(c)) || COLORS[reg.profiles.length % COLORS.length];
}

function updateProfile(id, fn) {
  const reg = loadRegistry();
  if (id === DEFAULT_ID) {
    const d = defaultProfile(reg);
    fn(d);
    reg.defaultName = d.name;
    reg.defaultColor = d.color;
  } else {
    const p = reg.profiles.find((x) => x.id === id);
    if (!p) throw new Error('Profile not found.');
    fn(p);
  }
  saveRegistry(reg);
  return reg;
}

// One-time upgrades of a registry written by 0.1.0: profiles removed there stay on disk and show
// up under "Found on this computer"; every profile gets a color.
function migrateRegistry() {
  const raw = readJson(REGISTRY, null);
  if (!raw || !Array.isArray(raw.profiles)) return;
  const reg = loadRegistry();
  let changed = raw.version !== 2;
  for (const p of raw.profiles) {
    if (p && p.removed && p.home) reg.forgotten[p.home] = { name: p.name, history: p.history };
  }
  for (const p of reg.profiles) {
    if (!p.color) {
      p.color = nextColor(reg);
      changed = true;
    }
  }
  if (changed) saveRegistry(reg);
}

// Codex homes on this computer that are not in the list: profile folders removed from the list,
// and ~/.codex-* folders with a login.
function discover(reg) {
  const main = mainHome();
  const known = new Set([...listProfiles(reg).map((p) => realpathOr(p.home)), realpathOr(main)]);
  const hidden = new Set(reg.hidden.map((h) => realpathOr(h)));
  const found = [];
  const add = (dir) => {
    const real = realpathOr(dir);
    if (known.has(real) || hidden.has(real) || found.some((f) => f.real === real)) return;
    const remembered = reg.forgotten[dir] || {};
    const base = path.basename(dir).replace(/^\.?codex[-_.]?/i, '') || path.basename(dir);
    found.push({
      path: dir,
      real,
      name: remembered.name || base.replace(/-[0-9a-f]{4}$/, ''),
      color: remembered.color || null,
      info: accountInfo(dir),
      history: detectHistoryMode(dir, main),
      ours: path.dirname(dir) === HOMES,
    });
  };
  try {
    for (const name of fs.readdirSync(HOMES)) {
      const dir = path.join(HOMES, name);
      const st = lstat(dir);
      if (st && st.isDirectory()) add(dir);
    }
  } catch (_) { /* no homes yet */ }
  try {
    for (const name of fs.readdirSync(os.homedir())) {
      if (!/^\.codex[-_.]/i.test(name)) continue;
      const dir = path.join(os.homedir(), name);
      if (dir === ROOT) continue;
      const st = lstat(dir);
      if (st && st.isDirectory() && lstat(path.join(dir, 'auth.json'))) add(dir);
    }
  } catch (_) { /* unreadable home */ }
  return found;
}

module.exports = {
  config, mainHome, loadRegistry, saveRegistry, defaultProfile, listProfiles, findProfile, newWindowProfile,
  makeId, nextColor, updateProfile, migrateRegistry, discover,
};
