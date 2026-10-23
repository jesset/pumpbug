// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// API helpers for the La Marzocco setup page. State variables (authed,
// status, msg, …) live in app.js; only called there.

const SCAN_POLL_INTERVAL_MS = 1500;
const SCAN_POLL_DEADLINE_MS = 14000;
const CLOUD_POLL_INTERVAL_MS = 3000;
const CLOUD_POLL_DEADLINE_MS = 75000;

let scanPollToken = 0;
let cloudPollToken = 0;

async function api(path, opts) {
  opts = opts || {};
  const fetchOpts = Object.assign({}, opts);
  delete fetchOpts.timeoutMs;
  let timeoutId = null;
  if (opts.timeoutMs && typeof AbortController !== 'undefined') {
    const controller = new AbortController();
    fetchOpts.signal = controller.signal;
    timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
  }
  try {
    const r = await fetch(path, fetchOpts);
    let body = {};
    try { body = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, body };
  } catch (_) {
    // Timeout or network failure: report as a failed response instead of
    // throwing, so polling loops can keep waiting instead of dying silently.
    return { ok: false, status: 0, body: {} };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function refresh() {
  const who = await api('/auth/whoami');
  authed = !!who.body.authenticated;
  if (authed) {
    const s = await api('/app/machine/status');
    status = s.ok ? s.body : null;
    if (!cloud) {
      // Surface a finished cloud run the page did not observe (e.g. after a
      // reload), so the machine list is not lost.
      const c = await api('/app/machine/cloud');
      if (c.ok && c.body.state === 'done') {
        cloud = { state: 'done', machines: c.body.machines || [], error: null };
      }
    }
  } else {
    status = null;
  }
  render();
}

// Start the device-side discovery scan, then poll until it reports machines
// or the deadline passes. The endpoint reuses the diagnostics scan, which
// yields to an in-use scale connection.
async function scanForMachines() {
  const token = ++scanPollToken;
  scan = { running: true, machines: [] };
  render();
  const start = await api('/app/machine/scan', { method: 'POST', timeoutMs: 8000 });
  if (!start.ok) {
    scan = { running: false, machines: [], error: 'Scan could not start (scale in use?)' };
    render();
    return;
  }
  const deadline = Date.now() + SCAN_POLL_DEADLINE_MS;
  let best = [];
  while (Date.now() < deadline && token === scanPollToken) {
    await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_INTERVAL_MS));
    if (token !== scanPollToken) return;
    const r = await api('/app/machine/scan', { cache: 'no-store', timeoutMs: 4000 });
    if (!r.ok) continue;
    best = r.body.machines || [];
    if (!r.body.active && best.length >= 0) {
      // Scan lease ended; take whatever was discovered.
      break;
    }
  }
  if (token !== scanPollToken) return;
  scan = {
    running: false,
    machines: dedupeByAddress(best),
    error: dedupeByAddress(best).length ? null : 'No La Marzocco machine found. ' +
      'Make sure the machine is powered on and no phone app or Home Assistant ' +
      'is connected to it, then try again.',
  };
  render();
}

function dedupeByAddress(list) {
  const byAddress = new Map();
  for (const m of list) {
    const prev = byAddress.get(m.address);
    if (!prev || m.rssi > prev.rssi) byAddress.set(m.address, m);
  }
  return [...byAddress.values()].sort((a, b) => b.rssi - a.rssi);
}

async function selectMachine(entry) {
  msg = { kind: 'busy', text: 'Saving…' };
  render();
  const r = await api('/app/machine/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: entry.address, name: entry.name }),
    timeoutMs: 8000,
  });
  msg = r.ok
    ? { kind: 'ok', text: 'Machine saved. Continue with the account sign-in.' }
    : { kind: 'bad', text: 'Could not save the machine.' };
  await refresh();
}

async function submitCredentials(username, password) {
  msg = { kind: 'busy', text: 'Contacting La Marzocco…' };
  render();
  const r = await api('/app/machine/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    timeoutMs: 10000,
  });
  if (!r.ok) {
    msg = { kind: 'bad', text: r.body && r.body.message
      ? r.body.message : 'Sign-in could not start.' };
    render();
    return;
  }
  pollCloud();
}

async function pollCloud() {
  const token = ++cloudPollToken;
  cloud = { state: 'running', machines: [], error: null };
  render();
  const deadline = Date.now() + CLOUD_POLL_DEADLINE_MS;
  while (Date.now() < deadline && token === cloudPollToken) {
    await new Promise((resolve) => setTimeout(resolve, CLOUD_POLL_INTERVAL_MS));
    if (token !== cloudPollToken) return;
    const r = await api('/app/machine/cloud', { cache: 'no-store', timeoutMs: 10000 });
    if (!r.ok) continue;
    if (r.body.state === 'running') continue;
    if (r.body.state === 'done') {
      cloud = { state: 'done', machines: r.body.machines || [], error: null };
    } else {
      cloud = { state: 'failed', machines: [], error: r.body.error || 'failed' };
    }
    render();
    return;
  }
  if (token !== cloudPollToken) return;
  cloud = { state: 'failed', machines: [], error: 'timeout' };
  render();
}

const CLOUD_ERROR_TEXT = {
  offline: 'The device is offline or its clock is not set yet. Connect Wi-Fi and wait a minute.',
  no_clock: 'The device clock is not set yet; wait a minute and retry.',
  network: 'La Marzocco did not answer. Check the internet connection and retry.',
  auth_rejected: 'La Marzocco rejected the username or password.',
  parse: 'La Marzocco sent an unexpected response.',
  no_machine: 'This account has no coffee machine.',
  busy: 'A sign-in is already running.',
};

async function chooseMachine(machine) {
  msg = { kind: 'busy', text: 'Saving…' };
  render();
  const r = await api('/app/machine/choose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serial: machine.serial }),
    timeoutMs: 8000,
  });
  msg = r.ok
    ? { kind: 'ok', text: 'Machine token stored. Setup complete.' }
    : { kind: 'bad', text: 'Could not store the token.' };
  cloud = null;
  await refresh();
}

async function submitToken(token, serial) {
  msg = { kind: 'busy', text: 'Saving…' };
  render();
  const r = await api('/app/machine/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, serial }),
    timeoutMs: 8000,
  });
  msg = r.ok
    ? { kind: 'ok', text: 'Token stored.' }
    : { kind: 'bad', text: 'Could not store the token.' };
  await refresh();
}

async function forgetMachine() {
  msg = { kind: 'busy', text: 'Erasing…' };
  render();
  const r = await api('/app/machine/forget', { method: 'POST', timeoutMs: 8000 });
  msg = r.ok
    ? { kind: 'ok', text: 'Machine data erased.' }
    : { kind: 'bad', text: 'Could not erase machine data.' };
  await refresh();
}
