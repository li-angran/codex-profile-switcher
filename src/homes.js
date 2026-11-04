'use strict';

// Profile homes and history sharing.
//   shared   - every entry of the main home (~/.codex) except the credentials is a symlink to the
//              main home: sessions, session index, state/thread SQLite databases, memories, config.
//              All shared profiles and the Default profile see the same conversations.
//   isolated - only settings (config.toml, AGENTS.md, rules, skills, plugins, prompts, .env) are
//              linked; history stays in the profile's own folder.
// The built-in Default profile is the main home itself.

const fs = require('fs');
const path = require('path');
const { lstat, log, realpathOr } = require('./util');

const ISOLATED_STASH = '.isolated-data';

// Entries every profile keeps for itself (never linked).
function isOwnEntry(name) {
  return name === 'auth.json' || name === 'models_cache.json' || name === ISOLATED_STASH ||
    /^auth\..*\.json$/.test(name);
}

// Entries linked to the main home in isolated mode too (settings, not history).
const SETTINGS_ENTRIES = new Set(['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'rules', 'skills',
  'plugins', 'prompts', '.env']);

// Never move these into the main home while a window may have them open.
function isUnsafeToAdopt(name) {
  return /\.(sqlite|db)(-wal|-shm|-journal)?$/.test(name) || /-(wal|shm|journal)$/.test(name) ||
    /\.lock$/.test(name);
}

function isSidecar(name) {
  return /-(wal|shm|journal)$/.test(name);
}

function wantedFn(profile) {
  const shared = profile.history === 'shared';
  return (name) => !isOwnEntry(name) && (shared || SETTINGS_ENTRIES.has(name));
}

// Make the profile's home match its history mode. `idle`: no window uses the profile, so its
// databases may be moved. Returns the names that could not be linked.
function syncHome(profile, main, idle) {
  fs.mkdirSync(profile.home, { recursive: true, mode: 0o700 });
  if (profile.builtin) return [];
  fs.mkdirSync(main, { recursive: true, mode: 0o700 });
  const wanted = wantedFn(profile);
  const problems = [];

  // Real entries that should be shared: move them into the main home if it lacks them.
  const moved = new Set();
  for (const name of fs.readdirSync(profile.home)) {
    if (!wanted(name) || moved.has(name)) continue;
    const local = path.join(profile.home, name);
    const st = lstat(local);
    if (!st || st.isSymbolicLink()) continue;
    const target = path.join(main, name);
    const isDb = /\.(sqlite|db)$/.test(name);
    if (lstat(target) || (isUnsafeToAdopt(name) && !(isDb && idle))) {
      if (!isSidecar(name) || !lstat(path.join(profile.home, name.replace(/-(wal|shm|journal)$/, '')))) {
        problems.push(name);
      }
      continue;
    }
    const group = isDb ? [name, `${name}-wal`, `${name}-shm`, `${name}-journal`] : [name];
    try {
      for (const n of group) {
        if (n !== name && (!lstat(path.join(profile.home, n)) || lstat(path.join(main, n)))) continue;
        fs.renameSync(path.join(profile.home, n), path.join(main, n));
        moved.add(n);
        log(`moved ${path.join(profile.home, n)} -> ${path.join(main, n)}`);
      }
    } catch (e) {
      problems.push(name);
      log(`could not move ${local}: ${e.message}`);
    }
  }

  // Link every wanted entry of the main home. SQLite follows the database symlink and keeps its
  // -wal/-shm next to the real file, so those are not linked.
  for (const name of fs.readdirSync(main)) {
    if (!wanted(name) || isSidecar(name)) continue;
    const local = path.join(profile.home, name);
    const target = path.join(main, name);
    const st = lstat(local);
    if (st) {
      if (!st.isSymbolicLink()) continue; // reported above
      if (fs.readlinkSync(local) === target) continue;
      fs.unlinkSync(local);
    }
    fs.symlinkSync(target, local);
  }

  // Isolated: drop links to history entries (left over from shared mode).
  if (profile.history !== 'shared') {
    for (const name of fs.readdirSync(profile.home)) {
      const local = path.join(profile.home, name);
      const st = lstat(local);
      if (st && st.isSymbolicLink() && !SETTINGS_ENTRIES.has(name)) fs.unlinkSync(local);
    }
  }
  if (problems.length) log(`profile ${profile.name}: not linked (exists in both homes or in use): ${problems.join(', ')}`);
  return problems;
}

// Read-only version of syncHome: entries of the main home that the profile should share but does not.
function checkHome(profile, main) {
  if (profile.builtin || !lstat(profile.home)) return [];
  const wanted = wantedFn(profile);
  const problems = [];
  let names = [];
  try {
    names = fs.readdirSync(main);
  } catch (_) {
    return [];
  }
  for (const name of names) {
    if (!wanted(name) || isSidecar(name)) continue;
    const st = lstat(path.join(profile.home, name));
    if (st && !st.isSymbolicLink()) problems.push(name);
  }
  return problems;
}

function setHistoryMode(profile, mode, main) {
  const stash = path.join(profile.home, ISOLATED_STASH);
  if (mode === 'shared') {
    // Keep the profile's own history aside so switching back restores it.
    for (const name of fs.readdirSync(profile.home)) {
      if (isOwnEntry(name) || SETTINGS_ENTRIES.has(name)) continue;
      const local = path.join(profile.home, name);
      const st = lstat(local);
      if (!st || st.isSymbolicLink()) continue;
      fs.mkdirSync(stash, { recursive: true, mode: 0o700 });
      fs.renameSync(local, path.join(stash, name));
    }
  } else {
    for (const name of fs.readdirSync(profile.home)) {
      const local = path.join(profile.home, name);
      const st = lstat(local);
      if (st && st.isSymbolicLink() && !SETTINGS_ENTRIES.has(name)) fs.unlinkSync(local);
    }
    if (lstat(stash)) {
      for (const name of fs.readdirSync(stash)) {
        const dest = path.join(profile.home, name);
        if (!lstat(dest)) fs.renameSync(path.join(stash, name), dest);
      }
      try {
        fs.rmdirSync(stash);
      } catch (_) { /* not empty: keep */ }
    }
  }
  profile.history = mode;
  syncHome(profile, main, true);
}

// History mode of an existing folder: shared when its sessions folder is the main home's.
function detectHistoryMode(home, main) {
  const st = lstat(path.join(home, 'sessions'));
  if (st && st.isSymbolicLink() && realpathOr(path.join(home, 'sessions')) === realpathOr(path.join(main, 'sessions'))) {
    return 'shared';
  }
  return 'isolated';
}

module.exports = { ISOLATED_STASH, SETTINGS_ENTRIES, isOwnEntry, syncHome, checkHome, setHistoryMode, detectHistoryMode };
