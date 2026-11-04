// Codex Profiles panel. Renders the state sent by the extension; every action is posted back.
(function () {
  'use strict';

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {}, getState() { return null; }, setState() {} };
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let state = null;
  let focusId = saved.focusId || null; // profile card that has (or last had) keyboard focus
  let confirming = null; // profile id whose inline "Switch and restart" confirmation is open

  const post = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));

  // ---------------------------------------------------------------- icons (16×16, currentColor)
  const ICONS = {
    check: '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    star: '<path d="M8 1.6l1.95 4.1 4.45.55-3.27 3.08.84 4.42L8 11.58l-3.97 2.17.84-4.42L1.6 6.25l4.45-.55z" fill="currentColor"/>',
    more: '<circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/>',
    plus: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    signIn: '<path d="M9.5 2.5h3v11h-3M2.5 8h7M6.5 5l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    swap: '<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    slash: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 12L12 4" stroke="currentColor" stroke-width="1.3"/>',
    warning: '<path d="M8 2.2l6.2 11H1.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.4v3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".8" fill="currentColor"/>',
    timer: '<rect x="5" y="1.5" width="6" height="2" rx=".6" fill="currentColor"/><rect x="5" y="12.5" width="6" height="2" rx=".6" fill="currentColor"/><rect x="3.6" y="3.4" width="8.8" height="9.2" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 6v2.3l1.4 1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    bell: '<path d="M4 11.5V7.3a4 4 0 018 0v4.2l1 1H3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.6 14h2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    folder: '<path d="M1.8 4.2c0-.6.4-1 1-1h3.3l1.4 1.5h5.7c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
    sync: '<path d="M13 8a5 5 0 01-8.6 3.5M3 8a5 5 0 018.6-3.5M11.6 2v2.5H9.1M4.4 14v-2.5h2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  };
  function icon(name, cls) {
    const span = document.createElement('span');
    span.className = `icon${cls ? ` ${cls}` : ''}`;
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16">${ICONS[name]}</svg>`;
    return span;
  }

  // ---------------------------------------------------------------- DOM helper
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'context') el.setAttribute('data-vscode-context', JSON.stringify(Object.assign({ preventDefaultContextMenuItems: true }, v)));
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function button(label, opts) {
    const o = opts || {};
    return h('button', {
      class: `btn ${o.kind || 'primary'}${o.small ? ' small' : ''}`,
      type: 'button',
      title: o.title,
      'aria-label': o.aria,
      onClick: (e) => { e.stopPropagation(); o.onClick(); },
    }, o.icon ? icon(o.icon) : null, label);
  }

  function link(label, onClick, title) {
    return h('button', { class: 'link', type: 'button', title, onClick: (e) => { e.stopPropagation(); onClick(); } }, label);
  }

  // Opens VS Code's context menu for `target` (its data-vscode-context), below `anchor`.
  function openMenu(target, anchor) {
    const r = (anchor || target).getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: r.left, clientY: r.bottom + 2 }));
  }

  function moreButton(label, getTarget) {
    const b = h('button', { class: 'icon-btn more', type: 'button', title: label, 'aria-label': label, tabindex: '-1' }, icon('more'));
    b.addEventListener('click', (e) => { e.stopPropagation(); openMenu(getTarget(), b); });
    return b;
  }

  function avatar(p, size) {
    const a = h('span', { class: `avatar c-${p.color}${size ? ` ${size}` : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'initials', text: p.initials }));
    return a;
  }

  // ---------------------------------------------------------------- sections
  function renderConflicts(list) {
    if (!list.length) return null;
    return h('div', { class: 'banner warn', role: 'alert' },
      icon('warning', 'banner-icon'),
      h('div', { class: 'banner-body' },
        h('div', { class: 'banner-title', text: 'Another tool also sets the Codex account' }),
        list.map((c) => h('div', { class: 'banner-text' }, c.text, ' ',
          link(c.kind === 'extension' ? 'Show extension' : c.kind === 'setting' ? 'Open setting' : 'Restart extension host',
            () => post('conflict', { kind: c.kind, extId: c.id })))),
      ));
  }

  function renderLimitBanner(b) {
    if (!b) return null;
    const actions = [];
    if (b.best) {
      actions.push(button(`Continue with ${b.best.name}`, { icon: 'swap', onClick: () => post('continue', { id: b.best.id }) }));
      actions.push(link('Choose…', () => post('choose')));
    } else if (b.reminder) {
      actions.push(h('span', { class: 'muted' }, icon('bell'), ` Reminder set for ${b.reminder}`));
    } else {
      actions.push(button('Remind me', { icon: 'bell', onClick: () => post('remind') }));
      if (b.canChoose) actions.push(link('Choose…', () => post('choose')));
    }
    const text = [b.resetText ? `Resets ${/^\d/.test(b.resetText) ? 'at ' : ''}${b.resetText}.` : '',
      b.best ? (b.hasFolder ? 'Continue this conversation with another account.' : 'Switch to another account.') :
        'Every other account is limited or signed out.'].filter(Boolean).join(' ');
    return h('div', { class: 'banner limit', role: 'alert' },
      icon('timer', 'banner-icon'),
      h('div', { class: 'banner-body' },
        h('div', { class: 'banner-title', text: `${b.name} hit its usage limit` }),
        h('div', { class: 'banner-text', text }),
        h('div', { class: 'banner-actions' }, actions)));
  }

  function meterRow(p) {
    if (!p.usage || !p.usage.meters.length) return null;
    const row = h('div', { class: 'meters', title: p.usage.meters.map((m) => m.title).join('\n') + '\nClick for details' });
    for (const m of p.usage.meters) {
      const fill = h('span', { class: 'fill' });
      fill.style.width = `${Math.max(m.pct > 0 ? 2 : 0, Math.min(100, m.pct))}%`;
      const bar = h('span', { class: 'bar', role: 'img', 'aria-label': `${m.label} ${m.text} used` }, fill);
      if (m.tick !== null && m.tick !== undefined) {
        const tick = h('span', { class: 'tick' });
        tick.style.left = `${Math.min(100, Math.max(0, m.tick * 100))}%`;
        bar.append(tick);
      }
      row.append(h('span', { class: `meter ${m.level}${m.ahead ? ' ahead' : ''}` },
        h('span', { class: 'meter-label', text: m.label }), bar, h('span', { class: 'meter-pct', text: m.text })));
    }
    row.addEventListener('click', (e) => { e.stopPropagation(); post('details', { id: p.id }); });
    return row;
  }

  function statusLine(p) {
    if (p.missing) return h('div', { class: 'sub warn-text' }, icon('slash'), ' Folder not found');
    if (!p.signedIn) return h('div', { class: 'sub warn-text' }, icon('slash'), ' Not signed in');
    if (p.limited) {
      return h('div', { class: 'sub wrap' }, h('span', { class: 'pill limited', text: 'Limited' }),
        p.resetText ? h('span', { class: 'muted', text: ` Resets ${p.resetText}` }) : null);
    }
    const text = p.apiKey ? 'API key' : [p.email || 'Signed in', p.plan].filter(Boolean).join(' · ');
    return h('div', { class: 'sub muted', text, title: text });
  }

  function startSwitch(p) {
    if (state.restartMode === 'always') return post('switch', { id: p.id, restart: 'now' });
    if (state.restartMode === 'never') return post('switch', { id: p.id, restart: 'later' });
    confirming = p.id;
    focusId = p.id;
    render();
    const b = app.querySelector('.confirm .btn.primary');
    if (b) b.focus();
  }

  function primaryAction(p) {
    if (!p.signedIn || p.missing) return post('signIn', { id: p.id });
    if (p.chosen && !p.applied) return post('restart');
    if (!p.chosen) return startSwitch(p);
    return undefined;
  }

  function renderCard(p, index, list) {
    const ctx = {
      webviewSection: 'profile', profileId: p.id, cpsApplied: p.applied, cpsChosen: p.chosen, cpsNewWindow: p.newWindow,
      cpsSignedIn: p.signedIn, cpsBuiltin: p.builtin, cpsChatgpt: p.signedIn && !p.apiKey,
    };
    const isFocus = focusId ? focusId === p.id : (p.applied || (!list.some((x) => x.applied) && index === 0));
    const card = h('div', {
      class: `card c-${p.color}${p.applied ? ' current' : ''}${p.chosen && !p.applied ? ' chosen' : ''}`,
      role: 'option',
      'aria-selected': p.applied ? 'true' : 'false',
      'aria-label': `${p.name}${p.applied ? ', this window' : ''}${p.newWindow ? ', used for new windows' : ''}`,
      tabindex: isFocus ? '0' : '-1',
      'data-id': p.id,
      context: ctx,
    });
    const av = avatar(p);
    if (p.applied) av.append(h('span', { class: 'badge-check', title: 'This window' }, icon('check')));
    const title = h('div', { class: 'line1' },
      h('span', { class: 'name', text: p.name, title: p.home }),
      p.newWindow ? h('span', { class: 'star', title: 'New windows use this account' }, icon('star')) : null,
      p.chosen && !p.applied ? h('span', { class: 'pill pending', text: 'After restart', title: 'This window switches to this account when the extension host restarts' }) : null);
    const body = h('div', { class: 'body' }, title, statusLine(p), meterRow(p));
    if (p.usage && (p.usage.pace || p.usage.note) && !p.limited) {
      body.append(h('div', { class: `note${p.usage.pace ? ' pace' : ''}`, text: p.usage.pace || p.usage.note }));
    }
    if (!p.signedIn || p.missing) {
      body.append(h('div', { class: 'card-actions' }, button('Sign in', { kind: 'secondary', small: true, icon: 'signIn', onClick: () => post('signIn', { id: p.id }) })));
    } else if (p.chosen && !p.applied) {
      body.append(h('div', { class: 'card-actions' }, button('Restart now', { kind: 'secondary', small: true, icon: 'sync', onClick: () => post('restart') })));
    }
    if (confirming === p.id) {
      body.append(h('div', { class: 'confirm', role: 'group', 'aria-label': `Switch to ${p.name}` },
        h('div', { class: 'confirm-text', text: 'Codex uses the new account after the extension host restarts. Other extensions in this window restart too.' }),
        h('div', { class: 'confirm-actions' },
          button('Switch and restart', { onClick: () => { confirming = null; post('switch', { id: p.id, restart: 'now' }); } }),
          link('Switch later', () => { confirming = null; post('switch', { id: p.id, restart: 'later' }); }),
          link('Cancel', () => { confirming = null; render(); }))));
    }
    const side = h('div', { class: 'side' });
    if (!p.chosen && p.signedIn && !p.missing && confirming !== p.id) {
      side.append(button('Switch', { kind: 'secondary', small: true, title: `Use ${p.name} in this window`, onClick: () => startSwitch(p) }));
    }
    side.append(moreButton(`More actions for ${p.name}`, () => card));
    card.append(av, body, side);
    card.addEventListener('focus', () => { focusId = p.id; vscode.setState({ focusId }); });
    card.addEventListener('click', () => card.focus());
    return card;
  }

  function renderFound(found) {
    if (!found.length) return null;
    return h('section', { class: 'section' },
      h('h3', { class: 'section-title', text: 'Found on this computer' }),
      found.map((f) => {
        const row = h('div', {
          class: 'found', title: f.path, context: { webviewSection: 'found', foundPath: f.path, cpsOurs: f.ours },
        },
        h('span', { class: 'avatar ghost', 'aria-hidden': 'true' }, icon('folder')),
        h('div', { class: 'body' },
          h('div', { class: 'line1' }, h('span', { class: 'name', text: f.name })),
          h('div', { class: `sub ${f.signedIn ? 'muted' : 'warn-text'}`, text: f.label }),
          h('div', { class: 'sub muted path', text: f.display })),
        h('div', { class: 'side' },
          button('Add', { kind: 'secondary', small: true, aria: `Add ${f.name}`, onClick: () => post('addFound', { path: f.path }) })));
        row.querySelector('.side').append(moreButton(`More actions for ${f.display}`, () => row));
        return row;
      }));
  }

  function renderShared(s) {
    if (!s) return null;
    const card = h('div', { class: 'shared-card', tabindex: '0', context: { webviewSection: 'shared' } });
    const head = h('div', { class: 'line1' }, h('span', { class: 'name', text: s.home, title: 'Main Codex home: the shared conversations, memories and settings' }));
    head.append(moreButton('History sharing actions', () => card));
    const faces = h('span', { class: 'faces' }, s.members.map((m) => avatar(m, 'small')));
    const lines = [
      head,
      h('div', { class: 'sub members' }, faces, h('span', { class: 'muted', text: s.members.map((m) => m.name).join(', ') })),
      h('div', {
        class: 'sub muted',
        text: s.here !== null ? `${s.here} conversation${s.here === 1 ? '' : 's'} in ${s.folderName} · ${s.total} in all` : `${s.total} conversation${s.total === 1 ? '' : 's'}`,
      }),
    ];
    if (s.problems) {
      lines.push(h('div', { class: 'sub warn-text' }, icon('warning'), ` ${s.problems} item${s.problems === 1 ? '' : 's'} not shared `, link('Show log', () => post('log'))));
    } else {
      lines.push(h('div', { class: 'sub muted' }, icon('check'), ' Up to date'));
    }
    if (s.own.length) {
      lines.push(h('div', { class: 'sub muted own' }, 'Own history: ',
        s.own.map((o, i) => [i ? ', ' : '', link(o.name, () => post('share', { id: o.id }), `Share ${o.name}'s history…`)])));
    }
    card.append(...lines);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || (e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
        e.preventDefault();
        openMenu(card, card.querySelector('.more'));
      }
    });
    return h('section', { class: 'section' }, h('h3', { class: 'section-title', text: 'Shared history' }), card);
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!state) return;
    const hadFocus = app.contains(document.activeElement) && document.activeElement.classList.contains('card');
    const list = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Codex accounts' },
      state.profiles.map((p, i, all) => renderCard(p, i, all)));
    list.addEventListener('keydown', onListKey);
    const content = [
      renderConflicts(state.conflicts),
      renderLimitBanner(state.banner),
      list,
      h('button', { class: 'add-dashed', type: 'button', onClick: () => post('add') }, icon('plus'), 'Add another account'),
      h('div', { class: 'center' }, link('Add existing folder…', () => post('addExisting'))),
      renderFound(state.found),
      renderShared(state.shared),
    ];
    app.replaceChildren(...content.filter(Boolean));
    if (hadFocus && !confirming) {
      const el = app.querySelector(`.card[data-id="${CSS.escape(focusId || '')}"]`);
      if (el) el.focus();
    }
  }

  function cards() {
    return Array.from(app.querySelectorAll('.card'));
  }

  function onListKey(e) {
    const card = e.target.closest('.card');
    if (!card || e.target !== card) {
      if (e.key === 'Escape' && confirming) {
        const id = confirming;
        confirming = null;
        render();
        const el = app.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
        if (el) el.focus();
      }
      return;
    }
    const all = cards();
    const i = all.indexOf(card);
    const p = state.profiles.find((x) => x.id === card.dataset.id);
    const move = (j) => {
      const next = all[Math.max(0, Math.min(all.length - 1, j))];
      all.forEach((c) => c.setAttribute('tabindex', c === next ? '0' : '-1'));
      next.focus();
    };
    switch (e.key) {
      case 'ArrowDown': move(i + 1); break;
      case 'ArrowUp': move(i - 1); break;
      case 'Home': move(0); break;
      case 'End': move(all.length - 1); break;
      case 'Enter': case ' ': primaryAction(p); break;
      case 'F2': post('rename', { id: p.id }); break;
      case 'Delete': case 'Backspace': if (!p.builtin) post('remove', { id: p.id }); break;
      case 'Escape': if (confirming) { confirming = null; render(); } break;
      case 'ContextMenu': openMenu(card, card.querySelector('.more')); break;
      case 'F10': if (e.shiftKey) { openMenu(card, card.querySelector('.more')); break; } return;
      default: return;
    }
    e.preventDefault();
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'state') {
      state = msg.state;
      if (confirming && !state.profiles.some((p) => p.id === confirming && !p.chosen)) confirming = null;
      render();
    }
  });
  let timeZone = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (_) { /* unknown */ }
  post('ready', { timeZone });
}());
