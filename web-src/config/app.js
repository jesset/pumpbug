// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

let authed = null;
let status = null;
let msg = null;
let nets;  // undefined: no scan yet; null: scan running; array: results
let selectedSsid = null;
let manualEntry = false;
let changingNetwork = false;
// Shows a pairing confirmation for visits from the pairing QR. Remove the
// hash so reloading doesn't repeat it, and check authentication before
// showing success.
let justPaired = location.hash === '#paired';
if (justPaired) {
  history.replaceState(null, '', location.pathname + location.search);
}
// True once AP-mode setup has sent Wi-Fi credentials: the action moves to
// the device screen, so the page parks on a hand-off panel.
let staSent = false;
// This client's paired auth_token cookie, or null until the user reveals it.
// It's a bearer credential, so it stays off-screen until asked for.
let cliToken = null;

function el(tag, attrs, ...kids) {
  attrs = attrs || {};
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k.slice(0, 2) === 'on') {
      e.addEventListener(k.slice(2), attrs[k]);
    } else {
      e.setAttribute(k, attrs[k]);
    }
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function renderMsg() {
  return msg ? el('div', { class: 'msg ' + msg.kind }, msg.text) : null;
}

function configIcon(name) {
  const paths = {
    pair: 'M8 11V7a4 4 0 0 1 8 0v4M5 11h14v10H5V11Zm7 4v2',
    wifi: 'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M12 20h.01',
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({
    class: 'ui-icon', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.6',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(key, value);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', paths[name]);
  svg.append(path);
  return svg;
}

// Copies text to the clipboard. The device serves plain HTTP on the LAN, so
// navigator.clipboard is usually absent (non-secure context); fall back to a
// throwaway textarea + execCommand, which works there.
function copyText(text) {
  const done = () => { msg = { kind: 'ok', text: 'Copied to clipboard.' }; render(); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => execCopy(text, done));
  } else {
    execCopy(text, done);
  }
}

function execCopy(text, done) {
  const ta = el('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (_) {
    msg = { kind: 'warn', text: 'Select the command and copy it manually.' };
    render();
  }
  ta.remove();
}

function renderUnauth() {
  const helpOpen = document.getElementById('pairing-help')?.open;
  const onSubmit = (e) => {
    e.preventDefault();
    const v = e.target.pin.value.trim();
    if (v.length === 4) submitPin(v);
  };
  const onInput = (e) => {
    if (e.target.value.length >= 4) {
      e.target.value = e.target.value.slice(0, 4);
      submitPin(e.target.value);
    }
  };
  return el('section', { class: 'panel pairing' },
    el('h2', {}, configIcon('pair'), 'Pair this browser'),
    el('ol', { class: 'pairing-steps' },
      el('li', {}, 'On Pump Bug, open Wi-Fi and tap A for VISIT.'),
      el('li', {}, 'Tap A for TEXT to see the PIN.')),
    el('form', { onsubmit: onSubmit },
      el('label', { for: 'pin', class: 'pin-label' }, '4-digit PIN'),
      el('input', {
        class: 'pin',
        id: 'pin',
        type: 'text',
        name: 'pin',
        inputmode: 'numeric',
        pattern: '[0-9]*',
        maxlength: '4',
        autocomplete: 'off',
        autofocus: 'true',
        oninput: onInput,
      })),
    renderMsg(),
    el('p', { class: 'muted pairing-qr' },
      'You can also pair by scanning the pairing QR code.'),
    el('details', { id: 'pairing-help', class: 'pairing-help', ...(helpOpen ? { open: '' } : {}) },
      el('summary', {}, 'If A shows RETRY'),
      el('p', { class: 'muted' },
        'Hold A for SETTINGS, choose Network, and follow setup to the pairing step.')),
  );
}

// ----- network picker -------------------------------------------------------

function signalDots(rssi) {
  const n = rssi >= -50 ? 4 : rssi >= -60 ? 3 : rssi >= -70 ? 2 : 1;
  return '●'.repeat(n) + '○'.repeat(4 - n);
}

function renderPasswordPrompt(net) {
  const onSubmit = (e) => {
    e.preventDefault();
    const pass = e.target.pass ? e.target.pass.value : '';
    if (net.secure && !pass) return;
    submitSta(net.ssid, pass);
  };
  return el('form', { class: 'netpass', onsubmit: onSubmit },
    net.secure
      ? el('label', { for: 'wifi-password' }, 'Password for ' + net.ssid)
      : null,
    net.secure
      ? el('input', {
          id: 'wifi-password',
          type: 'password',
          name: 'pass',
          autocomplete: 'new-password',
          autofocus: 'true',
        })
      : el('p', { class: 'muted' }, net.ssid + ' is an open network.'),
    el('button', { type: 'submit' }, 'Connect'),
  );
}

function renderManualForm() {
  const onSubmit = (e) => {
    e.preventDefault();
    const ssid = e.target.ssid.value.trim();
    if (ssid) submitSta(ssid, e.target.pass.value);
  };
  return el('div', {},
    el('form', { onsubmit: onSubmit },
      el('label', { for: 'wifi-ssid' }, 'Network name'),
      el('input', { id: 'wifi-ssid', type: 'text', name: 'ssid', autocomplete: 'off' }),
      el('label', { for: 'wifi-password' }, 'Password'),
      el('input', { id: 'wifi-password', type: 'password', name: 'pass',
                    autocomplete: 'new-password' }),
      el('button', { type: 'submit' }, 'Connect'),
    ),
    el('div', { class: 'actions' },
      el('button', {
        class: 'linklike',
        onclick: () => { manualEntry = false; render(); },
      }, 'Back to network list')),
  );
}

function renderNetworkPicker() {
  if (manualEntry) return renderManualForm();
  if (nets === undefined) scanNetworks();

  const kids = [];
  if (nets == null) {
    kids.push(el('p', { class: 'muted' }, 'Scanning for networks…'));
  } else if (!nets.length) {
    kids.push(el('p', { class: 'muted' }, 'No networks found.'));
  } else {
    const list = el('div', { class: 'netlist' });
    for (const n of nets) {
      const selected = n.ssid === selectedSsid;
      list.append(el('button', {
        class: 'net' + (selected ? ' selected' : ''),
        'aria-expanded': selected ? 'true' : 'false',
        onclick: () => {
          selectedSsid = selected ? null : n.ssid;
          render();
        },
      },
        el('span', { class: 'net-name' }, n.ssid),
        el('span', { class: 'sig', role: 'img',
          'aria-label': 'Signal strength: ' + n.rssi + ' dBm' }, signalDots(n.rssi))));
      if (selected) list.append(renderPasswordPrompt(n));
    }
    kids.push(list);
  }
  kids.push(el('div', { class: 'actions' },
    el('button', {
      class: 'linklike',
      onclick: () => { selectedSsid = null; scanNetworks(); },
    }, 'Rescan'),
    el('button', {
      class: 'linklike',
      onclick: () => { manualEntry = true; render(); },
    }, 'Enter name manually')));
  return el('div', {}, ...kids);
}

// ----- shared sections -------------------------------------------------------

function renderConnectionStatus() {
  const s = status || {};
  const hostname = s.hostname || s.device_id || '';
  const connection = {
    off: { label: 'Wi-Fi off', kind: 'idle' },
    sta_connecting: { label: 'Connecting…', kind: 'idle' },
    sta_connected: { label: 'Connected', kind: 'ok' },
    ap_up: { label: 'Setup network active', kind: 'idle' },
  }[s.state] || { label: 'Status unavailable', kind: 'idle' };
  const mode = { off: 'Off', sta: 'Wi-Fi network', ap: 'Setup network' }[s.mode];
  return el('div', {},
    el('div', { class: 'connection-state', 'data-kind': connection.kind },
      el('span', { class: 'connection-dot', 'aria-hidden': 'true' }),
      el('span', {}, connection.label)),
    el('p', { class: 'network-name' }, s.ssid || 'Network not reported'),
    el('dl', {},
      el('div', { class: 'row' }, el('dt', {}, 'Mode'),
        el('dd', {}, mode || '-')),
      el('div', { class: 'row' }, el('dt', {}, 'IP address'),
        el('dd', {}, s.ip || '-')),
      el('div', { class: 'row' }, el('dt', {}, 'Hostname'),
        el('dd', {}, hostname ? hostname + '.local' : '-'))),
  );
}

function renderHostnameSection() {
  const s = status || {};
  const hostname = s.hostname || s.device_id || '';
  const onSubmit = (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (name) submitHostname(name);
  };
  return el('section', {},
    el('h2', {}, 'Hostname'),
    el('p', { class: 'muted' },
      'The name used to open Pump Bug on your network. Changes take effect ' +
      'after the next Wi-Fi restart; pair again at the new name.'),
    el('form', { onsubmit: onSubmit },
      el('label', { for: 'hostname' }, 'Hostname'),
      el('input', { id: 'hostname', type: 'text', name: 'name',
                    value: hostname,
                    autocomplete: 'off',
                    pattern: '[A-Za-z0-9-]{1,31}',
                    maxlength: '31' }),
      el('button', { type: 'submit', class: 'secondary' }, 'Save hostname'),
    ),
  );
}

// Reveals this client's paired auth_token cookie so scripts and API clients
// can reuse the session without digging the HttpOnly cookie out of the
// browser. The cookie is only fetched (and shown) on request.
function renderCliAccessSection() {
  const body = [el('p', { class: 'muted' },
    'The device’s endpoints require this paired cookie. Reveal it to reuse ' +
    'the session from a script or the command line.')];
  if (cliToken == null) {
    body.push(el('button', { class: 'secondary', onclick: revealCliToken }, 'Show cookie'));
  } else {
    const box = el('textarea', {
      class: 'cli', readonly: 'true', rows: '2', 'aria-label': 'Paired session cookie',
      onclick: (e) => e.target.select(),
    });
    box.value = cliToken;
    body.push(box,
      el('div', { class: 'actions' },
        el('button', { class: 'linklike', onclick: () => copyText(cliToken) },
          'Copy'),
        el('button', {
          class: 'linklike',
          onclick: () => { cliToken = null; render(); },
        }, 'Hide')));
  }
  return el('section', {}, el('h2', {}, 'Command-line access'), ...body);
}

function renderResetSection() {
  return el('section', {},
    el('h2', {}, 'Reset'),
    el('button', { class: 'danger', onclick: forgetAll },
      'Forget Wi-Fi and unpair all clients'),
  );
}

function renderAdvanced({ setup = false } = {}) {
  const open = document.getElementById('advanced')?.open;
  return el('details', { id: 'advanced', class: 'advanced', ...(open ? { open: '' } : {}) },
    el('summary', {}, 'Advanced'),
    setup ? el('section', {}, el('h2', {}, 'Connection'), renderConnectionStatus()) : null,
    renderHostnameSection(),
    setup ? null : renderCliAccessSection(),
    renderResetSection());
}

// ----- top-level views --------------------------------------------------------

// AP mode: the device is waiting to be pointed at a network, so the page is
// a single guided step. Everything else hides behind Advanced.
function renderSetup() {
  if (staSent) {
    const host = (status && status.hostname) ||
                 (status && status.device_id) || 'pumpbug';
    return el('div', {},
      el('section', { class: 'panel' },
        el('h2', {}, configIcon('wifi'), 'Return to your Wi-Fi'),
        el('p', {},
          'Wi-Fi details sent. Reconnect this phone or computer to your ' +
          'usual Wi-Fi, then use the link below.'),
        el('a', {
          class: 'primary-action',
          href: 'http://' + host + '.local/',
        }, 'Open the Pump Bug web app')),
      renderMsg());
  }
  return el('div', {},
    el('section', { class: 'panel' },
      el('h2', {}, configIcon('wifi'), 'Connect to your Wi-Fi'),
      el('p', { class: 'muted' },
        'Choose the Wi-Fi network for Pump Bug. Your browser will disconnect ' +
        'while Pump Bug joins it.'),
      renderNetworkPicker()),
    renderMsg(),
    renderAdvanced({ setup: true }),
  );
}

// STA mode: routine management, status first.
function renderManage() {
  const s = status || {};
  const failureBanner = (s.reason && s.reason !== '')
    ? el('div', { class: 'msg bad' },
        'Last Wi-Fi attempt: ' + s.reason)
    : null;
  return el('div', {},
    el('section', { class: 'panel' },
      el('h2', {}, configIcon('wifi'), 'Wi-Fi'),
      renderConnectionStatus()),
    failureBanner,
    el('section', { class: 'panel' },
      el('h2', {}, 'Network'),
      changingNetwork
        ? renderNetworkPicker()
        : el('button', {
            class: 'secondary',
            onclick: () => { changingNetwork = true; render(); },
          }, 'Change network')),
    renderMsg(),
    renderAdvanced(),
  );
}

function renderAuth() {
  const s = status || {};
  return staSent || s.mode === 'ap' ? renderSetup() : renderManage();
}

function render() {
  const app = document.getElementById('app');
  const deviceName = document.getElementById('device-name');
  let view;
  if (authed === null) {
    view = el('p', { class: 'muted' }, 'Loading…');
  } else if (authed) {
    view = renderAuth();
  } else {
    view = renderUnauth();
  }
  app.replaceChildren(view);
  const deviceId = status && status.device_id;
  deviceName.textContent = deviceId || '';
  deviceName.hidden = !deviceId;
  document.title = 'Pairing & Wi-Fi · ' + (deviceId || 'Pump Bug');
  const focus = app.querySelector('input.pin, .netpass input');
  if (focus) focus.focus();
}

refresh();
