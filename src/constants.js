'use strict';

const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.codex-profile-switcher');

module.exports = {
  ROOT,
  REGISTRY: path.join(ROOT, 'profiles.json'),
  HOMES: path.join(ROOT, 'homes'),
  WINDOWS: path.join(ROOT, 'windows'),
  USAGE: path.join(ROOT, 'usage.json'),
  DEFAULT_ID: 'default',
  // Order in which new profiles get a color. Each one is a theme color "codexProfiles.<name>".
  COLORS: ['blue', 'green', 'orange', 'purple', 'red', 'yellow', 'teal', 'pink'],
};
