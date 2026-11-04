'use strict';

// Codex Profile Switcher.
//
// Every VS Code window has its own extension host. The official Codex extension (openai.chatgpt)
// runs in it and starts `codex app-server` with that process's environment, reading CODEX_HOME
// when it spawns. This extension activates first ("*") and sets process.env.CODEX_HOME to the home
// of the profile chosen for the window, so Codex in that window uses that profile's auth.json.
// A switch therefore takes effect after an extension-host restart.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, HOMES, USAGE, DEFAULT_ID, COLORS } = require('./constants');
const util = require('./util');
const { log, lstat, tildify, shellQuote, initials, realpathOr, isInside, fmtWhen, readJson, writeJsonAtomic } = util;
const { accountInfo, accountInfoFromAuth, accountLabel, planLabel } = require('./accounts');
const homes = require('./homes');
const registry = require('./registry');
const windows = require('./windows');
const usage = require('./usage');
const { installShellAliases } = require('./shell');
const { ProfilesViewProvider, VIEW_ID } = require('./view');

const WS_KEY = 'codexProfileSwitcher.windowProfile';
const HANDOFF_KEY = 'codexProfileSwitcher.handoff';
const LIMIT_NOTIFIED_KEY = 'codexProfileSwitcher.limitNotified';
const WARNED_KEY = 'codexProfileSwitcher.warnedConflicts';
const TZ_KEY = 'codexProfileSwitcher.timeZone';
const REMINDER_FILE = path.join(ROOT, 'reminder.json');
const CONFLICTING_EXTENSIONS = ['goosenest.codex-profiles', 'tahaluh.tahaluh-codex-account-switcher',
  'dondakeltd.vscode-codex-switcher'];

const S = {
  context: null,
  output: null,
  applied: null, // the profile whose CODEX_HOME this extension host uses
  view: null,
  status: null,
  scanner: new usage.SessionScanner(),
  store: new usage.UsageStore(USAGE),
  activatedAt: Date.now(),
  startedEarly: false,
  lastState: null,
};

const cfg = () => registry.config();

function windowFolders() {
  return (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
}

function chosenProfile(reg) {
  const id = S.context.workspaceState.get(WS_KEY);
  return (id && registry.findProfile(reg, id)) || registry.newWindowProfile(reg);
}

function syncProfile(profile) {
  const idle = !(windows.windowsUsing()[profile.id] > 0);
  return homes.syncHome(profile, registry.mainHome(), idle);
}

function codexBinary() {
  const configured = cfg().get('codexPath');
  if (configured) return util.expandHome(configured);
  const ext = vscode.extensions.getExtension('openai.chatgpt');
  if (ext) {
    const binRoot = path.join(ext.extensionPath, 'bin');
    try {
      for (const sub of fs.readdirSync(binRoot)) {
        const exe = path.join(binRoot, sub, process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (lstat(exe)) return exe;
      }
    } catch (_) { /* fall through */ }
  }
  return 'codex';
}

function profileTerminal(profile, name) {
  const term = vscode.window.createTerminal({
    name,
    env: { CODEX_HOME: profile.home },
    color: new vscode.ThemeColor(`codexProfiles.${profile.color || 'blue'}`),
    iconPath: new vscode.ThemeIcon('account'),
  });
  // This extension's environment collection also sets CODEX_HOME (to the window's profile), and
  // it is applied after `env`; set the variable explicitly in the shell too.
  term.sendText(`export CODEX_HOME=${shellQuote(profile.home)}`, true);
  term.show();
  return term;
}

// ------------------------------------------------------------------ usage

function sessionDirs(reg) {
  return [...new Set(registry.listProfiles(reg).map((p) => path.join(p.home, 'sessions')))];
}

// Attribute snapshots that appeared in this window's folders to the account this window uses,
// unless another window with a different account has the same folder open.
function observe(grown, reg) {
  if (!grown.length || !S.applied) return;
  const info = accountInfo(S.applied.home);
  const folders = windowFolders();
  if (!info.signedIn || info.mode !== 'chatgpt' || !info.accountId || !folders.length) return;
  const others = windows.liveWindows().filter((w) => w.pid !== process.pid);
  for (const { rec, snap } of grown) {
    if (!snap || !rec.meta || !rec.meta.cwd || !folders.some((f) => isInside(rec.meta.cwd, f))) continue;
    const ambiguous = others.some((w) => {
      if (!w.folders.some((f) => isInside(rec.meta.cwd, f))) return false;
      const p = registry.findProfile(reg, w.profile);
      return !p || accountInfo(p.home).accountId !== info.accountId;
    });
    if (ambiguous) continue;
    if (info.plan && snap.rl.plan_type && snap.rl.plan_type !== info.plan) continue;
    try {
      S.store.record(info.accountId, snap);
    } catch (e) {
      log(`could not record usage: ${e.message}`);
    }
  }
}

function usageOf(profile, now) {
  return usage.describe(usage.snapshotFor(accountInfo(profile.home), S.scanner, S.store), now);
}

// The signed-in account with the most room left, other than `excludeId`.
function bestAlternative(profiles, excludeId) {
  const candidates = profiles.filter((p) => p.id !== excludeId && p.signedIn && !p.missing && !p.limited);
  const score = (p) => {
    if (p.apiKey) return 1000;
    if (!p.rawMeters || !p.rawMeters.length) return 500;
    return Math.max(...p.rawMeters.map((m) => m.pct));
  };
  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0] || null;
}

// ------------------------------------------------------------------ conflicts

function computeConflicts() {
  const list = [];
  if (S.startedEarly) {
    list.push({ kind: 'early', text: 'Codex started before Codex Profiles could set its account for this window.' });
  }
  const cli = vscode.workspace.getConfiguration('chatgpt').get('cliExecutable');
  if (cli) {
    list.push({ kind: 'setting', text: `"chatgpt.cliExecutable" is set (${cli}). A launcher there may override CODEX_HOME.` });
  }
  for (const id of CONFLICTING_EXTENSIONS) {
    const ext = vscode.extensions.getExtension(id);
    if (ext) {
      const name = (ext.packageJSON && ext.packageJSON.displayName) || id;
      list.push({ kind: 'extension', id, text: `${name} also changes the Codex account.` });
    }
  }
  return list;
}

// ------------------------------------------------------------------ panel state

function buildState() {
  const reg = registry.loadRegistry();
  const now = Date.now();
  const main = registry.mainHome();
  const chosen = chosenProfile(reg);
  const forNew = registry.newWindowProfile(reg);
  const using = windows.windowsUsing();
  const showUsage = cfg().get('showUsage') !== false;

  const profiles = registry.listProfiles(reg).map((p) => {
    const info = accountInfo(p.home);
    const u = usageOf(p, now);
    return {
      id: p.id,
      name: p.name,
      initials: initials(p.name),
      color: COLORS.includes(p.color) ? p.color : 'blue',
      builtin: !!p.builtin,
      home: tildify(p.home),
      history: p.history,
      missing: !lstat(p.home),
      signedIn: !!info.signedIn,
      apiKey: info.mode === 'apikey',
      email: info.email || null,
      plan: planLabel(info.plan || (u && u.plan)),
      applied: !!S.applied && S.applied.id === p.id,
      chosen: chosen.id === p.id,
      newWindow: forNew.id === p.id,
      windows: using[p.id] || 0,
      limited: !!(u && u.limited),
      resetAt: u ? u.resetAt : null,
      resetText: u ? u.resetText : null,
      usageAt: u ? u.at : null,
      rawMeters: u ? u.meters : null,
      usage: u && showUsage ? {
        meters: u.meters.map((m) => ({
          label: m.label,
          pct: m.pct,
          text: m.text,
          tick: m.elapsed,
          ahead: m.ahead,
          level: m.pct >= 100 ? 'full' : m.pct >= 80 ? 'high' : 'ok',
          title: usage.meterTitle(m, now),
        })),
        pace: u.paceText,
        note: u.stale ? `Figures from ${util.fmtAgo(u.at, now)}` : null,
      } : null,
    };
  });

  const me = profiles.find((p) => p.applied) || null;
  const reminder = readJson(REMINDER_FILE, null);
  let banner = null;
  if (me && me.limited) {
    const best = bestAlternative(profiles, me.id);
    banner = {
      kind: 'limit',
      name: me.name,
      resetText: me.resetText,
      best: best ? { id: best.id, name: best.name } : null,
      canChoose: profiles.some((p) => p.id !== me.id && p.signedIn),
      reminder: reminder && reminder.at > now ? fmtWhen(reminder.at, now) : null,
      hasFolder: windowFolders().length > 0,
    };
  }

  const mainSessions = realpathOr(path.join(main, 'sessions'));
  const folders = windowFolders();
  const members = profiles.filter((p) => p.builtin || p.history === 'shared');
  let problems = 0;
  for (const p of reg.profiles) if (p.history === 'shared') problems += homes.checkHome(p, main).length;
  const shared = {
    home: tildify(main),
    members: members.map((p) => ({ name: p.name, initials: p.initials, color: p.color })),
    own: profiles.filter((p) => !p.builtin && p.history !== 'shared').map((p) => ({ id: p.id, name: p.name })),
    folderName: folders.length === 1 ? path.basename(folders[0]) : folders.length ? 'this workspace' : null,
    here: folders.length ? S.scanner.conversationsIn(folders).filter((r) => r.root === mainSessions).length : null,
    total: S.scanner.count(mainSessions),
    problems,
  };

  const found = registry.discover(reg).map((f) => ({
    path: f.path,
    display: tildify(f.path),
    name: f.name,
    initials: initials(f.name),
    label: accountLabel(f.info),
    signedIn: !!f.info.signedIn,
    ours: f.ours,
  }));

  for (const p of profiles) delete p.rawMeters;
  return {
    profiles,
    banner,
    conflicts: computeConflicts(),
    found,
    shared,
    restartMode: cfg().get('restartAfterSwitch') || 'ask',
    pendingRestart: !!me && !profiles.find((p) => p.chosen).applied,
    _me: me && { ...me, best: banner && banner.best },
  };
}

function updateStatus(state) {
  const item = S.status;
  if (!item) return;
  const me = state.profiles.find((p) => p.applied) || state.profiles.find((p) => p.chosen);
  const chosen = state.profiles.find((p) => p.chosen);
  const pending = chosen && me && chosen.id !== me.id;
  const mode = cfg().get('usageInStatusBar') || 'auto';
  const meters = (me.usage && me.usage.meters) || [];
  let suffix = '';
  if (me.limited) {
    suffix = ` · Limited${me.resetText ? ` until ${me.resetText}` : ''}`;
  } else if (mode !== 'off' && meters.length) {
    const urgent = meters.filter((m) => m.pct >= 80 || m.ahead).sort((a, b) => b.pct - a.pct)[0];
    const pick = mode === 'always' ? (urgent || meters[0]) : urgent;
    if (pick) suffix = ` · ${pick.label} ${pick.text}`;
  }
  const attention = pending || !me.signedIn || me.limited || state.conflicts.length > 0;
  item.text = pending ? `$(sync) Codex: ${chosen.name} (restart)` : `$(account) Codex: ${me.name}${suffix}`;
  item.backgroundColor = attention ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  item.color = !attention && cfg().get('colorStatusBar') !== false ? new vscode.ThemeColor(`codexProfiles.${me.color}`) : undefined;

  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Codex: ${escapeMd(me.name)}**${me.newWindow ? ' $(star-full)' : ''}\n\n`);
  md.appendMarkdown(`${escapeMd(me.signedIn ? accountLine(me) : 'Not signed in')}\n\n`);
  if (me.limited) md.appendMarkdown(`$(warning) Limited${me.resetText ? ` until ${escapeMd(me.resetText)}` : ''}\n\n`);
  for (const m of meters) md.appendMarkdown(`${escapeMd(m.title)}\n\n`);
  if (me.usage && me.usage.pace) md.appendMarkdown(`${escapeMd(me.usage.pace)}\n\n`);
  if (pending) md.appendMarkdown(`$(sync) Uses **${escapeMd(chosen.name)}** after the extension host restarts. Click to restart.\n\n`);
  for (const c of state.conflicts) md.appendMarkdown(`$(warning) ${escapeMd(c.text)}\n\n`);
  md.appendMarkdown(`Folder: \`${me.home}\``);
  item.tooltip = md;
  item.command = pending ? 'codexProfileSwitcher.restartExtensionHost' : 'codexProfileSwitcher.switchProfile';
  item.show();
}

function accountLine(p) {
  if (p.apiKey) return 'API key';
  return [p.email || 'Signed in', p.plan].filter(Boolean).join(' · ');
}

function escapeMd(s) {
  return String(s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

// ------------------------------------------------------------------ refresh loop

let refreshing = false;

function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const reg = registry.loadRegistry();
    observe(S.scanner.scan(sessionDirs(reg)), reg);
    const state = buildState();
    const me = state._me;
    delete state._me;
    S.lastState = state;
    updateStatus(state);
    if (S.view) S.view.post(force);
    vscode.commands.executeCommand('setContext', 'codexProfileSwitcher.windowHasOwnProfile', !!S.context.workspaceState.get(WS_KEY));
    maybeNotifyLimit(me);
    checkReminder();
  } catch (e) {
    log(`refresh failed: ${e.stack || e}`);
  } finally {
    refreshing = false;
  }
}

async function maybeNotifyLimit(me) {
  if (!me || !me.limited || cfg().get('offerContinue') === 'off') return;
  if (!me.usageAt || me.usageAt < S.activatedAt) return; // only a limit hit while this window is open
  const key = `${me.id}:${me.resetAt}`;
  if (S.context.workspaceState.get(LIMIT_NOTIFIED_KEY) === key) return;
  await S.context.workspaceState.update(LIMIT_NOTIFIED_KEY, key);
  const buttons = me.best ? [`Continue with ${me.best.name}`, 'Choose…'] : ['Remind Me'];
  const choice = await vscode.window.showWarningMessage(
    `${me.name} hit its usage limit.${me.resetText ? ` Resets ${me.resetText}.` : ''}`, ...buttons);
  if (!choice) return;
  if (choice === 'Remind Me') await vscode.commands.executeCommand('codexProfileSwitcher.remindAtReset');
  else if (choice === 'Choose…') await vscode.commands.executeCommand('codexProfileSwitcher.continueWithAccount');
  else await vscode.commands.executeCommand('codexProfileSwitcher.continueWithAccount', { profileId: me.best.id });
}

// The reminder lives in a file so that exactly one window shows it: the one that deletes it.
function checkReminder() {
  const r = readJson(REMINDER_FILE, null);
  if (!r || !(r.at <= Date.now())) return;
  try {
    fs.unlinkSync(REMINDER_FILE);
  } catch (_) {
    return; // another window got it
  }
  const p = registry.findProfile(registry.loadRegistry(), r.profileId);
  const name = p ? p.name : r.name;
  const buttons = p && (!S.applied || S.applied.id !== p.id) ? [`Switch to ${name}`] : [];
  vscode.window.showInformationMessage(`${name}'s Codex usage limit has reset.`, ...buttons).then((c) => {
    if (c) vscode.commands.executeCommand('codexProfileSwitcher.switchProfile', { profileId: p.id });
  });
}

// ------------------------------------------------------------------ helpers for commands

function quickPickItem(p, now = Date.now()) {
  const info = accountInfo(p.home);
  const u = usageOf(p, now);
  let detail = p.builtin ? `${tildify(p.home)} · main Codex home` : `${tildify(p.home)} · ${p.history === 'shared' ? 'shared history' : 'own history'}`;
  if (u && u.limited) detail = `Limited until ${u.resetText} · ${detail}`;
  else if (u && u.meters.length) detail = `${u.meters.map((m) => `${m.label} ${m.text}`).join(' · ')} · ${detail}`;
  return {
    label: `${S.applied && S.applied.id === p.id ? '$(pass-filled)' : '$(account)'} ${p.name}`,
    description: accountLabel(info),
    detail,
    profile: p,
  };
}

async function pickProfile(placeHolder, filter) {
  const reg = registry.loadRegistry();
  const items = registry.listProfiles(reg).filter(filter || (() => true)).map((p) => quickPickItem(p));
  if (!items.length) {
    vscode.window.showInformationMessage('No matching profiles.');
    return null;
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
  return pick ? pick.profile : null;
}

// Commands get a webview context ({ profileId }), a profile, or nothing (Command Palette).
async function resolveArg(arg, placeHolder, filter) {
  const id = arg && (arg.profileId || arg.id);
  if (id) {
    const p = registry.findProfile(registry.loadRegistry(), id);
    if (!p) throw new Error('That profile is no longer in the list.');
    return p;
  }
  return pickProfile(placeHolder, filter);
}

async function restartHost() {
  await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
}

async function offerRestart(message, mode) {
  mode = mode || cfg().get('restartAfterSwitch');
  if (mode === 'never' || mode === 'later') {
    vscode.window.showInformationMessage(`${message} It takes effect after the extension host restarts.`);
    return;
  }
  if (mode === 'always' || mode === 'now') {
    await restartHost();
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `${message} Codex picks it up after the extension host restarts, which also restarts the other extensions in this window (for example Claude Code).`,
    'Restart Now', 'Later');
  if (choice === 'Restart Now') await restartHost();
}

async function switchTo(p, mode) {
  syncProfile(p);
  await S.context.workspaceState.update(WS_KEY, p.id);
  refresh(true);
  if (S.applied && S.applied.id === p.id) {
    vscode.window.showInformationMessage(`This window already uses "${p.name}".`);
    return;
  }
  if (!accountInfo(p.home).signedIn) {
    vscode.window.showWarningMessage(`"${p.name}" is not signed in yet. Sign in from its card, or from the Codex panel after the restart.`);
  }
  await offerRestart(`This window will use "${p.name}".`, mode);
}

async function askHistoryMode(recommendOwn) {
  const sharedItem = { label: 'Shared history', description: recommendOwn ? '' : 'recommended', detail: 'Conversations, memories and settings are shared with the main Codex home and the other shared profiles.', value: 'shared' };
  const ownItem = { label: 'Own history', description: recommendOwn ? 'recommended for an existing folder' : '', detail: 'Only settings (config.toml, AGENTS.md, rules, skills, plugins, prompts) are shared; conversations stay with this account.', value: 'isolated' };
  const pick = await vscode.window.showQuickPick(recommendOwn ? [ownItem, sharedItem] : [sharedItem, ownItem],
    { placeHolder: 'Conversation history for this account' });
  return pick ? pick.value : null;
}

function askName(value, prompt = 'Profile name') {
  return vscode.window.showInputBox({
    prompt,
    value,
    validateInput: (v) => (v.trim() ? null : 'Enter a name'),
  });
}

function createProfile(name, history, home) {
  const reg = registry.loadRegistry();
  const id = makeUniqueId(reg, name);
  const profile = { id, name, home: home || path.join(HOMES, id), history, color: registry.nextColor(reg), created: new Date().toISOString() };
  homes.syncHome(profile, registry.mainHome(), true);
  reg.profiles.push(profile);
  saveAndForget(reg, profile.home);
  return profile;
}

function makeUniqueId(reg, name) {
  let id;
  do id = registry.makeId(name); while (registry.findProfile(reg, id) || lstat(path.join(HOMES, id)));
  return id;
}

function saveAndForget(reg, home) {
  delete reg.forgotten[home];
  reg.hidden = reg.hidden.filter((h) => h !== home);
  registry.saveRegistry(reg);
}

async function startSignIn(p) {
  syncProfile(p);
  const how = await vscode.window.showQuickPick([
    { label: '$(globe) Browser', detail: 'codex login: opens a sign-in page; on a remote machine VS Code forwards the localhost callback port.', args: 'login' },
    { label: '$(device-mobile) Device code', detail: 'codex login --device-auth: enter a code on another device (enable device code login in ChatGPT security settings first).', args: 'login --device-auth' },
    { label: '$(key) API key', detail: 'codex login --with-api-key: type the key in the terminal (not echoed).', apiKey: true },
  ], { placeHolder: `Sign in to "${p.name}"` });
  if (!how) return;
  const term = profileTerminal(p, `Codex login: ${p.name}`);
  const bin = shellQuote(codexBinary());
  if (how.apiKey) {
    // Plain sh, because the terminal's own shell may be zsh or fish. The key is never echoed.
    const script = `trap 'stty echo' EXIT; trap 'exit 130' INT TERM; stty -echo; printf 'OpenAI API key: '; IFS= read -r key; stty echo; echo; printf %s "$key" | ${bin} login --with-api-key`;
    term.sendText(`sh -c ${shellQuote(script)}`, true);
  } else {
    term.sendText(`${bin} ${how.args}`, true);
  }
  vscode.window.showInformationMessage(`Finish signing in to "${p.name}" in the terminal. The panel updates when you're done.`);
}

function copyConversation(rec, target) {
  const targetRoot = path.join(target.home, 'sessions');
  const dest = path.join(targetRoot, path.relative(rec.root, rec.path));
  if (!lstat(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.copyFileSync(rec.path, dest, fs.constants.COPYFILE_FICLONE);
    log(`copied conversation ${rec.meta.id} to ${dest}`);
  }
  // Carry its title over too.
  const srcIndex = path.join(path.dirname(rec.root), 'session_index.jsonl');
  const dstIndex = path.join(target.home, 'session_index.jsonl');
  try {
    const line = fs.readFileSync(srcIndex, 'utf8').split('\n').reverse().find((l) => l.includes(`"${rec.meta.id}"`));
    const existing = lstat(dstIndex) ? fs.readFileSync(dstIndex, 'utf8') : '';
    if (line && !existing.includes(`"${rec.meta.id}"`)) fs.appendFileSync(dstIndex, `${line}\n`);
  } catch (_) { /* no index */ }
}

function conversationTitle(rec) {
  try {
    const index = path.join(path.dirname(rec.root), 'session_index.jsonl');
    const line = fs.readFileSync(index, 'utf8').split('\n').reverse().find((l) => l.includes(`"${rec.meta.id}"`));
    return line ? JSON.parse(line).thread_name || null : null;
  } catch (_) {
    return null;
  }
}

async function continueWith(target) {
  const from = S.applied;
  // The latest conversation of this folder in this window's history.
  const ownRoot = realpathOr(path.join(from.home, 'sessions'));
  const latest = S.scanner.conversationsIn(windowFolders()).find((r) => r.root === ownRoot) || null;
  if (!target) {
    target = await pickProfile('Continue this folder\'s latest Codex conversation with which account?',
      (p) => p.id !== from.id);
    if (!target) return;
  }
  if (target.id === from.id) {
    vscode.window.showInformationMessage(`This window already uses "${target.name}".`);
    return;
  }
  if (!accountInfo(target.home).signedIn) {
    const c = await vscode.window.showWarningMessage(`"${target.name}" is not signed in.`, 'Sign In…');
    if (c) await startSignIn(target);
    return;
  }
  syncProfile(target);
  if (latest) {
    const title = conversationTitle(latest);
    if (realpathOr(path.join(target.home, 'sessions')) !== latest.root) copyConversation(latest, target);
    await S.context.workspaceState.update(HANDOFF_KEY, { sessionId: latest.meta.id, profileId: target.id, title, at: Date.now() });
    log(`continuing ${latest.meta.id} with ${target.name}`);
  } else {
    const ok = await vscode.window.showInformationMessage(
      `No Codex conversation found for this folder. Switch this window to "${target.name}" anyway?`, { modal: true }, 'Switch and Restart');
    if (ok !== 'Switch and Restart') return;
  }
  await S.context.workspaceState.update(WS_KEY, target.id);
  await restartHost();
}

// After a "Continue with" restart: open the conversation in the Codex panel.
async function completeHandoff() {
  const h = S.context.workspaceState.get(HANDOFF_KEY);
  if (!h) return;
  await S.context.workspaceState.update(HANDOFF_KEY, undefined);
  if (!S.applied || S.applied.id !== h.profileId || Date.now() - h.at > 10 * 60e3) return;
  const label = h.title ? `"${h.title}"` : 'the conversation';
  try {
    const ext = vscode.extensions.getExtension('openai.chatgpt');
    if (!ext) throw new Error('the Codex extension is not installed');
    if (!ext.isActive) await ext.activate();
    await vscode.commands.executeCommand('chatgpt.openSidebar');
    await new Promise((r) => setTimeout(r, 800));
    await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://openai.chatgpt/local/${h.sessionId}`));
  } catch (e) {
    log(`could not open ${h.sessionId} in the Codex panel: ${e.message}`);
  }
  const choice = await vscode.window.showInformationMessage(`Continuing ${label} with ${S.applied.name}.`, 'Open in Terminal Instead');
  if (choice) {
    const term = profileTerminal(S.applied, `Codex: ${S.applied.name}`);
    term.sendText(`${shellQuote(codexBinary())} resume ${h.sessionId}`, true);
  }
}

// ------------------------------------------------------------------ commands

function registerCommands(context) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      log(`${id} failed: ${e.stack || e}`);
      vscode.window.showErrorMessage(`Codex Profiles: ${e.message || e}`);
    }
    refresh(true);
  }));

  reg('codexProfileSwitcher.refresh', () => {});
  reg('codexProfileSwitcher.showPanel', () => vscode.commands.executeCommand(`${VIEW_ID}.focus`));
  reg('codexProfileSwitcher.showLog', () => S.output.show());
  reg('codexProfileSwitcher.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${S.context.extension.id}`));
  reg('codexProfileSwitcher.restartExtensionHost', restartHost);

  reg('codexProfileSwitcher.switchProfile', async (arg, mode) => {
    const p = await resolveArg(arg, 'Codex account for this window');
    if (p) await switchTo(p, mode);
  });

  reg('codexProfileSwitcher.useDefault', async () => {
    await S.context.workspaceState.update(WS_KEY, undefined);
    const p = registry.newWindowProfile(registry.loadRegistry());
    if (S.applied && S.applied.id === p.id) return;
    await offerRestart(`This window will use "${p.name}", the profile for new windows.`);
  });

  reg('codexProfileSwitcher.setNewWindowProfile', async (arg) => {
    const p = await resolveArg(arg, 'Codex account for windows that have no profile yet');
    if (!p) return;
    const r = registry.loadRegistry();
    r.newWindowProfile = p.id;
    registry.saveRegistry(r);
  });

  reg('codexProfileSwitcher.addProfile', async () => {
    const name = await askName('', 'Name for the new account (for example Work or Personal)');
    if (!name) return;
    const history = await askHistoryMode(false);
    if (!history) return;
    const p = createProfile(name.trim(), history);
    refresh(true);
    await startSignIn(p);
  });

  reg('codexProfileSwitcher.addExistingFolder', async (arg) => {
    let dir = arg && arg.foundPath;
    if (!dir) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        defaultUri: vscode.Uri.file(os.homedir()),
        openLabel: 'Add Folder', title: 'Choose a Codex home folder (the folder that holds auth.json)',
      });
      if (!picked || !picked.length) return;
      dir = picked[0].fsPath;
    }
    const r = registry.loadRegistry();
    const main = registry.mainHome();
    const real = realpathOr(dir);
    if (real === realpathOr(main)) throw new Error('That is the main Codex home, which the Default profile already uses.');
    if (real === realpathOr(ROOT) || real === realpathOr(HOMES)) throw new Error('Choose a profile folder, not the folder that holds them.');
    const dup = registry.listProfiles(r).find((p) => realpathOr(p.home) === real);
    if (dup) throw new Error(`"${dup.name}" already uses that folder.`);
    const info = accountInfo(dir);
    const remembered = r.forgotten[dir] || {};
    const fallback = remembered.name || (info.email ? info.email.split('@')[0] : path.basename(dir).replace(/^\.?codex[-_.]?/i, '') || path.basename(dir));
    const name = arg && arg.foundPath && remembered.name ? remembered.name : await askName(fallback);
    if (!name) return;
    const ours = path.dirname(dir) === HOMES;
    const history = ours ? homes.detectHistoryMode(dir, main) : await askHistoryMode(true);
    if (!history) return;
    const profile = { id: ours ? path.basename(dir) : makeUniqueId(r, name), name: name.trim(), home: dir, history, created: new Date().toISOString() };
    if (registry.findProfile(r, profile.id)) profile.id = makeUniqueId(r, name);
    profile.color = remembered.color && !registry.listProfiles(r).some((p) => p.color === remembered.color) ? remembered.color : registry.nextColor(r);
    if (history === 'shared' && homes.detectHistoryMode(dir, main) !== 'shared') homes.setHistoryMode(profile, 'shared', main);
    r.profiles.push(profile);
    saveAndForget(r, dir);
    vscode.window.showInformationMessage(`Added "${profile.name}" (${accountLabel(info)}).`);
  });

  reg('codexProfileSwitcher.importAuth', async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: 'Import', defaultUri: vscode.Uri.file(registry.mainHome()),
      filters: { 'Codex login': ['json'] }, title: 'Choose a Codex auth.json',
    });
    if (!picked || !picked.length) return;
    const src = picked[0].fsPath;
    let info;
    try {
      info = accountInfoFromAuth(JSON.parse(fs.readFileSync(src, 'utf8')));
    } catch (_) {
      info = { signedIn: false };
    }
    if (!info.signedIn) throw new Error(`${src} is not a Codex auth.json with a login.`);
    const ok = await vscode.window.showWarningMessage(
      `Import ${accountLabel(info)}? A login copied from elsewhere stops working in one place once the other copy refreshes its token. Use this only for a login that is not used anywhere else; otherwise add an account and sign in fresh.`,
      { modal: true }, 'Import');
    if (ok !== 'Import') return;
    const name = await askName(info.email ? info.email.split('@')[0] : path.basename(path.dirname(src)));
    if (!name) return;
    const history = await askHistoryMode(false);
    if (!history) return;
    const p = createProfile(name.trim(), history);
    fs.copyFileSync(src, path.join(p.home, 'auth.json'));
    fs.chmodSync(path.join(p.home, 'auth.json'), 0o600);
    vscode.window.showInformationMessage(`Imported "${p.name}" (${accountLabel(accountInfo(p.home))}).`);
  });

  const signIn = async (arg) => {
    const p = await resolveArg(arg, 'Sign in to which profile?');
    if (!p) return;
    if (accountInfo(p.home).signedIn) {
      const ok = await vscode.window.showWarningMessage(
        `"${p.name}" is signed in as ${accountLabel(accountInfo(p.home))}. Sign in to another account instead?`, { modal: true }, 'Sign In');
      if (ok !== 'Sign In') return;
    }
    await startSignIn(p);
  };
  reg('codexProfileSwitcher.signIn', signIn);
  reg('codexProfileSwitcher.signInAnother', signIn);

  reg('codexProfileSwitcher.signOut', async (arg) => {
    const p = await resolveArg(arg, 'Sign out of which profile?', (x) => accountInfo(x.home).signedIn);
    if (!p) return;
    const ok = await vscode.window.showWarningMessage(
      `Sign out of "${p.name}" (${accountLabel(accountInfo(p.home))})? Its auth.json is deleted; conversations are kept.`,
      { modal: true }, 'Sign Out');
    if (ok !== 'Sign Out') return;
    fs.rmSync(path.join(p.home, 'auth.json'), { force: true });
    if (S.applied && S.applied.id === p.id) {
      vscode.window.showInformationMessage('Codex in this window keeps its session until the extension host restarts.');
    }
  });

  reg('codexProfileSwitcher.usageDetails', async (arg) => {
    const p = await resolveArg(arg, 'Usage of which account?');
    if (!p) return;
    const info = accountInfo(p.home);
    const lines = info.mode === 'apikey'
      ? ['API key accounts have no usage limits to show.']
      : usage.detailLines(usageOf(p, Date.now()), p.name);
    await vscode.window.showInformationMessage(`${p.name} — ${accountLabel(info)}`, { modal: true, detail: lines.join('\n') });
  });

  reg('codexProfileSwitcher.toggleHistory', async (arg) => {
    const p = await resolveArg(arg, 'Change history sharing of which profile?', (x) => !x.builtin);
    if (!p) return;
    if (p.builtin) throw new Error('The Default profile is the main Codex home.');
    const using = windows.windowsUsing()[p.id] || 0;
    if (using > 0) {
      throw new Error(`"${p.name}" is in use by ${using} window(s)${S.applied && S.applied.id === p.id ? ', including this one' : ''}. Switch those windows to another profile first, so that Codex does not have its databases open while they are moved.`);
    }
    const target = p.history === 'shared' ? 'isolated' : 'shared';
    const text = target === 'shared'
      ? `Share history for "${p.name}"? Its own conversations are put aside (in ${homes.ISOLATED_STASH}) and come back if you switch to own history again.`
      : `Give "${p.name}" its own history? It will no longer see the shared conversations; any history it had before sharing is restored.`;
    const ok = await vscode.window.showWarningMessage(text, { modal: true }, 'Change');
    if (ok !== 'Change') return;
    const r = registry.loadRegistry();
    const stored = r.profiles.find((x) => x.id === p.id);
    homes.setHistoryMode(stored, target, registry.mainHome());
    registry.saveRegistry(r);
    vscode.window.showInformationMessage(`"${p.name}" now uses ${target === 'shared' ? 'shared' : 'its own'} history.`);
  });

  reg('codexProfileSwitcher.renameProfile', async (arg) => {
    const p = await resolveArg(arg, 'Rename which profile?');
    if (!p) return;
    const name = await askName(p.name);
    if (!name) return;
    registry.updateProfile(p.id, (x) => { x.name = name.trim(); });
    if (S.applied && S.applied.id === p.id) S.applied.name = name.trim();
  });

  reg('codexProfileSwitcher.changeColor', async (arg) => {
    const p = await resolveArg(arg, 'Change the color of which profile?');
    if (!p) return;
    const pick = await vscode.window.showQuickPick(COLORS.map((c) => ({
      label: `${c === p.color ? '$(check)' : '$(circle-filled)'} ${c.charAt(0).toUpperCase()}${c.slice(1)}`, color: c,
    })), { placeHolder: `Color for "${p.name}" (avatar, status bar and terminal tabs)` });
    if (!pick) return;
    registry.updateProfile(p.id, (x) => { x.color = pick.color; });
    if (S.applied && S.applied.id === p.id) S.applied.color = pick.color;
  });

  reg('codexProfileSwitcher.changeFolder', async (arg) => {
    const p = await resolveArg(arg, 'Change the folder of which profile?', (x) => !x.builtin);
    if (!p) return;
    if (p.builtin) throw new Error('The Default profile uses the main Codex home; change "codexProfileSwitcher.mainCodexHome" instead.');
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(p.home),
      openLabel: 'Use Folder', title: `New Codex home for "${p.name}"`,
    });
    if (!picked || !picked.length) return;
    const dir = picked[0].fsPath;
    const r = registry.loadRegistry();
    const real = realpathOr(dir);
    if (real === realpathOr(registry.mainHome())) throw new Error('That is the main Codex home.');
    const dup = registry.listProfiles(r).find((x) => x.id !== p.id && realpathOr(x.home) === real);
    if (dup) throw new Error(`"${dup.name}" already uses that folder.`);
    const stored = r.profiles.find((x) => x.id === p.id);
    r.forgotten[stored.home] = { name: stored.name, color: stored.color, history: stored.history };
    stored.home = dir;
    stored.history = homes.detectHistoryMode(dir, registry.mainHome());
    saveAndForget(r, dir);
    const using = windows.windowsUsing()[p.id] || 0;
    vscode.window.showInformationMessage(`"${p.name}" now uses ${tildify(dir)}${using ? '. Windows that use it pick this up after a restart' : ''}.`);
  });

  reg('codexProfileSwitcher.openTerminal', async (arg) => {
    const p = await resolveArg(arg, 'Open a terminal for which profile?');
    if (!p) return;
    syncProfile(p);
    profileTerminal(p, `Codex: ${p.name}`);
  });

  const reveal = async (dir) => {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir)).then(undefined, async () => {
      await vscode.env.clipboard.writeText(dir);
      vscode.window.showInformationMessage(`Copied: ${dir}`);
    });
  };
  reg('codexProfileSwitcher.revealFolder', async (arg) => {
    if (arg && arg.foundPath) return reveal(arg.foundPath);
    const p = await resolveArg(arg, 'Reveal the folder of which profile?');
    if (p) await reveal(p.home);
  });
  reg('codexProfileSwitcher.revealMainHome', () => reveal(registry.mainHome()));

  reg('codexProfileSwitcher.removeProfile', async (arg) => {
    const p = await resolveArg(arg, 'Remove which profile from the list?', (x) => !x.builtin);
    if (!p) return;
    if (p.builtin) throw new Error('The Default profile cannot be removed.');
    const r = registry.loadRegistry();
    const index = r.profiles.findIndex((x) => x.id === p.id);
    const stored = r.profiles[index];
    r.profiles.splice(index, 1);
    r.forgotten[stored.home] = { name: stored.name, color: stored.color, history: stored.history };
    const wasNewWindow = r.newWindowProfile === p.id;
    if (wasNewWindow) r.newWindowProfile = DEFAULT_ID;
    registry.saveRegistry(r);
    const wasChosen = S.context.workspaceState.get(WS_KEY) === p.id;
    if (wasChosen) await S.context.workspaceState.update(WS_KEY, undefined);
    refresh(true);
    const choice = await vscode.window.showInformationMessage(
      `Removed "${p.name}" from the list. Its folder and sign-in are kept (${tildify(stored.home)}).`, 'Undo');
    if (choice !== 'Undo') return;
    const again = registry.loadRegistry();
    if (registry.findProfile(again, stored.id)) return;
    again.profiles.splice(Math.min(index, again.profiles.length), 0, stored);
    if (wasNewWindow) again.newWindowProfile = stored.id;
    saveAndForget(again, stored.home);
    if (wasChosen) await S.context.workspaceState.update(WS_KEY, stored.id);
  });

  reg('codexProfileSwitcher.hideFound', (arg) => {
    if (!arg || !arg.foundPath) return;
    const r = registry.loadRegistry();
    if (!r.hidden.includes(arg.foundPath)) r.hidden.push(arg.foundPath);
    registry.saveRegistry(r);
  });

  reg('codexProfileSwitcher.deleteFoundFolder', async (arg) => {
    const dir = arg && arg.foundPath;
    if (!dir || path.dirname(dir) !== HOMES) throw new Error('Only profile folders created by this extension can be deleted here.');
    const sharedLinks = homes.detectHistoryMode(dir, registry.mainHome()) === 'shared';
    const ok = await vscode.window.showWarningMessage(
      `Delete ${tildify(dir)}? Its sign-in is deleted${sharedLinks ? '; the shared conversations stay in the main Codex home' : ', and so is the conversation history kept in it'}. This cannot be undone.`,
      { modal: true }, 'Delete Folder');
    if (ok !== 'Delete Folder') return;
    fs.rmSync(dir, { recursive: true, force: true });
    const r = registry.loadRegistry();
    delete r.forgotten[dir];
    registry.saveRegistry(r);
  });

  reg('codexProfileSwitcher.continueWithAccount', async (arg) => {
    const id = arg && (arg.profileId || arg.id);
    const target = id ? registry.findProfile(registry.loadRegistry(), id) : null;
    await continueWith(target);
  });
  reg('codexProfileSwitcher.continueWithThis', async (arg) => {
    const p = await resolveArg(arg, 'Continue with which account?');
    if (p) await continueWith(p);
  });

  reg('codexProfileSwitcher.remindAtReset', async () => {
    const reg2 = registry.loadRegistry();
    const now = Date.now();
    let best = null;
    for (const p of registry.listProfiles(reg2)) {
      const u = usageOf(p, now);
      if (u && u.limited && u.resetAt && (!best || u.resetAt < best.at)) best = { at: u.resetAt, profileId: p.id, name: p.name };
    }
    if (!best) {
      vscode.window.showInformationMessage('No account is at its usage limit.');
      return;
    }
    writeJsonAtomic(REMINDER_FILE, best);
    vscode.window.showInformationMessage(`You'll be reminded at ${fmtWhen(best.at, now)}, when ${best.name}'s limit resets.`);
  });

  reg('codexProfileSwitcher.installShellAliases', async () => {
    await installShellAliases(registry.listProfiles(registry.loadRegistry()), codexBinary);
  });

  reg('codexProfileSwitcher.openConflict', async (arg) => {
    if (!arg) return;
    if (arg.kind === 'extension') await vscode.commands.executeCommand('workbench.extensions.search', `@installed ${arg.id}`);
    else if (arg.kind === 'setting') await vscode.commands.executeCommand('workbench.action.openSettings', 'chatgpt.cliExecutable');
    else if (arg.kind === 'early') await restartHost();
  });
}

// Messages from the panel.
async function onMessage(msg) {
  const run = (id, ...args) => vscode.commands.executeCommand(id, ...args);
  const ctx = { profileId: msg.id };
  switch (msg.type) {
    case 'switch': return run('codexProfileSwitcher.switchProfile', ctx, msg.restart);
    case 'restart': return restartHost();
    case 'signIn': return run('codexProfileSwitcher.signIn', ctx);
    case 'add': return run('codexProfileSwitcher.addProfile');
    case 'addExisting': return run('codexProfileSwitcher.addExistingFolder');
    case 'addFound': return run('codexProfileSwitcher.addExistingFolder', { foundPath: msg.path });
    case 'continue': return run('codexProfileSwitcher.continueWithAccount', ctx);
    case 'choose': return run('codexProfileSwitcher.continueWithAccount');
    case 'remind': return run('codexProfileSwitcher.remindAtReset');
    case 'details': return run('codexProfileSwitcher.usageDetails', ctx);
    case 'rename': return run('codexProfileSwitcher.renameProfile', ctx);
    case 'remove': return run('codexProfileSwitcher.removeProfile', ctx);
    case 'share': return run('codexProfileSwitcher.toggleHistory', ctx);
    case 'log': return run('codexProfileSwitcher.showLog');
    case 'conflict': return run('codexProfileSwitcher.openConflict', { kind: msg.kind, id: msg.extId });
    default: return undefined;
  }
}

// ------------------------------------------------------------------ activation

function activate(context) {
  // Everything up to setting CODEX_HOME is synchronous, so it happens before the official Codex
  // extension (activated onStartupFinished) starts its app-server.
  S.context = context;
  S.activatedAt = Date.now();
  S.output = vscode.window.createOutputChannel('Codex Profiles');
  context.subscriptions.push(S.output);
  util.setOutput(S.output);
  if (process.env.CODEX_HOME && !process.env.CODEX_HOME_BEFORE_PROFILE_SWITCHER) {
    process.env.CODEX_HOME_BEFORE_PROFILE_SWITCHER = process.env.CODEX_HOME;
  }
  try {
    registry.migrateRegistry();
  } catch (e) {
    log(`registry migration failed: ${e.message}`);
  }
  const reg = registry.loadRegistry();
  let profile = chosenProfile(reg);
  try {
    syncProfile(profile);
  } catch (e) {
    log(`sync of ${profile.name} failed: ${e.stack || e}`);
    if (!lstat(profile.home)) profile = registry.defaultProfile(reg);
  }
  process.env.CODEX_HOME = profile.home;
  S.applied = { ...profile };
  context.environmentVariableCollection.replace('CODEX_HOME', profile.home);
  context.environmentVariableCollection.description = `Codex profile "${profile.name}"`;
  windows.registerWindow(profile.id, windowFolders());
  log(`window uses profile "${profile.name}" (CODEX_HOME=${profile.home})`);

  const codexExt = vscode.extensions.getExtension('openai.chatgpt');
  if (codexExt && codexExt.isActive) {
    S.startedEarly = true;
    log('openai.chatgpt was already active when the profile was applied');
  }

  util.setTimeZone(context.globalState.get(TZ_KEY));
  S.view = new ProfilesViewProvider(context, {
    getState: () => S.lastState || buildState(),
    onMessage,
    onTimeZone: (tz) => {
      if (tz === context.globalState.get(TZ_KEY)) return;
      context.globalState.update(TZ_KEY, tz);
      util.setTimeZone(tz);
      refresh(true);
    },
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, S.view));
  S.status = vscode.window.createStatusBarItem('codexProfileSwitcher.status', vscode.StatusBarAlignment.Right, 90);
  S.status.name = 'Codex Profile';
  context.subscriptions.push(S.status);
  registerCommands(context);
  // The first scan reads every conversation's header; keep it out of the activation path.
  setTimeout(() => refresh(true), 300);

  const timer = setInterval(() => refresh(), 4000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && refresh()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('codexProfileSwitcher') || e.affectsConfiguration('chatgpt.cliExecutable')) refresh(true);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    windows.registerWindow(S.applied.id, windowFolders());
    refresh(true);
  }));

  warnAboutConflicts(context);
  setTimeout(() => completeHandoff().catch((e) => log(`handoff failed: ${e.message}`)), 1500);
}

function warnAboutConflicts(context) {
  const conflicts = computeConflicts();
  if (!conflicts.length) return;
  const key = conflicts.map((c) => c.text).join('|');
  log(`possible conflicts: ${key}`);
  if (context.globalState.get(WARNED_KEY) === key) return;
  context.globalState.update(WARNED_KEY, key);
  vscode.window.showWarningMessage(`Codex Profiles: ${conflicts.map((c) => c.text).join(' ')} Only one tool should choose the account.`, 'Show Panel')
    .then((c) => c && vscode.commands.executeCommand('codexProfileSwitcher.showPanel'));
}

function deactivate() {
  windows.unregisterWindow();
}

module.exports = { activate, deactivate };
