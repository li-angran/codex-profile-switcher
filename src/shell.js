'use strict';

// "Install Shell Launchers…": one command per profile in the shell startup file, e.g. `codex-work`
// runs Codex with the Work profile's CODEX_HOME. The block is replaced on every run and the file is
// backed up first.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { shellQuote, slug, tildify, log } = require('./util');

const BEGIN = '# >>> codex-profile-switcher >>>';
const END = '# <<< codex-profile-switcher <<<';

function shells() {
  const home = os.homedir();
  return {
    zsh: { label: 'zsh', file: path.join(process.env.ZDOTDIR || home, '.zshrc') },
    bash: { label: 'bash', file: path.join(home, '.bashrc') },
    sh: { label: 'sh', file: path.join(home, '.profile') },
    fish: { label: 'fish', file: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'conf.d', 'codex-profile-switcher.fish'), own: true },
  };
}

function onPath(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch (_) { /* next */ }
  }
  return false;
}

function commandNames(profiles) {
  const used = new Set();
  return profiles.map((p) => {
    const base = `codex-${slug(p.name, 20) || (p.builtin ? 'default' : 'profile')}`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    return { profile: p, name };
  });
}

function block(kind, entries, bin) {
  const lines = [BEGIN, '# Added by the Codex Profile Switcher extension. Run "Install Shell Launchers…" again to update.'];
  for (const { profile, name } of entries) {
    if (kind === 'fish') {
      lines.push(`function ${name} --description ${shellQuote(`Codex with the ${profile.name} profile`)}`);
      lines.push(`    env CODEX_HOME=${shellQuote(profile.home)} ${shellQuote(bin)} $argv`);
      lines.push('end');
    } else if (kind === 'sh') {
      // POSIX sh does not allow "-" in function names; it does in alias names.
      lines.push(`alias ${name}=${shellQuote(`CODEX_HOME=${shellQuote(profile.home)} ${shellQuote(bin)}`)}`);
    } else {
      lines.push(`${name}() { CODEX_HOME=${shellQuote(profile.home)} ${shellQuote(bin)} "$@"; }`);
    }
  }
  lines.push(END);
  return lines.join('\n') + '\n';
}

async function installShellAliases(profiles, codexBinary) {
  const all = shells();
  const current = path.basename(process.env.SHELL || 'bash');
  const order = [current, ...Object.keys(all).filter((k) => k !== current)].filter((k) => all[k]);
  const pick = await vscode.window.showQuickPick(order.map((k) => ({
    label: all[k].label,
    description: k === current ? 'your login shell' : '',
    detail: tildify(all[k].file),
    kind: k,
  })), { placeHolder: 'Add a Codex command per profile to which shell?' });
  if (!pick) return;
  const target = all[pick.kind];
  const entries = commandNames(profiles);
  const bin = onPath('codex') ? 'codex' : codexBinary();
  const ok = await vscode.window.showInformationMessage(
    `Add these commands to ${tildify(target.file)}?`,
    {
      modal: true,
      detail: entries.map((e) => `${e.name}  →  ${e.profile.name} (${tildify(e.profile.home)})`).join('\n') +
        (target.own ? '' : '\n\nA backup of the file is saved next to it first.'),
    },
    'Add Commands');
  if (ok !== 'Add Commands') return;

  let text = '';
  try {
    text = fs.readFileSync(target.file, 'utf8');
  } catch (_) { /* new file */ }
  if (text && !target.own) {
    const backup = `${target.file}.codex-profiles-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    fs.copyFileSync(target.file, backup);
    log(`backed up ${target.file} to ${backup}`);
  }
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  const fresh = block(pick.kind, entries, bin);
  if (start >= 0 && end > start) {
    text = text.slice(0, start) + fresh + text.slice(end + END.length).replace(/^\n/, '');
  } else {
    text = (text && !text.endsWith('\n') ? `${text}\n` : text) + (text ? '\n' : '') + fresh;
  }
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, text);
  vscode.window.showInformationMessage(
    `Added ${entries.map((e) => e.name).join(', ')} to ${tildify(target.file)}. Open a new terminal to use them.`);
}

module.exports = { installShellAliases };
