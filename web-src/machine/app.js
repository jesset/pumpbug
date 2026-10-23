// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// State for api.js. The machine link currently provisions the machine
// (address + token); the live Bluetooth link ships separately and will
// report here once enabled.
let authed = false;
let status = null;
let scan = null;   // {running, machines[], error}
let cloud = null;  // {state, machines[], error}
let msg = null;    // {kind: ok|bad|busy, text}

const app = document.getElementById('app');

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === null || v === false || v === undefined) continue;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

function messageCard() {
  if (!msg) return null;
  return el('p', { class: `msg ${msg.kind}` }, msg.text);
}

function statusPanel() {
  if (!status) return null;
  const rows = [];
  const row = (dt, dd) => rows.push(el('div', { class: 'row' },
    el('dt', {}, dt), el('dd', {}, dd)));
  if (status.provisioned) {
    row('Machine', status.bleName || '—');
    row('Address', status.address || '—');
    row('Model', status.model || '—');
    row('Serial', status.serial || '—');
    row('Cloud token', status.tokenPresent ? 'stored' : 'missing');
  } else {
    row('Machine', 'not set up');
  }
  const state = status.provisioned
    ? (status.tokenPresent ? 'Ready' : 'Partially set up')
    : 'Not set up';
  return el('section', {},
    el('h2', {}, 'Machine'),
    el('div', { class: 'panel' },
      el('div', { class: 'connection-state', 'data-kind': status.tokenPresent ? 'ok' : '' },
        el('span', { class: 'connection-dot', 'aria-hidden': 'true' }), state),
      el('dl', {}, ...rows)));
}

function scanPanel() {
  const body = [];
  body.push(el('p', { class: 'note' },
    'The device discovers the machine over Bluetooth. Power the machine on, ' +
    'and make sure the La Marzocco app or Home Assistant is not connected ' +
    'to it — the machine talks to one Bluetooth client at a time.'));
  const button = el('button', {
    onclick: scanForMachines,
  }, scan && scan.running ? 'Scanning…' : 'Find the machine');
  if (scan && scan.running) button.disabled = true;
  body.push(button);
  if (scan && !scan.running && scan.machines && scan.machines.length) {
    const list = el('div', { class: 'pick-list', role: 'listbox' });
    for (const m of scan.machines) {
      list.append(el('button', {
        class: 'pick',
        onclick: () => selectMachine(m),
      },
        el('span', {}, m.name),
        el('span', { class: 'meta' }, `${m.address} · ${m.rssi} dBm`)));
    }
    body.push(list);
  }
  if (scan && !scan.running && scan.error) {
    body.push(el('p', { class: 'msg bad' }, scan.error));
  }
  return el('section', {},
    el('h2', {}, '1 · Find the machine'),
    el('div', { class: 'panel' }, ...body));
}

function accountPanel() {
  const body = [];
  body.push(el('p', { class: 'note' },
    'Sign in with the La Marzocco account the machine is registered to. ' +
    'Pump Bug contacts La Marzocco once, fetches the machine token, and ' +
    'keeps only that token — your username and password are not stored.'));
  const form = el('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      submitCredentials(f.username.value, f.password.value);
      f.password.value = '';
    },
  },
    el('label', { for: 'lm-user' }, 'Username (e-mail)'),
    el('input', { id: 'lm-user', name: 'username', type: 'text',
      autocomplete: 'username', autocapitalize: 'none' }),
    el('label', { for: 'lm-pass' }, 'Password'),
    el('input', { id: 'lm-pass', name: 'password', type: 'password',
      autocomplete: 'current-password' }),
    el('button', { type: 'submit',
      disabled: cloud && cloud.state === 'running' },
      cloud && cloud.state === 'running' ? 'Signing in…' : 'Sign in'));
  body.push(form);

  if (cloud && cloud.state === 'done') {
    const list = el('div', { class: 'pick-list' });
    for (const m of cloud.machines) {
      list.append(el('button', { class: 'pick', onclick: () => chooseMachine(m) },
        el('span', {}, `${m.name || m.serial} · ${m.model || ''}`),
        el('span', { class: 'meta' },
          `${m.serial} · token ${m.tokenPresent ? 'available' : 'missing'}`)));
    }
    body.push(el('h2', { style: 'margin-top:16px' }, 'Your machines'));
    body.push(list);
  }
  if (cloud && cloud.state === 'failed') {
    body.push(el('p', { class: 'msg bad' },
      CLOUD_ERROR_TEXT[cloud.error] || 'Sign-in failed.'));
  }

  const manual = el('details', { class: 'manual' },
    el('summary', {}, 'Enter a token manually instead'),
    el('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        submitToken(f.token.value.trim(), f.serial.value.trim());
      },
    },
      el('label', { for: 'lm-token' }, 'Bluetooth token (bleAuthToken)'),
      el('input', { id: 'lm-token', name: 'token', type: 'text' }),
      el('label', { for: 'lm-serial' }, 'Machine serial'),
      el('input', { id: 'lm-serial', name: 'serial', type: 'text' }),
      el('button', { type: 'submit' }, 'Save token')));
  body.push(manual);

  return el('section', {},
    el('h2', {}, '2 · Sign in to La Marzocco'),
    el('div', { class: 'panel' }, ...body));
}

function dangerPanel() {
  if (!status || !status.provisioned) return null;
  return el('section', {},
    el('h2', {}, 'Forget'),
    el('div', { class: 'panel danger' },
      el('p', { class: 'note' },
        'Erases the stored machine address and token. Shots already saved ' +
        'are not affected.'),
      el('button', {
        class: 'danger',
        onclick: () => {
          if (confirm('Forget the La Marzocco machine?')) forgetMachine();
        },
      }, 'Forget machine')));
}

function render() {
  app.replaceChildren();
  if (!authed) {
    app.append(el('p', { class: 'muted' },
      'Pair this browser with Pump Bug first (open the device home page).'));
    return;
  }
  const message = messageCard();
  if (message) app.append(message);
  app.append(statusPanel() || el('span'));
  app.append(scanPanel());
  app.append(accountPanel());
  const danger = dangerPanel();
  if (danger) app.append(danger);
}

refresh();
