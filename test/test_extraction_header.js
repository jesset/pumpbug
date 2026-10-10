#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const [livePath, appPath, constantsPath, streamPath] = process.argv.slice(2);
if (!livePath || !appPath || !constantsPath || !streamPath) {
  throw new Error('usage: test_extraction_header.js UI_LIVE_JS APP_JS CONSTANTS_JS STREAM_JS');
}

function harness() {
  const elements = new Map(['connection', 'connection-summary', 'connection-label',
    'connection-detail', 'banner', 'banner-message', 'banner-action']
    .map(id => [id, { textContent: '', dataset: {}, hidden: false, open: false }]));
  const streams = [];
  const timers = new Map();
  let timerId = 0;
  const context = {
    console, AbortController,
    document: { getElementById: id => elements.get(id), activeElement: null },
    historyStore: { subscribe() {}, sessionStarted() {} },
    invalidateDeviceTarget() {}, metadataStreamSessionStarted() {},
    setTimeout(callback, ms) {
      timers.set(++timerId, { callback, ms });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    EventSource: class {
      constructor() { this.listeners = {}; streams.push(this); }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      close() { this.closed = true; }
    },
    fetch: async () => ({ ok: true, json: async () => ({ url: '/events' }) }),
  };
  elements.get('connection-summary').focus = () => {
    context.document.activeElement = elements.get('connection-summary');
  };
  vm.createContext(context);
  const app = fs.readFileSync(appPath, 'utf8');
  assert.match(app, /\nconnect\(\);\s*$/,
    'Header harness expects app.js to end with connect(); so it can suppress startup.');
  vm.runInContext([constantsPath, streamPath, livePath]
    .map(path => fs.readFileSync(path, 'utf8')).join('\n') + '\n' +
    app.replace(/\nconnect\(\);\s*$/, '') +
    '\nglobalThis.setState = next => { state = next; streamStateCurrent = true; };' +
    '\nglobalThis.setMismatch = message => { protocolMismatch = message; };' +
    '\nglobalThis.setView = next => { view = next; };' +
    '\nglobalThis.currentView = () => view;', context);
  context.setState({ active: true, phase: 'IDLE', scale: 'connected' });
  return { context, streams, timers, get: id => elements.get(id) };
}

function liveRenderHarness() {
  const h = harness();
  const { context } = h;
  const doc = context.document;
  doc.body = {};
  doc.activeElement = doc.body;
  let controls = [];
  let specs = [];
  const app = {
    contains: target => controls.includes(target),
    replaceChildren() {
      if (this.contains(doc.activeElement)) doc.activeElement = doc.body;
      controls = [];
    },
    querySelectorAll: () => controls,
  };
  const getElementById = doc.getElementById;
  doc.getElementById = id => id === 'app' ? app : getElementById(id);
  function populate() {
    controls = specs.map(spec => ({
      ...spec,
      getAttribute: name => spec.attrs?.[name] ?? null,
      getClientRects: () => spec.hidden ? [] : [{}],
      closest: () => spec.inert ? {} : null,
      focus(options) { doc.activeElement = this; this.focusOptions = options; },
    }));
  }
  context.renderTabs = () => {};
  context.appendStorageWarning = () => {};
  context.synchronizeMetadataOverlayState = () => {};
  context.renderLive = populate;
  context.renderCoffeeContext = populate;
  context.renderList = populate;
  context.rememberHistoryListPosition = () => {};
  return { ...h, app, setControls: next => { specs = next; },
    controls: () => controls };
}

test('Tab buttons pass navigation intent even when they do not receive focus', () => {
  const h = harness();
  h.context.el = (tag, attrs = {}, ...children) => ({ tag, attrs, children });
  h.context.uiIcon = () => null;
  const navigation = [];
  h.context.switchView = (next, options) => navigation.push({ next, fromTab: options.fromTab });
  const app = { append(tabs) { this.tabs = tabs; } };
  h.context.renderTabs(app);
  for (const button of app.tabs.children) button.attrs.onclick();
  assert.deepEqual(navigation, [
    { next: 'live', fromTab: true },
    { next: 'list', fromTab: true },
  ]);
  assert.equal(h.context.document.activeElement, null);
});

test('Live updates retain a control across label changes without scrolling', () => {
  const h = liveRenderHarness();
  h.setControls([{ attrs: { 'data-overlay-return-key': 'shot-details-7' },
    label: 'Load shot details' }]);
  h.context.render();
  h.controls()[0].focus();
  h.setControls([{ attrs: { 'data-overlay-return-key': 'shot-details-7' },
    label: 'Edit shot details' }]);
  h.context.render();
  assert.equal(h.context.document.activeElement, h.controls()[0]);
  assert.equal(h.context.document.activeElement.focusOptions.preventScroll, true);
});

test('Live retains tabs and disclosures, including keys with quotes', () => {
  for (const key of ['live-tab', 'previous-coffee-"quoted"\\coffee']) {
    const h = liveRenderHarness();
    h.setControls([{ attrs: { 'data-live-focus-key': key } }]);
    h.context.render();
    h.controls()[0].focus();
    h.context.render();
    assert.equal(h.context.document.activeElement, h.controls()[0]);
  }
});

test('Live does not restore a vanished or unavailable control', () => {
  for (const next of [[], [{ disabled: true }], [{ hidden: true }],
    [{ inert: true }]]) {
    const h = liveRenderHarness();
    const attrs = { 'data-live-focus-key': 'apply-recipe-target' };
    h.setControls([{ attrs }]);
    h.context.render();
    h.controls()[0].focus();
    h.setControls(next.map(spec => ({ ...spec, attrs: { ...attrs, ...spec.attrs } })));
    h.context.render();
    assert.equal(h.context.document.activeElement, h.context.document.body);
  }
});

test('Live retains focus on a busy search control that remains keyboard focusable', () => {
  const h = liveRenderHarness();
  const attrs = { 'data-live-focus-key': 'search-coffee-history' };
  h.setControls([{ attrs, label: 'Search older history' }]);
  h.context.render();
  h.controls()[0].focus();
  h.setControls([{ attrs: { ...attrs, 'aria-disabled': 'true' }, label: 'Loading…' }]);
  h.context.render();
  assert.equal(h.context.document.activeElement, h.controls()[0]);
});

test('Live leaves focus outside the app alone', () => {
  const h = liveRenderHarness();
  h.setControls([{ attrs: { 'data-overlay-return-key': 'adjust-recipe' } }]);
  h.context.render();
  const outside = {};
  h.context.document.activeElement = outside;
  h.context.render();
  assert.equal(h.context.document.activeElement, outside);
});

test('Live actions keep focus through loading updates and a failed request', () => {
  for (const attrs of [
    { 'data-live-focus-key': 'apply-recipe-target' },
    { 'data-overlay-return-key': 'shot-details-7' },
    { 'data-live-focus-key': 'retry-coffee-history' },
  ]) {
    const h = liveRenderHarness();
    h.setControls([{ attrs }]);
    h.context.render();
    h.controls()[0].focus();
    h.setControls([{ attrs: { ...attrs, 'aria-disabled': 'true', 'aria-busy': 'true' } }]);
    for (let i = 0; i < 2; ++i) {
      h.context.render();
      assert.equal(h.context.document.activeElement, h.controls()[0]);
    }
    h.setControls([{ attrs }]);
    h.context.render();
    assert.equal(h.context.document.activeElement, h.controls()[0]);
    assert.equal(h.controls()[0].focusOptions.preventScroll, true);
  }
});

test('shared tabs retain focus when switching views in either direction', () => {
  for (const [from, to, key] of [
    ['live', 'list', 'history-tab'], ['list', 'live', 'live-tab'],
    ['detail', 'list', 'history-tab'],
  ]) {
    const h = liveRenderHarness();
    h.context.setView(from);
    h.context.renderDetail = h.context.renderLive;
    h.setControls([{ attrs: { 'data-view-focus-key': key } }]);
    h.context.render();
    h.controls()[0].focus();
    h.context.setView(to);
    h.context.render();
    assert.equal(h.context.document.activeElement, h.controls()[0]);
    assert.equal(h.controls()[0].focusOptions.preventScroll, true);
    h.context.render();
    assert.equal(h.context.document.activeElement, h.controls()[0]);
  }
});

test('Live does not take focus back when synchronization opens an editor', () => {
  const h = liveRenderHarness();
  h.setControls([{ attrs: { 'data-overlay-return-key': 'adjust-recipe' } }]);
  h.context.render();
  h.controls()[0].focus();
  const editor = {};
  h.context.synchronizeMetadataOverlayState = () => {
    h.context.document.activeElement = editor;
  };
  h.context.render();
  assert.equal(h.context.document.activeElement, editor);
});

test('Live retains Choose coffee while waiting for the first device state', () => {
  const h = liveRenderHarness();
  h.context.setState(null);
  h.setControls([{ attrs: { 'data-overlay-return-key': 'choose-coffee' } }]);
  h.context.render();
  h.controls()[0].focus();
  h.context.render();
  assert.equal(h.context.document.activeElement, h.controls()[0]);
});

test('Live focus restoration leaves other views to their own focus handling', () => {
  const h = liveRenderHarness();
  h.context.setView('detail');
  h.context.renderDetail = h.context.renderLive;
  h.setControls([{ attrs: { 'data-overlay-return-key': 'shot-details-7' } }]);
  h.context.render();
  h.controls()[0].focus();
  h.context.render();
  assert.equal(h.context.document.activeElement, h.context.document.body);
});

test('healthy status stays compact and keeps an open explanation across updates', () => {
  const { context, get } = harness();
  get('connection').open = true;
  context.renderBanner();
  assert.equal(get('connection-label').textContent, 'Connected');
  assert.equal(get('connection').dataset.kind, 'connected');
  assert.equal(get('banner-action').hidden, true);
  assert.equal(get('banner').hidden, true);
  assert.match(get('connection-detail').textContent, /Device ready · Scale connected/);
  context.setState({ active: true, phase: 'POST_PUMP', scale: 'connected' });
  context.renderBanner();
  assert.equal(get('connection-label').textContent, 'Finishing');
  assert.equal(get('connection').open, true);
  context.setState({ active: false, phase: 'IDLE', scale: 'off' });
  context.renderBanner();
  assert.equal(get('connection-label').textContent, 'Device idle');
  assert.equal(get('connection').dataset.kind, 'idle');
  assert.match(get('connection-detail').textContent, /Extraction screen is not open/);
});

test('stream callbacks keep routine progress in the header and clear it after recovery', async () => {
  const { context, streams, get } = harness();
  context.setState(null);
  await context.connect();
  assert.equal(get('connection-label').textContent, 'Connecting…');
  assert.equal(get('banner').hidden, true);
  streams[0].onopen();
  assert.equal(get('connection-detail').textContent, 'Connected, waiting for device state.');
  streams[0].onerror();
  assert.equal(get('connection-label').textContent, 'Reconnecting…');
  assert.equal(get('banner').hidden, true);
  context.setState({ active: true, phase: 'IDLE', scale: 'connected' });
  context.renderBanner();
  assert.equal(get('connection-label').textContent, 'Connected');
  assert.equal(get('banner').hidden, true);
});

test('stream callbacks preserve action feedback without masking the connection header', () => {
  const { context, streams, get } = harness();
  context.flashBanner('Shot details saved.', 'ok');
  context.openStream('/events');
  streams[0].onerror();
  assert.equal(get('connection-label').textContent, 'Reconnecting…');
  assert.equal(get('banner-message').textContent, 'Shot details saved.');
  assert.equal(get('banner').hidden, false);
  context.renderBanner();
  assert.equal(get('banner-message').textContent, 'Shot details saved.');
});

test('replaced stream offers an explicit reconnect without scheduling one', async () => {
  const { context, streams, timers, get } = harness();
  context.openStream('/events');
  streams[0].listeners.replaced();
  assert.equal(streams[0].closed, true);
  assert.equal(timers.size, 0);
  assert.equal(get('connection-label').textContent, 'Connection taken over');
  assert.equal(get('connection').dataset.kind, 'warn');
  assert.equal(get('banner').hidden, false);
  assert.match(get('banner-message').textContent, /Another browser took over/);
  const button = get('banner-action');
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Reconnect');
  assert.equal(get('connection').open, false,
    'Reconnect should be available without opening the status popup');
  const detail = get('connection-detail');
  context.renderBanner();
  assert.equal(get('connection-detail'), detail);
  assert.equal(get('banner-action'), button);
  assert.equal(button.hidden, false);
  context.setView('detail');
  context.location = { reload() { throw new Error('Reconnect must not reload the page.'); } };
  context.document.activeElement = button;
  await button.onclick();
  assert.equal(streams.length, 2, 'Reconnect did not request a new stream');
  assert.equal(context.currentView(), 'detail', 'Reconnect changed the selected view');
  assert.equal(get('connection-label').textContent, 'Reconnecting…');
  assert.equal(button.hidden, true);
  assert.equal(button.onclick, null);
  assert.equal(context.document.activeElement, get('connection-summary'),
    'hiding Reconnect lost keyboard focus instead of returning it to the status');
  streams[1].onopen();
  context.setState({ active: true, phase: 'IDLE', scale: 'connected' });
  context.renderBanner();
  assert.equal(get('connection-label').textContent, 'Connected');
  assert.equal(get('banner').hidden, true);
  assert.equal(button.hidden, true);
});

test('clearing the recovery action preserves focus elsewhere on the page', () => {
  const { context, streams, get } = harness();
  context.openStream('/events');
  streams[0].listeners.replaced();
  const otherControl = {};
  context.document.activeElement = otherControl;
  context.setState({ active: true, phase: 'IDLE', scale: 'connected' });
  context.renderBanner();
  assert.equal(get('banner').hidden, true);
  assert.equal(get('banner-action').hidden, true);
  assert.equal(get('banner-action').onclick, null);
  assert.equal(context.document.activeElement, otherControl,
    'a status update stole focus from another control');
});

test('ticket failures show the actual problem while retaining automatic retries', async () => {
  for (const [status, label, message] of [
    [401, 'Pairing required', /Not paired/],
    [500, 'Connection error', /HTTP 500.*retrying/],
  ]) {
    const { context, timers, get } = harness();
    context.fetch = async () => ({ ok: false, status });
    await context.connect();
    assert.equal(get('connection-label').textContent, label);
    assert.equal(get('connection').dataset.kind, 'bad');
    assert.equal(get('banner').hidden, false);
    assert.match(get('banner-message').textContent, message);
    assert.equal(timers.size, 1, 'ticket failure must still schedule a retry');
  }
});

test('sleep notification stays compact and protocol errors remain prominent', () => {
  const { context, streams, get } = harness();
  context.openStream('/events');
  streams[0].listeners.sleeping();
  assert.equal(get('connection-label').textContent, 'Device sleeping');
  assert.equal(get('banner').hidden, true);
  assert.equal(get('connection-detail').textContent,
    'The device is sleeping. Wake it to reconnect.');
  context.setMismatch('Unsupported stream version');
  context.renderBanner();
  assert.equal(get('connection-label').textContent, 'Incompatible');
  assert.equal(get('banner-message').textContent, 'Unsupported stream version');
  assert.equal(get('banner').hidden, false);
  context.setMismatch(null);
  context.setState({ active: true, phase: 'IDLE', scale: 'connected' });
  context.renderBanner();
  assert.equal(get('banner').hidden, true);
});

test('failed ticket retries retain their explanation until the stream opens', async () => {
  for (const status of [401, 500]) {
    const { context, streams, get } = harness();
    context.fetch = async () => ({ ok: false, status });
    await context.connect();
    const label = get('connection-label').textContent;
    const message = get('banner-message').textContent;
    let reply;
    context.fetch = () => new Promise(resolve => { reply = resolve; });
    const retry = context.connect();
    assert.equal(get('connection-label').textContent, label);
    assert.equal(get('banner-message').textContent, message);
    assert.equal(get('banner').hidden, false);
    reply({ ok: false, status });
    await retry;
    assert.equal(get('banner-message').textContent, message);
    assert.equal(get('banner').hidden, false);
    const recovery = context.connect();
    assert.equal(get('banner').hidden, false);
    reply({ ok: true, json: async () => ({ url: '/events' }) });
    await recovery;
    assert.equal(get('banner').hidden, false, 'a ticket alone does not open the stream');
    streams[0].onopen();
    assert.equal(get('connection-label').textContent, 'Connecting…');
    assert.equal(get('banner').hidden, true);
    context.setState({ active: true, phase: 'IDLE', scale: 'connected' });
    context.renderBanner();
    assert.equal(get('connection-label').textContent, 'Connected');
    assert.equal(get('banner').hidden, true);
  }
});

test('a timed-out retry keeps the previous error visible while waiting', async () => {
  const { context, timers, get } = harness();
  context.fetch = async () => ({ ok: false, status: 500 });
  await context.connect();
  const message = get('banner-message').textContent;
  context.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const retry = context.connect();
  assert.equal(get('banner-message').textContent, message);
  assert.equal(get('banner').hidden, false);
  const timeout = [...timers.values()].find(timer => timer.ms === 10000);
  assert(timeout, 'retry must retain its request timeout');
  timeout.callback();
  await retry;
  assert.equal(get('connection-label').textContent, 'Connection error');
  assert.equal(get('banner').hidden, false);
  assert.equal(get('banner-message').textContent, 'Ticket request timed out; retrying.');
});

test('wake polling explains lost contact without exposing its debug reason', () => {
  for (const firstPacketSeen of [false, true]) {
    const { context, streams, timers, get } = harness();
    context.openStream('/events');
    streams[0].onopen();
    if (firstPacketSeen) {
      vm.runInContext('currentStream.firstPacketSeen = true; armIdleTimer(currentStream);',
        context);
    }
    assert.equal(timers.size, 1);
    [...timers.values()][0].callback();
    assert.equal(get('connection-label').textContent, 'Disconnected');
    assert.equal(get('connection-detail').textContent,
      'Lost contact with the device; waiting for it to respond.');
    assert.equal(get('banner').hidden, true);
  }
});

test('scale recovery updates the status without replacing the header elements', () => {
  const { context, get } = harness();
  const label = get('connection-label');
  context.setState({ active: true, phase: 'IDLE', scale: 'reconnecting' });
  context.renderBanner();
  assert.equal(label.textContent, 'Scale reconnecting');
  assert.equal(get('connection').dataset.kind, 'warn');
  context.setState({ active: true, phase: 'RUNNING', scale: 'connected' });
  context.renderBanner();
  assert.equal(get('connection-label'), label);
  assert.equal(label.textContent, 'Recording');
});
