'use strict';

// Which VS Code windows (extension hosts) use which profile, and for which folders. One small file
// per extension host process; files of processes that are gone are removed when read.

const fs = require('fs');
const path = require('path');
const { WINDOWS } = require('./constants');
const { log } = require('./util');

function windowFile(pid = process.pid) {
  return path.join(WINDOWS, `${pid}.json`);
}

function registerWindow(profileId, folders) {
  try {
    fs.mkdirSync(WINDOWS, { recursive: true, mode: 0o700 });
    fs.writeFileSync(windowFile(), JSON.stringify({ pid: process.pid, profile: profileId, folders }), { mode: 0o600 });
  } catch (e) {
    log(`could not register window: ${e.message}`);
  }
}

function unregisterWindow() {
  try {
    fs.unlinkSync(windowFile());
  } catch (_) { /* gone */ }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function liveWindows() {
  const list = [];
  let names = [];
  try {
    names = fs.readdirSync(WINDOWS);
  } catch (_) {
    return list;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(WINDOWS, name);
    try {
      const w = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!pidAlive(w.pid)) {
        fs.unlinkSync(file);
        continue;
      }
      list.push({ pid: w.pid, profile: w.profile, folders: Array.isArray(w.folders) ? w.folders : [] });
    } catch (_) { /* being written */ }
  }
  return list;
}

function windowsUsing() {
  const counts = {};
  for (const w of liveWindows()) counts[w.profile] = (counts[w.profile] || 0) + 1;
  return counts;
}

module.exports = { registerWindow, unregisterWindow, liveWindows, windowsUsing };
