#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const [metadataPath, historyPath, constantsPath, streamPath, iconsPath] = process.argv.slice(2);
if (!metadataPath || !historyPath || !constantsPath || !streamPath || !iconsPath) {
  throw new Error('usage: test_history_coordinator.js UI_METADATA_JS UI_HISTORY_JS CONSTANTS_JS STREAM_JS UI_ICONS_JS');
}
const pageUrl = '/app/extraction/shots?limit=20&meta=1';
const source = fs.readFileSync(iconsPath, 'utf8') + '\n' +
  fs.readFileSync(constantsPath, 'utf8') + '\n' +
  fs.readFileSync(historyPath, 'utf8') + '\n' +
  fs.readFileSync(metadataPath, 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const harnesses = [];

function element(tag, attrs = {}, ...children) {
  return { tag, attrs, children, childNodes: children, dataset: {},
    setAttribute(name, value) { attrs[name] = value; },
    append(...more) { children.push(...more); }, addEventListener() {} };
}

function renderedHistory(h) {
  const root = element('main');
  h.context.renderList(root);
  return root;
}

function findElement(root, match) {
  if (!root) return null;
  if (match(root)) return root;
  for (const child of root.children || []) {
    if (typeof child !== 'object') continue;
    const found = findElement(child, match);
    if (found) return found;
  }
  return null;
}


function response(body, status = 200, headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: name => headers[name] || null },
    json: async () => JSON.parse(JSON.stringify(body)),
  };
}

function row(id, rating = 1) {
  return {
    id, userMetadataState: 'active', userMetadata: { rating },
    userMetadataCrc: rating, userMetadataEtag: 'metadata-' + id + '-' + rating,
  };
}

function harness({ automatic = false, restoredRecipe = null, deferredWrites = false, storage = null } = {}) {
  const pages = [];
  const reads = [];
  const writes = [];
  const banners = [];
  const transfers = new Set();
  let overlaps = 0;
  let now = 0;
  const context = {
    document: { querySelector: () => null, addEventListener() {}, createElementNS(namespace, tag) {
      return { ...element(tag), namespaceURI: namespace };
    } },
    console, TextEncoder, AbortController, el: element, state: { storage: 'ready' },
    performance: { now: () => now },
    inPumpWindow: state => !!state && state.active &&
      (state.phase === 'RUNNING' || state.phase === 'POST_PUMP'),
    lastRecord: null, selectedShot: null, selectedShotId: null,
    selectedShotMetadata: null, view: 'live',
    scheduleRender() {}, flashBanner: message => banners.push(message),
    localStorage: storage || {
      getItem: key => key === 'pumpbug.shot-details.v1' && restoredRecipe
        ? JSON.stringify({ nextShotRecipe: restoredRecipe }) : null,
      setItem() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nglobalThis.api = { historyStore, fetchWithTimeout,' +
    'setEditor: value => { metadataEditor = value; },' +
    'setSelected: id => { selectedShotId = id; },' +
    'editor: () => metadataEditor, last: () => lastShotMetadata,' +
    'setLast: value => { lastShotMetadata = value; }};', context);
  context.renderMetadataOverlay = () => {};
  let writeStatus = 200;
  context.fetchWithTimeout = async (url, options, consume, timeoutMs) => {
    if (url.startsWith(pageUrl)) {
      if ([...transfers].some(item => !item.signal.aborted)) ++overlaps;
      transfers.add(options);
      try {
        // Allow completion after abort to verify acceptance independently.
        const result = await new Promise((resolve, reject) => {
          pages.push({ url, options, resolve, reject, timeoutMs });
        });
        return await consume(result);
      } finally {
        transfers.delete(options);
      }
    }
    assert(url.startsWith('/app/extraction/shot-metadata?id='));
    if (!options.method) {
      return consume(await new Promise((resolve, reject) => {
        reads.push({ url, options, resolve, reject, timeoutMs });
      }));
    }
    if (deferredWrites) {
      return consume(await new Promise((resolve, reject) => {
        writes.push({ url, options, resolve, reject });
      }));
    }
    const cleared = options.method === 'DELETE';
    return consume(response(cleared ? {} : JSON.parse(options.body), writeStatus, {
      ETag: 'confirmed', 'X-Shot-Metadata-State': cleared ? 'cleared' : 'active',
      'X-Shot-Metadata-Crc': '99',
    }));
  };
  const store = context.api.historyStore;
  store.observeDeviceState('ready', false, automatic);

  function take(queue = pages) {
    assert.equal(queue.length, 1, 'expected one request');
    return queue.shift();
  }
  function reply(request, shots, etag = 'baseline', hasMore = false,
      total = shots.length, shotStoreNonce = null) {
    request.resolve(response({ shots, hasMore, total, shotStoreNonce }, 200, { ETag: etag }));
  }
  function replyMetadata(request, rating = 1, etag = 'old-metadata') {
    request.resolve(response(rating === null ? {} : { rating }, 200, {
      ETag: etag, 'X-Shot-Metadata-State': rating === null ? 'cleared' : 'active',
      'X-Shot-Metadata-Crc': rating === null ? '0' : String(rating),
    }));
  }
  async function load(shots, hasMore = false, total = shots.length) {
    const pending = store.ensureLoaded();
    reply(take(), shots, 'baseline', hasMore, total);
    assert.equal((await pending).status, 200);
  }
  async function write(kind, id, status = 200) {
    writeStatus = status;
    if (kind === 'initialize') await context.setLastShotMetadataId(id, { rating: 5 });
    else {
      const editor = { id, kind: 'shot', record: { etag: 'before' } };
      context.api.setEditor(editor);
      if (kind === 'clear') await context.clearShotMetadata(editor);
      else await context.writeShotMetadata(editor, { rating: 5 });
      if (status === 200) assert.equal(editor.error, null);
      else assert(editor.error);
    }
    writeStatus = 200;
  }
  harnesses.push(() => {
    assert.equal(overlaps, 0, 'overlapping history attempts');
    assert.equal(transfers.size, 0, 'unsettled history transfer');
    assert.equal(pages.length + reads.length + writes.length, 0, 'unconsumed mock requests');
  });
  return { store, context, pages, reads, writes, banners, take, reply, replyMetadata, load, write,
    advance: milliseconds => { now += milliseconds; } };
}

async function testPageWrites() {
  for (const kind of ['save', 'clear', 'initialize']) {
    const h = harness();
    await h.load([row(2), row(1)]);
    const refresh = h.store.refresh();
    const stale = h.take();
    await h.write(kind, 2);
    const expected = kind === 'clear' ? null : 5;
    h.reply(stale, [row(2), row(1)], 'obsolete');
    await flush();
    assert.equal(h.store.rows[0].userMetadata?.rating ?? null, expected,
      'an older page overwrote the confirmed metadata write');
    const retry = h.take();
    assert.equal(retry.options.headers['If-None-Match'], 'baseline');
    const current = kind === 'clear'
      ? { ...row(2), userMetadataState: 'cleared', userMetadata: null } : row(2, 5);
    h.reply(retry, [current, row(1)], 'current');
    await refresh;
    const conditional = h.store.refresh();
    const next = h.take();
    assert.equal(next.options.headers['If-None-Match'], 'current');
    next.resolve(response(null, 304));
    await conditional;
    assert.equal(h.store.rows[0].userMetadata?.rating ?? null, expected);
    assert.equal(h.store.rows[0].userMetadataState, kind === 'clear' ? 'cleared' : 'active');
    if (kind === 'clear') assert.equal(h.store.rows[0].userMetadata, null);
  }
}

async function testUncachedWritesAndConditionalResponses() {
  for (const initial of [true, false]) {
    const h = harness();
    if (!initial) await h.load([row(2)], true, 2);
    const operation = initial ? h.store.ensureLoaded() : h.store.loadMore();
    const stale = h.take();
    await h.write('save', 1);
    h.reply(stale, [row(1)], 'obsolete', false, initial ? 1 : 2);
    await flush();
    const retry = h.take();
    assert.equal(retry.url, stale.url);
    assert(initial ? h.store.rows === null : h.store.rows.length === 1);
    h.reply(retry, [row(1, 5)], 'current', false, initial ? 1 : 2);
    await operation;
    assert.equal(h.store.rows.at(-1).userMetadata.rating, 5);
  }
  const h = harness();
  await h.load([row(1)]);
  const pending = h.store.refresh();
  const conditional = h.take();
  await h.write('save', 1);
  conditional.resolve(response(null, 304));
  await flush();
  const retry = h.take();
  assert.equal(retry.options.headers['If-None-Match'], 'baseline');
  h.reply(retry, [row(1, 5)]);
  await pending;
}

async function testAutomaticDeferralAndPromotion() {
  for (const trigger of ['saved', 'reconnect', 'recipe']) {
    for (const explicit of [false, true]) {
      const h = harness({ automatic: true, restoredRecipe:
        trigger === 'recipe' ? { coffee: { name: 'Coffee' } } : null });
      if (trigger !== 'recipe') await h.load([row(2), row(1)]);
      h.store.observeDeviceState('ready', false, false);
      if (trigger === 'saved') h.store.shotSaved();
      else if (trigger === 'reconnect') h.store.sessionStarted();
      else {
        h.context.loadMetadataBrowserState();
        h.context.updateCoffeeContextHistoryForState({
          storage: 'ready', active: true, phase: 'RUNNING',
        });
      }
      assert.equal(h.pages.length, 0, 'automatic work started during pumping');
      let pending;
      if (explicit) pending = h.store.refreshPreservingRows();
      else {
        pending = h.store.observeDeviceState('ready');
        if (trigger === 'recipe') {
          pending = h.context.updateCoffeeContextHistoryForState({
            storage: 'ready', active: false, phase: 'IDLE',
          });
        }
      }
      h.reply(h.take(), [row(2), row(1)]);
      await pending;
      await flush();
      assert.equal(h.store.rows.length, 2);
      assert.equal(h.pages.length, 0);
    }
  }
}

async function testPaginationAndNotifications() {
  const h = harness({ automatic: true });
  await h.load([row(6), row(5)], true, 4);
  const older = h.store.loadMore();
  const page = h.take();
  // Notifications stay pending while background work is deferred.
  h.store.observeDeviceState('ready', false, false);
  h.store.shotSaved();
  h.store.shotSaved();
  h.reply(page, [row(4)], 'older', true, 4);
  await older;
  assert.equal(h.pages.length, 0);
  const background = h.store.observeDeviceState('ready');
  const first = h.take();
  h.store.shotSaved();
  h.store.shotSaved();
  h.reply(first, [row(7), row(6)], 'first', true, 5);
  await flush();
  h.reply(h.take(), [row(8), row(7)], 'second', true, 6);
  await background;
  assert.equal(h.store.rows.map(item => item.id).join(','), '8,7,6,5,4');
  assert.equal(h.pages.length, 0);
  const refresh = h.store.refreshPreservingRows();
  const queued = h.store.loadMore();
  h.reply(h.take(), [row(9), row(8)], 'third', true, 7);
  await refresh;
  await flush();
  const next = h.take();
  assert.equal(next.url, pageUrl + '&before=4');
  h.reply(next, [row(3)], 'older', false, 7);
  await queued;
}

async function testCancellationAndLateResponses() {
  for (const storage of [false, true]) {
    const h = harness({ automatic: true });
    await h.load([row(3), row(2)], true, 3);
    const refresh = h.store.refresh();
    const old = h.take();
    const older = h.store.loadMore();
    if (storage) h.store.observeDeviceState('unavailable');
    else h.store.sessionStarted();
    assert(old.options.signal.aborted);
    const recovery = h.store.observeDeviceState('ready');
    const replacement = h.take();
    assert.equal(replacement.options.headers['If-None-Match'], 'baseline');
    h.reply(replacement, [row(1)], 'new-session');
    await recovery;
    // Deliberately ignore abort in the mock and deliver the old response last.
    h.reply(old, [row(9)], 'obsolete');
    assert.equal((await refresh).status, 'cancelled');
    assert.equal((await older).status, 'cancelled');
    assert.equal(h.store.rows.map(item => item.id).join(','), '1');
    assert.equal(h.store.etagFor(pageUrl), 'new-session');
    const verify = h.store.refresh();
    const conditional = h.take();
    assert.equal(conditional.options.headers['If-None-Match'], 'new-session');
    conditional.resolve(response(null, 304));
    await verify;
  }
}

async function testFailuresAndExplicitRecovery() {
  const h = harness();
  await h.load([row(2)], true, 2);
  const refresh = h.store.refreshPreservingRows();
  const head = h.take();
  const older = h.store.loadMore();
  const error = new Error('first page unavailable');
  head.reject(error);
  assert.equal((await refresh).status, 'error');
  assert.equal((await older).status, 'error');
  assert.equal(h.pages.length, 0, 'pagination skipped a failed first page');
  assert.equal(h.store.error, error);

  // Load older repairs the first page before choosing a cursor.
  const retry = h.store.loadMore();
  const overtaken = h.take();
  assert.equal(overtaken.url, pageUrl);
  assert.equal(h.store.error, null);
  assert(h.store.loading);
  await h.write('save', 2);
  h.reply(overtaken, [row(3), row(2)], 'obsolete', true, 3);
  await flush();
  const repair = h.take();
  assert.equal(repair.url, pageUrl);
  h.reply(repair, [row(3), row(2, 5)], 'repaired', true, 3);
  await flush();
  const page = h.take();
  assert.equal(page.url, pageUrl + '&before=2');
  h.reply(page, [row(1)], 'older', false, 3);
  assert.equal((await retry).status, 200);
  assert.equal(h.store.error, null);
  assert.deepEqual(Array.from(h.store.rows, item => item.id), [3, 2, 1]);
}

async function testRetryProgress() {
  const h = harness();
  const loading = h.store.ensureLoaded();
  h.take().reject(new Error('offline'));
  await loading;
  assert.match(JSON.stringify(renderedHistory(h)), /could not be loaded/);
  const retry = h.store.retry();
  const stale = h.take();
  assert.equal(h.store.error, null);
  assert.match(JSON.stringify(renderedHistory(h)), /Loading shots/);
  assert(!JSON.stringify(renderedHistory(h)).includes('could not be loaded'));
  await h.write('save', 1);
  h.reply(stale, [row(1)], 'obsolete');
  await flush();
  assert.match(JSON.stringify(renderedHistory(h)), /Loading shots/);
  assert(h.store.loading);
  h.reply(h.take(), [row(1, 5)]);
  await retry;
  assert.equal(h.store.error, null);
  assert(!h.store.loading);
}

async function testReentrantInvalidation() {
  const h = harness({ automatic: true });
  await h.load([row(2)], true, 2);
  const previous = h.store.refresh();
  const obsolete = h.take();
  let replacement;
  let entered = false;
  const unsubscribe = h.store.subscribe(() => {
    if (entered || h.store.rowsAreCurrent) return;
    entered = true;
    replacement = h.store.ensureLoaded();
  });
  h.store.sessionStarted();
  unsubscribe();
  assert(obsolete.options.signal.aborted);
  let settled = false;
  replacement.then(() => { settled = true; });
  await flush();
  assert(!settled, 'invalidation cancelled work started by its subscriber');
  h.reply(h.take(), [row(1)], 'replacement');
  assert.equal((await replacement).status, 200);
  h.reply(obsolete, [row(99)], 'obsolete');
  assert.equal((await previous).status, 'cancelled');
  assert.equal(h.store.rows[0].id, 1);
  assert.equal(h.store.etagFor(pageUrl), 'replacement');
  assert(!h.store.loading);
}

async function testPaginationAfterOvertakenResponse() {
  const h = harness();
  const range = top => Array.from({ length: 20 }, (_, index) => row(top - index));
  await h.load(range(40), true, 40);
  const older = h.store.loadMore();
  const overtaken = h.take();
  assert.equal(overtaken.url, pageUrl + '&before=21');
  await h.write('save', 40);
  const refresh = h.store.refreshPreservingRows();
  h.reply(overtaken, range(20), 'obsolete', false, 40);
  await flush();
  const retry = h.take();
  assert.equal(retry.url, pageUrl + '&before=21');
  h.reply(retry, range(20), 'older', false, 40);
  assert.equal((await older).status, 200);
  await flush();
  h.reply(h.take(), range(80), 'replacement', true, 80);
  await refresh;
  assert.deepEqual(Array.from(h.store.rows, item => item.id),
    Array.from({ length: 20 }, (_, index) => 80 - index));
  const next = h.store.loadMore();
  const page = h.take();
  assert.equal(page.url, pageUrl + '&before=61');
  h.reply(page, range(60), 'next', true, 80);
  await next;
  assert.deepEqual(Array.from(h.store.rows, item => item.id),
    Array.from({ length: 40 }, (_, index) => 80 - index));
}

async function testDemandAndEventContracts() {
  const h = harness();
  await h.store.observeDeviceState('ready', false, false);
  await h.store.shotSaved();
  h.store.sessionStarted();
  assert.equal(h.pages.length, 0, 'device events loaded undemanded history');
  const explicit = h.store.ensureLoaded();
  h.reply(h.take(), [row(1)]);
  await explicit;
  let publications = 0;
  h.store.subscribe(() => { ++publications; });
  for (let i = 0; i < 3; ++i) await h.store.observeDeviceState('ready');
  assert.equal(publications, 0);
  assert.equal(h.pages.length, 0);
  h.store.sessionStarted();
  await h.store.observeDeviceState('ready', false, false);
  await h.store.shotSaved();
  assert.equal(h.pages.length, 0);
  const refresh = h.store.refresh();
  h.reply(h.take(), [row(1)]);
  await refresh;
  await h.store.observeDeviceState('ready');
  assert.equal(h.pages.length, 0);
}

async function testRecipeDemandLifecycle() {
  for (const action of ['restore', 'select', 'edit']) {
    const h = harness({ restoredRecipe: action === 'restore'
      ? { coffee: { name: 'Restored' } } : null });
    if (action === 'restore') {
      h.context.loadMetadataBrowserState();
      await h.context.updateCoffeeContextHistoryForState({
        storage: 'ready', active: true, phase: 'RUNNING',
      });
      assert.equal(h.pages.length, 0, 'restored recipe read history during pumping');
    }
    if (action === 'select') {
      h.context.openCoffeePicker();
      h.context.chooseCoffee({ name: 'Selected' });
      h.context.confirmCoffeeChoice({ elements: {
        'coffee.name': { value: 'Selected', disabled: false },
      } });
    }
    if (action === 'edit') {
      h.context.openNextShotEditor();
      const fields = ('coffee.name coffee.roaster coffee.origin coffee.roastDate ' +
        'coffee.roast coffee.process coffee.variety prep.grinder prep.grind ' +
        'prep.pressure prep.water prep.doseG prep.tempC tdsPct tags notes').split(' ');
      const elements = Object.fromEntries(fields.map(name =>
        [name, { value: name === 'coffee.name' ? 'Edited' : '', disabled: false }]));
      await h.context.saveMetadataEditor({ elements });
    }
    const loading = h.context.updateCoffeeContextHistoryForState({
      storage: 'ready', active: false, phase: 'IDLE',
    });
    h.reply(h.take(), [row(1)]);
    await loading;
    await flush();
    h.context.clearNextShotRecipe();
    const refresh = h.store.observeDeviceState('ready', true);
    h.reply(h.take(), [row(2), row(1)]);
    await refresh;
    assert.equal(h.store.rows.length, 2, 'registered demand did not persist');
  }
}

async function testIndividualMetadataFreshness() {
  for (const consumer of ['last', 'detail', 'editor']) {
    for (const write of ['save', 'clear', 'initialize']) {
      for (const failedRead of [false, true]) {
        const h = harness();
        await h.load([row(1)]);
        h.context.view = 'detail';
        h.context.api.setSelected(1);
        h.context.api.setLast({ id: 1, state: 'active', value: { rating: 1 } });
        const pending = consumer === 'last' ? h.context.setLastShotMetadataId(1)
          : consumer === 'detail' ? h.context.resolveShotMetadata(1)
          : h.context.loadShotMetadata({ id: 1 });
        const stale = h.take(h.reads);
        await h.write(write, 1);
        if (failedRead) stale.reject(new Error('late failure'));
        else h.replyMetadata(stale);
        await flush();
        const expected = write === 'clear' ? null : 5;
        for (const record of [h.context.api.last(), h.context.selectedShotMetadata]) {
          assert.equal(record.value?.rating ?? null, expected);
          assert.equal(record.etag, 'confirmed');
        }
        assert.equal(h.store.rows[0].userMetadata?.rating ?? null, expected);
        h.replyMetadata(h.take(h.reads), expected, 'revalidated');
        await pending;
        assert.equal(h.context.selectedShotMetadata.value?.rating ?? null, expected);
        assert.equal(h.context.selectedShotMetadata.etag, 'revalidated');
        assert.equal(h.store.rows[0].userMetadataEtag, 'revalidated');
        if (consumer === 'editor') {
          assert.equal(h.context.api.editor().rating, expected || 0);
          assert.equal(h.context.api.editor().record.etag, 'revalidated');
        }
        assert.equal(h.reads.length, 0);
      }
    }
  }
}

async function testConflictFreshnessAndAcceptance() {
  const h = harness();
  await h.load([row(1)]);
  h.context.api.setSelected(1);
  const editor = { id: 1, kind: 'shot', record: { etag: '"shot-meta-00000001-00000001-v-00000001"' }, saving: true };
  h.context.api.setEditor(editor);
  const pending = h.context.loadMetadataConflict(editor, 'save', { rating: 3 });
  const stale = h.take(h.reads);
  await h.write('initialize', 1);
  h.replyMetadata(stale);
  await flush();
  assert.equal(editor.conflict, undefined);
  h.replyMetadata(h.take(h.reads), 5, '"shot-meta-00000001-00000001-v-00000005"');
  await pending;
  assert.equal(editor.conflict.record.value.rating, 5);
  assert(!editor.saving);

  // Keeping a fetched conflict version must not republish its historical
  // snapshot after another confirmed write has updated the visible record.
  await h.write('initialize', 1);
  h.context.keepSavedMetadataConflict();
  assert.equal(h.context.selectedShotMetadata.etag, 'confirmed');
  assert.equal(h.store.rows[0].userMetadataEtag, 'confirmed');
  assert.equal(h.context.api.editor(), null);
  assert.equal(h.reads.length, 0);
}

async function testClearConflictAlreadyCleared() {
  for (const state of ['absent', 'cleared', 'active', 'corrupt']) {
    for (const action of ['clear', 'save']) {
      const h = harness({ deferredWrites: true });
      await h.load([row(1)]);
      h.context.api.setSelected(1);
      h.context.api.setLast({ id: 1, state: 'active', value: { rating: 1 } });
      const editor = { kind: 'shot', id: 1, record: { etag: 'original' },
        original: action === 'clear' ? {} : { notes: 'My draft' }, conflict: null };
      h.context.api.setEditor(editor);
      const pending = action === 'clear' ? h.context.clearShotMetadata(editor)
        : h.context.writeShotMetadata(editor, editor.original);
      h.take(h.writes).resolve(response(null, 412));
      await flush();
      h.take(h.reads).resolve(response({}, 200, {
        ETag: 'current', 'X-Shot-Metadata-State': state,
        'X-Shot-Metadata-Crc': '0',
      }));
      await pending;
      const completed = action === 'clear' && ['absent', 'cleared'].includes(state);
      assert.equal(h.context.api.editor(), completed ? null : editor,
        `${action} conflict with ${state} details closed incorrectly`);
      assert(!editor.saving);
      assert.equal(h.context.selectedShotMetadata.state, state);
      assert.equal(h.context.selectedShotMetadata.etag, 'current');
      assert.equal(h.context.api.last().state, state);
      assert.equal(h.store.rows[0].userMetadataState, state);
      assert.equal(h.banners.includes('Shot details cleared.'), completed);
      if (!completed) {
        assert.equal(editor.conflict.action, action);
        assert.equal(editor.conflict.record.state, state);
        if (action === 'save') assert.equal(editor.conflict.localValue.notes, 'My draft');
      }
      assert.equal(h.writes.length, 0, 'conflict resolution sent an unnecessary write');
    }
  }
}

async function testDraftAndUncertainWrite() {
  for (const kind of ['save', 'clear']) {
    const h = harness({ deferredWrites: true });
    await h.load([row(1)]);
    const editor = { kind: 'shot', id: 1, record: { etag: 'original' },
      original: { notes: 'My draft' }, yieldCg: 3900, saving: false, conflict: null };
    h.context.api.setEditor(editor);
    let renders = 0;
    h.context.renderMetadataOverlay = () => { ++renders; };
    h.store.sessionStarted();
    assert.equal(renders, 0, 'a reconnect must leave the editable form in place');
    assert.equal(h.context.api.editor().yieldCg, 3900,
      'a reconnect must preserve the editor measurement snapshot');
    const pending = kind === 'clear' ? h.context.clearShotMetadata(editor)
      : h.context.writeShotMetadata(editor, editor.original);
    const write = h.take(h.writes);
    assert.equal(write.options.headers['If-Match'], 'original');
    h.store.sessionStarted();
    write.reject(new Error('response lost'));
    await pending;
    assert.equal(h.context.api.editor(), editor);
    assert.equal(editor.original.notes, 'My draft');
    assert(!editor.saving);
    assert.match(editor.error, /response lost/);
    assert.equal(editor.conflict, null);
    assert.equal(h.writes.length, 0, 'uncertain mutations must not retry automatically');
    assert.equal(h.banners.length, 0);
  }
}

async function testCancelledConflictRead() {
  const h = harness({ deferredWrites: true });
  const editor = { kind: 'shot', id: 1, record: { etag: 'original' },
    original: { notes: 'My draft' }, conflict: null };
  h.context.api.setEditor(editor);
  const pending = h.context.writeShotMetadata(editor, editor.original);
  h.take(h.writes).resolve(response(null, 412));
  await flush();
  const conflictRead = h.take(h.reads);
  h.store.sessionStarted();
  conflictRead.reject(h.context.requestError('network', 'fetch is aborted'));
  await pending;
  assert(!editor.saving);
  assert.equal(editor.conflict, null);
  assert.equal(editor.original.notes, 'My draft');
  assert.equal(editor.error, "Shot details changed. Couldn't load the saved version. " +
    'Wake the device or check the connection, then try again.');
}

async function testConflictIdentity() {
  const containsDraft = node => {
    const classes = (node?.attrs?.class || '').split(/\s+/);
    return (classes.includes('conflict-version') && classes.includes('draft')) ||
      (node?.children || []).some(containsDraft);
  };
  for (const kind of ['save', 'clear']) {
    {
      const h = harness({ deferredWrites: true });
      await h.load([row(1)]);
      const editor = { kind: 'shot', id: 1,
        record: { etag: '"shot-meta-00000001-00000001-v-00000001"' },
        original: { notes: 'My draft' }, conflict: null };
      h.context.api.setEditor(editor);
      const pending = kind === 'clear' ? h.context.clearShotMetadata(editor)
        : h.context.writeShotMetadata(editor, editor.original);
      h.take(h.writes).resolve(response(null, 412,
        { 'X-Shot-Metadata-Conflict': 'shot-identity' }));
      await pending;
      assert(!editor.saving);
      assert.equal(editor.conflict.action, 'identity');
      if (kind === 'clear') assert.equal(editor.conflict.localValue, null);
      else assert.equal(editor.conflict.localValue.notes, 'My draft');
      assert.equal(containsDraft(h.context.renderMetadataConflict()),
        kind === 'save', 'only a save conflict has a submitted draft');
      assert.equal(h.store.rows[0].userMetadata.rating, 1,
        'conflict recovery must not attach another identity to a cached shot');
      assert.equal(editor.record.etag, '"shot-meta-00000001-00000001-v-00000001"');
      await h.context.overwriteMetadataConflict();
      assert.equal(h.writes.length, 0);
      assert.equal(h.reads.length, 0);
    }
  }
}

async function testWriteConnectionFailures() {
  for (const action of ['save', 'clear details']) {
    for (const kind of ['timeout', 'network']) {
      const h = harness({ deferredWrites: true });
      await h.load([row(1)]);
      const editor = { kind: 'shot', id: 1, record: { etag: 'original' },
        original: { notes: 'Keep this draft', prep: { doseG: 18 }, tdsPct: 8.6 },
        yieldCg: 3900, tags: [], rating: 4, conflict: null };
      h.context.api.setEditor(editor);
      const write = () => action === 'save'
        ? h.context.writeShotMetadata(editor, editor.original)
        : h.context.clearShotMetadata(editor);
      const pending = write();
      const error = h.context.requestError(kind, 'fetch is aborted');
      h.take(h.writes).reject(error);
      await pending;
      assert.equal(editor.error, "Couldn't " + action +
        '. Wake the device or check the connection, then try again.');
      assert.equal(h.context.api.editor(), editor);
      assert(!editor.saving);
      assert.equal(editor.original.notes, 'Keep this draft');
      assert.equal(editor.original.prep.doseG, 18);
      assert.equal(editor.original.tdsPct, 8.6);
      assert.equal(editor.yieldCg, 3900);
      assert.equal(h.writes.length, 0, 'a failed write retried automatically');
      const retry = write();
      const request = h.take(h.writes);
      assert.equal(request.options.headers['If-Match'], 'original');
      const responseBody = action === 'save' ? editor.original : {};
      const retryResponse = response(responseBody, 200, {
        ETag: 'retried', 'X-Shot-Metadata-State': action === 'save' ? 'active' : 'cleared',
      });
      request.resolve(retryResponse);
      await retry;
      assert.equal(h.context.api.editor(), null);
      assert.equal(h.store.rows[0].userMetadataEtag, 'retried');
    }
  }
}

async function testEmptyShotSave() {
  for (const state of ['absent', 'cleared', 'active']) {
    const h = harness({ deferredWrites: true });
    await h.load([{ id: 1, userMetadataState: state,
      userMetadata: state === 'active' ? {} : null,
      userMetadataEtag: 'original' }]);
    h.context.openMetadataEditor(h.store.rows[0]);
    const revision = h.store.metadataRevision;
    const pending = h.context.saveMetadataEditor({ elements: {
      tdsPct: { value: '' }, tags: { value: '' }, notes: { value: '' },
    } });
    if (state === 'active') {
      const request = h.take(h.writes);
      assert.equal(request.options.method, 'DELETE');
      assert.equal(request.options.headers['If-Match'], 'original');
      request.resolve(response({}, 200, {
        ETag: 'cleared', 'X-Shot-Metadata-State': 'cleared',
      }));
    }
    await pending;
    assert.equal(h.context.api.editor(), null);
    if (state !== 'active') {
      assert.equal(h.writes.length, 0, `empty Save wrote ${state} details`);
      assert.equal(h.reads.length, 0);
      assert.equal(h.store.rows[0].userMetadataState, state);
      assert.equal(h.store.rows[0].userMetadataEtag, 'original');
      assert.equal(h.store.metadataRevision, revision);
      assert.equal(h.banners.length, 0, 'empty Save claimed to clear saved details');
    } else {
      assert.equal(h.store.rows[0].userMetadataState, 'cleared');
      assert.equal(h.banners.at(-1), 'Shot details cleared.');
    }
  }
}

async function testClearedDraftSurvivesFailedSave() {
  for (const outcome of ['network', 'conflict']) {
    const h = harness({ deferredWrites: true });
    const editor = { kind: 'shot', id: 1, record: { state: 'active', etag: 'original' },
      original: { notes: 'Saved notes', prep: { doseG: 18 }, future: { kept: true } },
      tags: ['saved-tag'], rating: 4, conflict: null };
    h.context.api.setEditor(editor);
    let confirmations = 0;
    h.context.confirm = () => { ++confirmations; return false; };
    const form = { elements: {
      tdsPct: { value: '8.6' }, tags: { value: 'draft-tag' },
      notes: { value: 'Unsaved notes' },
      'prep.doseG': { value: '20' }, 'prep.tempC': { value: '94' },
      'prep.grind': { value: '1.8' }, 'prep.pressure': { value: '6 bar' },
    } };
    h.context.clearMetadataEditorDraft(form);
    assert.equal(confirmations, 1);
    assert.equal(editor.original.notes, 'Saved notes');
    assert.equal(form.elements.notes.value, 'Unsaved notes');
    assert.equal(editor.tags.join(','), 'saved-tag');
    assert.equal(h.writes.length, 0, 'cancelling draft reset wrote to the device');
    h.context.confirm = () => { ++confirmations; return true; };
    h.context.clearMetadataEditorDraft(form);
    assert.deepEqual(JSON.parse(JSON.stringify(editor.original)), {});
    assert.equal(h.writes.length, 0, 'clearing the draft wrote before Save');
    const clearedForm = { elements: {
      tdsPct: { value: '' }, tags: { value: '' }, notes: { value: '' },
    } };
    h.context.clearMetadataEditorDraft(clearedForm);
    assert.equal(confirmations, 2, 'empty draft asked for another confirmation');
    const pending = h.context.saveMetadataEditor(clearedForm);
    const request = h.take(h.writes);
    assert.equal(request.options.method, 'DELETE');
    assert.equal(request.options.headers['If-Match'], 'original');
    if (outcome === 'network') {
      request.reject(h.context.requestError('network', 'offline'));
    } else {
      request.resolve(response(null, 412));
      await flush();
      h.replyMetadata(h.take(h.reads), 3, 'current');
    }
    await pending;
    if (outcome === 'conflict') {
      assert.equal(editor.conflict.action, 'clear');
      h.context.returnToMetadataDraft();
      assert.equal(editor.conflict, null);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(editor.original)), {});
    assert.equal(editor.rating, 0);
    assert.equal(editor.tags.length, 0);
    assert.equal(confirmations, 2, 'Save asked for a second clear confirmation');
    assert.equal(editor.record.etag, 'original');
    assert(!editor.saving);
  }
}

async function testApplicationWriteFailuresStayIdentifiable() {
  for (const clear of [false, true]) {
    const h = harness();
    await h.load([row(1)]);
    const editor = { kind: 'shot', id: 1, record: { etag: 'original' },
      original: { notes: 'Draft' }, conflict: null };
    h.context.api.setEditor(editor);
    h.context.publishSavedMetadata = () => {
      throw new TypeError('Publication bug after HTTP 200');
    };
    if (clear) await h.context.clearShotMetadata(editor);
    else await h.context.writeShotMetadata(editor, editor.original);
    assert.equal(editor.error, 'Publication bug after HTTP 200');
    assert(!editor.saving);
  }
}

async function testRequestFailureClassification() {
  const h = harness();
  let timeout;
  let cleared = 0;
  h.context.setTimeout = callback => { timeout = callback; return 1; };
  h.context.clearTimeout = () => { ++cleared; };
  const fetch = consume => h.context.api.fetchWithTimeout('/test', {}, consume);
  h.context.fetch = async () => { throw new TypeError('native fetch failed'); };
  await assert.rejects(fetch(() => {}), error =>
    error.kind === 'network' && error.cause.message === 'native fetch failed');

  h.context.fetch = (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const pending = fetch(() => {});
  timeout();
  await assert.rejects(pending, error => error.kind === 'timeout');
  const caller = new AbortController();
  const cancelled = h.context.api.fetchWithTimeout('/test', { signal: caller.signal }, () => {});
  caller.abort();
  await assert.rejects(cancelled, error => error.kind === 'cancelled');

  h.context.fetch = async (_path, options) => ({
    json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('body aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  const bodyTimeout = fetch(r => h.context.readResponseBody(r, 'json'));
  await flush();
  timeout();
  await assert.rejects(bodyTimeout, error => error.kind === 'timeout');

  h.context.fetch = async () => response({}, 200);
  await assert.rejects(fetch(() => { throw new TypeError('callback bug'); }),
    error => error.message === 'callback bug' && !error.kind);
  h.context.fetch = async () => ({
    json: async () => { throw new TypeError('body interrupted'); },
  });
  await assert.rejects(fetch(r => h.context.readResponseBody(r, 'json')),
    error => error.kind === 'network' && error.cause.message === 'body interrupted');
  h.context.fetch = async () => ({
    json: async () => { throw new SyntaxError('invalid JSON'); },
  });
  await assert.rejects(fetch(r => h.context.readResponseBody(r, 'json')),
    error => error.message === 'invalid JSON' && !error.kind);
  h.context.fetch = async () => ({ bodyUsed: true });
  await assert.rejects(fetch(r => h.context.readResponseBody(r, 'json')),
    error => error.message === 'Response body is already in use.' && !error.kind);
  assert.equal(cleared, 8);
}

async function testRejectedWrites() {
  for (const clearing of [false, true]) {
    for (const status of [400, 404, 409, 413, 422, 500]) {
      const h = harness({ deferredWrites: true });
      const editor = { kind: 'shot', id: 1, record: { etag: 'original' },
        original: { notes: 'Keep this' }, conflict: null };
      h.context.api.setEditor(editor);
      const pending = clearing ? h.context.clearShotMetadata(editor)
        : h.context.writeShotMetadata(editor, editor.original);
      const rejected = response(null, status);
      rejected.json = async () => { throw new Error('body unavailable'); };
      h.take(h.writes).resolve(rejected);
      await pending;
      assert.equal(h.context.api.editor(), editor);
      assert(!editor.saving);
      assert.match(editor.error, clearing ? /Couldn't clear details/ : /Couldn't save/);
      assert.match(editor.error, new RegExp('HTTP ' + status));
      assert(!editor.error.includes('Could not confirm'));
      assert.equal(editor.original.notes, 'Keep this');
      assert.equal(h.writes.length, 0);
      assert.equal(h.reads.length, 0);
    }
  }
}

async function testRecipeFailureOutcomes() {
  for (const outcome of ['local', 'ineligible', 'rejected', 'bad-rejection-body', 'unknown']) {
    const h = harness({ deferredWrites: true });
    const recipe = { notes: outcome === 'local' ? 'x'.repeat(1600) : 'Recipe' };
    const pending = h.context.setLastShotMetadataId(1, recipe);
    if (outcome === 'local') {
      assert.equal(h.writes.length, 0);
    } else {
      const request = h.take(h.writes);
      if (outcome === 'unknown') request.reject(new Error('response lost'));
      else if (outcome === 'ineligible') {
        request.resolve(response({ reason: 'shot_not_eligible' }, 409));
      } else if (outcome === 'bad-rejection-body') {
        request.resolve({ ...response(null, 409),
          json: async () => { throw new Error('response body lost'); } });
      } else request.resolve(response(null, 404));
    }
    await flush();
    assert.equal(h.banners.length, 1);
    assert.match(h.banners[0], /The recipe could not be attached/);
    if (outcome === 'unknown') assert.match(h.banners[0], /response lost/);
    if (outcome === 'local') assert.match(h.banners[0], /limit/);
    if (outcome === 'ineligible') assert.match(h.banners[0], /newer shot/);
    h.replyMetadata(h.take(h.reads));
    await pending;
    assert.equal(h.writes.length, 0, 'recipe writes must not retry automatically');
  }
}

async function testMissingEditorMeasurement() {
  const h = harness();
  const etag = '"shot-meta-00000001-00000001-v-00000001"';
  await h.load([{ ...row(1), yieldCg: 3600, userMetadataEtag: etag }]);
  h.context.openMetadataEditor(h.store.rows[0]);
  const editor = h.context.api.editor();
  const shot = h.context.api.editor().yieldCg;
  h.store.sessionStarted();
  const refresh = h.store.refresh();
  h.reply(h.take(), [{ ...row(1), yieldCg: 9000,
    userMetadataEtag: '"shot-meta-00000002-00000001-v-00000001"' }]);
  await refresh;
  assert.equal(h.context.api.editor(), editor);
  assert.equal(h.context.api.editor().yieldCg, shot,
    'an ID reused after a reboot replaced the editor measurement');
}

async function testOverlappingWriteConfirmations() {
  const h = harness({ deferredWrites: true });
  await h.load([row(1)]);
  const initialize = h.context.setLastShotMetadataId(1, { rating: 1 });
  const old = h.take(h.writes);
  const editor = { kind: 'shot', id: 1, record: { etag: 'initialized' } };
  h.context.api.setEditor(editor);
  const saving = h.context.writeShotMetadata(editor, { rating: 5 });
  h.replyMetadata(h.take(h.writes), 5, 'saved');
  await saving;
  h.replyMetadata(old, 1, 'initialized');
  await initialize;
  assert.notEqual(h.store.rows[0].userMetadataEtag, 'initialized');
  assert.notEqual(h.context.api.last().etag, 'initialized');
  h.replyMetadata(h.take(h.reads), 5, 'current');
  await flush();
  assert.equal(h.context.api.last().value.rating, 5);
}

async function testOverlappingWritesConfirmedInRequestOrder() {
  const h = harness({ deferredWrites: true });
  await h.load([row(1)]);
  const initializing = h.context.setLastShotMetadataId(1, { rating: 1 });
  const initialResponse = h.take(h.writes);
  const editor = { kind: 'shot', id: 1, record: { etag: 'initialized' } };
  h.context.api.setEditor(editor);
  const saving = h.context.writeShotMetadata(editor, { rating: 5 });
  const saveResponse = h.take(h.writes);
  h.replyMetadata(initialResponse, 1, 'initialized');
  await initializing;
  h.replyMetadata(saveResponse, 5, 'saved');
  await saving;
  h.replyMetadata(h.take(h.reads), 5, 'current');
  await flush();
  assert.equal(h.store.rows[0].userMetadata.rating, 5);
  assert.equal(h.context.api.last().value.rating, 5);
}

async function testRecipeRefreshOutcomes() {
  for (const failed of [false, true]) {
    for (const changedId of [1, 2]) {
      const h = harness({ deferredWrites: true });
      await h.load([row(2), row(1)]);
      const initializing = h.context.setLastShotMetadataId(1, { rating: 1 });
      const initializationResponse = h.take(h.writes);
      const editor = { kind: 'shot', id: changedId, record: { etag: 'before' } };
      h.context.api.setEditor(editor);
      const saving = h.context.writeShotMetadata(editor, { rating: 5 });
      h.replyMetadata(h.take(h.writes), 5, 'saved');
      await saving;
      const confirmed = h.context.api.last();
      h.replyMetadata(initializationResponse, 1, 'initialized');
      await initializing;
      const refresh = h.take(h.reads);
      if (failed) refresh.reject(new Error('offline'));
      else h.replyMetadata(refresh, changedId === 1 ? 5 : 1, 'current');
      await flush();
      const record = h.context.api.last();
      assert(!record.loading, `refresh failed=${failed}, changed shot=${changedId}`);
      if (failed) {
        if (changedId === 1) assert.equal(record, confirmed);
        else assert.equal(record.state, 'unavailable');
        assert.match(h.banners.at(-1), /saved, but the current version could not be refreshed/);
      } else {
        assert.equal(record.etag, 'current');
        assert.equal(record.needsResult, true);
      }
      const root = element('main');
      h.context.appendShotMetadataDetails(root,
        h.context.shotSummaryFromRecord(1, { yieldCg: 3600 }, record));
      const nodes = node => [node, ...(node?.children || [])
        .filter(child => child && typeof child === 'object').flatMap(nodes)];
      const labels = nodes(root).filter(node => node.tag === 'button')
        .flatMap(node => node.children);
      assert(labels.includes(failed
        ? changedId === 1 ? 'Edit shot details' : 'Load shot details'
        : 'Rate and save details'));
    }
  }
}

async function testBackToDraftRequiresOverwriteChoice() {
  const h = harness({ deferredWrites: true });
  await h.load([row(1)]);
  const editor = { kind: 'shot', id: 1, original: { notes: 'My draft' },
    record: { etag: 'original' }, conflict: null };
  h.context.api.setEditor(editor);
  const rejected = h.context.writeShotMetadata(editor, editor.original);
  h.take(h.writes).resolve(response(null, 412));
  await flush();
  h.replyMetadata(h.take(h.reads), 3, 'current');
  await rejected;
  h.context.returnToMetadataDraft();
  assert.equal(editor.record.etag, 'original');
  assert.equal(editor.original.notes, 'My draft');
  assert.equal(editor.conflict, null);

  const revised = h.context.writeShotMetadata(editor, { notes: 'Revised draft' });
  const retry = h.take(h.writes);
  assert.equal(retry.options.headers['If-Match'], 'original');
  retry.resolve(response(null, 412));
  await flush();
  h.replyMetadata(h.take(h.reads), 3, 'current');
  await revised;
  assert.equal(editor.conflict.action, 'save');
  assert.equal(editor.conflict.localValue.notes, 'Revised draft');

  const overwrite = h.context.overwriteMetadataConflict();
  const accepted = h.take(h.writes);
  assert.equal(accepted.options.headers['If-Match'], 'current');
  h.replyMetadata(accepted, 5, 'saved');
  await overwrite;
}

async function testMetadataDownloadsIdentifyDrafts() {
  const h = harness();
  const blobs = [];
  const links = [];
  const revoked = [];
  h.context.Blob = Blob;
  h.context.URL = {
    createObjectURL(blob) { blobs.push(blob); return 'blob:download-' + blobs.length; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  h.context.document = { body: { append(link) { links.push(link); } } };
  const originalElement = h.context.el;
  h.context.el = (tag, attrs, ...children) => {
    const node = originalElement(tag, attrs, ...children);
    if (tag === 'a') {
      node.click = () => { node.clicked = true; };
      node.remove = () => { node.removed = true; };
    }
    return node;
  };
  const draft = { notes: 'Unsaved tasting notes' };
  h.context.api.setEditor({ kind: 'shot', id: 1,
    conflict: { action: 'identity', localValue: draft } });
  const nodes = node => [node, ...(node?.children || [])
    .filter(child => child && typeof child === 'object').flatMap(nodes)];
  const downloadDraft = nodes(h.context.renderMetadataConflict()).find(node =>
    node.tag === 'button' && node.children.includes('Download draft'));
  downloadDraft.attrs.onclick();
  const unsaved = JSON.parse(await blobs[0].text());
  assert.equal(links[0].attrs.download, 'shot-1-draft.json');
  assert.equal(unsaved.draft, true);
  assert.deepEqual(unsaved.userMetadata, draft);

  h.context.downloadShotDetailsJson(1, { state: 'active', value: { rating: 3 } });
  const saved = JSON.parse(await blobs[1].text());
  assert.equal(links[1].attrs.download, 'shot-1-details.json');
  assert.equal(saved.draft, undefined);
  assert.equal(saved.userMetadata.rating, 3);
  assert(links.every(link => link.clicked && link.removed));
  assert.deepEqual(revoked, ['blob:download-1', 'blob:download-2']);
}

async function testConflictDraftCanBeRecovered() {
  const h = harness();
  const draft = { notes: 'Unsaved tasting notes', tdsPct: 8.6,
    prep: { doseG: 18 }, coffee: { name: 'Keep this coffee' } };
  const editor = { kind: 'shot', id: 1, original: draft, yieldCg: 3600,
    record: { etag: '"shot-meta-00000001-00000001-v-00000001"' },
    saving: false, conflict: { action: 'identity', localValue: draft } };
  h.context.api.setEditor(editor);
  const nodes = node => [node, ...(node?.children || [])
    .filter(child => child && typeof child === 'object').flatMap(nodes)];
  const dialog = h.context.renderMetadataConflict();
  const buttons = nodes(dialog).filter(node => node.tag === 'button');
  assert(buttons.some(button => button.children.includes('Download draft')));
  assert(!buttons.some(button => button.children.includes('Replace saved')));
  buttons.find(button => button.children.includes('Back to draft')).attrs.onclick();
  assert.equal(h.context.api.editor(), editor);
  assert.equal(editor.original, draft);
  assert.equal(editor.conflict, null);
  assert.equal(editor.yieldCg, 3600);
  assert.equal(editor.record.etag, '"shot-meta-00000001-00000001-v-00000001"');
}

async function testFailedWritesDoNotInvalidateReads() {
  const h = harness();
  await h.load([row(1)]);
  const page = h.store.refresh();
  const pendingPage = h.take();
  const metadata = h.context.resolveShotMetadata(1);
  const pendingRead = h.take(h.reads);
  await h.write('save', 1, 500);
  h.replyMetadata(pendingRead);
  h.reply(pendingPage, [row(1)]);
  await Promise.all([page, metadata]);
  assert.equal(h.reads.length, 0);
  assert.equal(h.pages.length, 0);
}

async function testStreamDefersNewBackgroundReads() {
  const h = harness({ restoredRecipe: { coffee: { name: 'Restored' } } });
  Object.assign(h.context, {
    state: null, inflight: null, lastShotExpanded: false,
  });
  h.context.loadMetadataBrowserState();
  vm.runInContext(fs.readFileSync(streamPath, 'utf8'), h.context);
  const bytes = new Uint8Array(12);
  bytes[0] = 1;
  function state(phase) {
    bytes[1] = phase;
    h.context.handleStatePacket(new DataView(bytes.buffer), 0, 1);
  }
  h.store.sessionStarted();
  state(1);
  assert.equal(h.pages.length, 0);
  state(0);
  const stale = h.take();
  state(1);
  await h.write('save', 1);
  h.reply(stale, [row(1)], 'obsolete');
  await flush();
  assert.equal(h.store.rows, null);
  // An admitted read finishes its revalidation within its original budget.
  h.reply(h.take(), [row(1, 5)]);
  await flush();
  state(0);
  await flush();
  assert.equal(h.store.rows[0].userMetadata.rating, 5);
  assert(!h.store.loading);
}


async function testRepeatedWritesDuringRefresh() {
  const h = harness();
  await h.load([row(2), row(1)]);
  const pending = h.store.refreshPreservingRows();
  const first = h.take();
  await h.write('save', 1);
  h.reply(first, [row(3), row(2), row(1)], 'stale-first', false, 3);
  await flush();
  const second = h.take();
  await h.write('clear', 1);
  h.reply(second, [row(3), row(2), row(1, 5)], 'stale-second', false, 3);
  await flush();
  assert.equal(h.store.rows.find(r => r.id === 1).userMetadataState, 'cleared');
  const final = h.take();
  assert.equal(final.options.headers['If-None-Match'], 'baseline');
  h.reply(final, [row(3), row(2), {
    ...row(1), userMetadataState: 'cleared', userMetadata: null,
  }], 'current', false, 3);
  assert.equal((await pending).status, 200);
  assert.deepEqual(Array.from(h.store.rows, r => r.id), [3, 2, 1]);
  assert.equal(h.store.rows.find(r => r.id === 1).userMetadata, null);
  assert.equal(h.pages.length, 0);
}

async function testCancellationDuringMetadataRevalidation() {
  for (const transition of ['reconnect', 'replacement', 'storage']) {
    const h = harness();
    await h.load([row(3), row(2)], true, 3);
    const pending = h.store.loadMore();
    const first = h.take();
    await h.write('save', 3);
    h.reply(first, [row(1)], 'stale');
    await flush();
    const retry = h.take();
    if (transition === 'reconnect') h.store.sessionStarted();
    else if (transition === 'storage') {
      h.store.observeDeviceState('unavailable');
      h.store.observeDeviceState('ready', false, false);
    }
    const replacement = h.store.refresh();
    const current = h.take();
    assert(retry.options.signal.aborted);
    h.reply(current, [row(9)], 'replacement');
    await replacement;
    h.reply(retry, [row(1)], 'obsolete-after-cancel');
    assert.equal((await pending).status, 'cancelled');
    assert.deepEqual(Array.from(h.store.rows, r => r.id), [9]);
    assert.equal(h.store.etagFor(pageUrl), 'replacement');
    assert.equal(h.pages.length, 0);
  }
}

async function testMetadataRevalidationFailure() {
  for (const older of [false, true]) {
    const h = harness();
    await h.load([row(2)], true, 2);
    const pending = older ? h.store.loadMore() : h.store.refresh();
    const first = h.take();
    await h.write('save', 2);
    h.reply(first, [row(1)], 'stale');
    await flush();
    const failure = new Error('retry unavailable');
    h.take().reject(failure);
    const result = await pending;
    assert.equal(result.status, 'error');
    assert.equal(result.error, failure);
    assert.equal(h.store.rows[0].userMetadata.rating, 5);
    assert.equal(h.store.error, older ? null : failure);
    assert.equal(h.store.etagFor(pageUrl), 'baseline');
    assert(!h.store.loading);
    const recovery = older ? h.store.loadMore() : h.store.retry();
    const next = h.take();
    h.reply(next, older ? [row(1)] : [row(2, 5)], 'recovered');
    await recovery;
    assert.equal(h.store.rows[0].userMetadata.rating, 5);
    assert.equal(h.pages.length, 0);
  }
}

async function testMetadataReadDoesNotRestartPage() {
  const h = harness();
  await h.load([row(1)]);
  const pending = h.store.refresh();
  const page = h.take();
  const read = h.context.resolveShotMetadata(1);
  h.replyMetadata(h.take(h.reads), 3);
  await read;
  h.reply(page, [row(1, 3)], 'current');
  assert.equal((await pending).status, 200);
  assert.equal(h.pages.length, 0);
}


async function testPageReadDeadline() {
  for (const kind of ['initial', 'head', 'older', 'background']) {
    const h = harness({ automatic: kind === 'background' });
    if (kind !== 'initial') await h.load([row(2)], true, 2);
    const pending = kind === 'older' ? h.store.loadMore()
      : kind === 'initial' ? h.store.ensureLoaded()
      : kind === 'background' ? h.store.shotSaved() : h.store.refresh();
    const waiting = kind === 'background' ? h.store.loadMore() : null;
    for (const [budget, elapsed] of [[10000, 5000], [5000, 4000], [1000, 1000]]) {
      const request = h.take();
      assert.equal(request.timeoutMs, budget);
      await h.write('save', 2);
      h.advance(elapsed);
      h.reply(request, [row(2)], 'obsolete');
      await flush();
    }
    const result = await pending;
    assert.equal(result.status, 'error');
    assert.match(result.error.message, /Refresh timed out\./);
    if (waiting) assert.equal((await waiting).status, 'error');
    assert.equal(h.pages.length, 0, 'expired read kept retrying');
    assert(!h.store.loading);
    assert.notEqual(h.store.pagination.status, 'loading');
    assert.equal(h.store.etagFor(pageUrl), kind === 'initial' ? null : 'baseline');
    if (kind !== 'initial') assert.equal(h.store.rows[0].userMetadata.rating, 5);
    const retry = kind === 'older' ? h.store.loadMore() : h.store.retry();
    h.reply(h.take(), kind === 'older' ? [row(1)] : [row(2, 5)], 'recovered');
    assert.equal((await retry).status, 200);
    assert.equal(h.pages.length, 0);
  }
}

async function testIndividualReadDeadline() {
  for (const consumer of ['last', 'detail', 'editor', 'conflict']) {
    for (const editedId of [1, 2]) {
      const h = harness();
      await h.load([row(2), row(1)]);
      h.context.view = 'detail';
      h.context.api.setSelected(1);
      h.context.api.setLast({ id: 1, state: 'active', value: { rating: 1 } });
      h.context.selectedShotMetadata = { id: 1, state: 'active', value: { rating: 1 } };
      const editor = { id: 1, kind: 'shot', record: { etag: 'original' }, saving: true };
      if (consumer === 'conflict') h.context.api.setEditor(editor);
      const pending = consumer === 'last' ? h.context.setLastShotMetadataId(1)
        : consumer === 'detail' ? h.context.loadShotMetadataForDetail(1)
        : consumer === 'editor' ? h.context.loadShotMetadata({ id: 1 })
        : h.context.loadMetadataConflict(editor, 'save', { notes: 'My draft' });
      for (const [budget, elapsed] of [[10000, 6000], [4000, 4000]]) {
        const request = h.take(h.reads);
        assert.equal(request.timeoutMs, budget);
        // Initialization leaves the editor under test in place.
        await h.write('initialize', editedId);
        h.advance(elapsed);
        h.replyMetadata(request, 1, 'obsolete');
        await flush();
      }
      await pending;
      assert.equal(h.reads.length, 0);
      assert.equal(h.context.selectedShotMetadata.loading, undefined);
      if (editedId === 1) {
        assert.equal(h.context.selectedShotMetadata.value.rating, 5);
        assert.equal(h.context.selectedShotMetadata.etag, 'confirmed');
      } else if (consumer === 'conflict' || consumer === 'last') {
        assert.equal(h.context.selectedShotMetadata.value.rating, 1);
      } else assert.equal(h.context.selectedShotMetadata.state, 'unavailable');
      assert.equal(h.store.rows.find(row => row.id === editedId).userMetadata.rating, 5);
      if (consumer === 'editor') {
        assert.equal(h.context.api.editor(), null);
        assert.match(h.banners.at(-1), /Refresh timed out\./);
      }
      if (consumer === 'conflict') {
        assert.equal(h.context.api.editor(), editor);
        assert(!editor.saving);
        assert.match(editor.error, /Refresh timed out\./);
      }
      const retry = h.context.loadShotMetadataForDetail(1);
      h.replyMetadata(h.take(h.reads), 5, 'recovered');
      await retry;
      assert.equal(h.context.selectedShotMetadata.etag, 'recovered');
    }
  }
}

async function testOvertakenPageFailure() {
  const h = harness();
  await h.load([row(1)]);
  const pending = h.store.refresh();
  const old = h.take();
  await h.write('save', 1);
  old.reject(new Error('old failure'));
  await flush();
  assert.equal(h.store.error, null);
  assert.equal(h.store.rows[0].userMetadata.rating, 5);
  h.reply(h.take(), [row(1, 5)], 'current');
  assert.equal((await pending).status, 200);
}

async function testTransferDeadlineIncludesRetriedBody() {
  const h = harness();
  await h.load([row(1)]);
  const mock = h.context.fetchWithTimeout;
  const timers = new Map();
  let timerId = 0;
  Object.assign(h.context, {
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    fetch: async (_url, options) => {
      const result = await new Promise((resolve, reject) => {
        h.pages.push({ options, resolve, reject });
        options.signal.addEventListener('abort',
          () => reject(new Error('aborted')), { once: true });
      });
      return result;
    },
  });
  h.context.fetchWithTimeout = (url, ...args) => url.startsWith(pageUrl)
    ? h.context.api.fetchWithTimeout(url, ...args) : mock(url, ...args);
  const pending = h.store.refresh();
  const first = h.take();
  assert.equal([...timers.values()][0].delay, 10000);
  await h.write('save', 1);
  h.advance(7000);
  h.reply(first, [row(1)], 'obsolete');
  await flush();
  const retry = h.take();
  assert.equal([...timers.values()][0].delay, 3000);
  let bodyStarted = false;
  retry.resolve({
    ...response(null, 200, { ETag: 'obsolete-body' }),
    json: () => {
      bodyStarted = true;
      return new Promise((_resolve, reject) => {
        retry.options.signal.addEventListener('abort',
          () => reject(new Error('body aborted')), { once: true });
      });
    },
  });
  await flush();
  assert(bodyStarted);
  h.advance(3000);
  [...timers.values()][0].callback();
  const result = await pending;
  assert.equal(result.status, 'error');
  assert(retry.options.signal.aborted);
  assert.equal(timers.size, 0);
  assert(!h.store.loading);
  assert.equal(h.store.rows[0].userMetadata.rating, 5);
  assert.equal(h.store.etagFor(pageUrl), 'baseline');
}

async function testEditorDoesNotBorrowLaterMeasurements() {
  const h = harness();
  const record = { id: 1, state: 'active', etag: 'original', value: {} };
  h.context.openMetadataEditor(h.context.shotSummaryFromRecord(1, null, record));
  assert.equal(h.context.api.editor().yieldCg, undefined);
  const editor = h.context.api.editor();
  await h.load([{ ...row(1), yieldCg: 3600 }]);
  assert.equal(h.context.api.editor(), editor);
  assert.equal(h.context.api.editor().yieldCg, undefined,
    'an unavailable measurement must not be replaced by an unrelated History load');
}

async function testConfirmedWriteAcrossReconnect() {
  for (const kind of ['save', 'clear', 'initialize']) {
    const h = harness({ deferredWrites: true });
    await h.load([row(1)]);
    const editor = { id: 1, kind: 'shot', record: { etag: 'original' },
      original: { notes: 'My draft' }, conflict: null };
    h.context.api.setEditor(editor);
    const pending = kind === 'initialize' ? h.context.setLastShotMetadataId(1, { rating: 5 })
      : kind === 'clear' ? h.context.clearShotMetadata(editor)
      : h.context.writeShotMetadata(editor, { rating: 5 });
    const request = h.take(h.writes);
    h.store.sessionStarted();
    h.context.metadataStreamSessionStarted();
    assert.equal(h.context.api.editor(), editor);
    assert.equal(editor.conflict, null);
    assert.equal(request.options.signal, undefined);
    h.replyMetadata(request, kind === 'clear' ? null : 5, 'confirmed');
    await pending;
    assert.equal(h.store.rows[0].userMetadataEtag, 'confirmed');
    assert.equal(h.store.rows[0].userMetadataState, kind === 'clear' ? 'cleared' : 'active');
    if (kind === 'clear') assert.equal(h.store.rows[0].userMetadata, null);
    if (kind !== 'initialize') {
      assert.equal(h.context.api.editor(), null);
      assert(h.banners.includes(kind === 'clear' ? 'Shot details cleared.' : 'Shot details saved.'));
    }
  }
}

async function testCompletedReadAfterDeadline() {
  for (const consumer of ['page', 'metadata']) {
    for (const retried of [false, true]) {
      const h = harness();
      await h.load([row(1)]);
      h.context.api.setSelected(1);
      const pending = consumer === 'page' ? h.store.refresh()
        : h.context.resolveShotMetadata(1);
      const queue = consumer === 'page' ? h.pages : h.reads;
      let request = h.take(queue);
      if (retried) {
        await h.write('save', 1);
        h.advance(6000);
        if (consumer === 'page') h.reply(request, [row(1)], 'obsolete');
        else h.replyMetadata(request, 1, 'obsolete');
        await flush();
        request = h.take(queue);
        assert.equal(request.timeoutMs, 4000);
      }
      h.advance(retried ? 6000 : 12000);
      if (consumer === 'page') h.reply(request, [row(1, 5)], 'completed');
      else h.replyMetadata(request, 5, 'completed');
      const result = await pending;
      assert.equal(consumer === 'page' ? result.status : result.etag,
        consumer === 'page' ? 200 : 'completed');
      assert.equal(h.store.rows[0].userMetadata.rating, 5);
      assert.equal(queue.length, 0);
    }
  }
  const h = harness();
  await h.load([row(1)]);
  const pending = h.store.refresh();
  h.advance(12000);
  h.take().resolve(response(null, 304));
  assert.equal((await pending).status, 304);
  assert.equal(h.store.etagFor(pageUrl), 'baseline');
}

async function testReadFailureAfterDeadline() {
  for (const consumer of ['page', 'metadata']) {
    for (const overtaken of [false, true]) {
      for (const status of [404, 500]) {
        const h = harness();
        await h.load([row(1)]);
        h.context.api.setSelected(1);
        const pending = consumer === 'page' ? h.store.refresh()
          : h.context.resolveShotMetadata(1).then(
            () => assert.fail('failed GET succeeded'), error => ({ status: 'error', error }));
        const request = h.take(consumer === 'page' ? h.pages : h.reads);
        if (overtaken) await h.write('save', 1);
        h.advance(12000);
        request.resolve(response(null, status));
        const result = await pending;
        assert.equal(result.status, 'error');
        assert.equal(result.error.message, consumer === 'page' ? 'shots ' + status
          : status === 404 ? 'not found' : 'shot metadata ' + status);
        if (overtaken) {
          assert.equal(h.store.rows[0].userMetadata.rating, 5);
          if (consumer === 'metadata') {
            assert.equal(h.context.selectedShotMetadata.etag, 'confirmed');
          }
        }
        assert.equal(h.store.etagFor(pageUrl), 'baseline');
        assert.equal(h.pages.length + h.reads.length, 0);
      }
    }
  }
}

async function testLastShotRefreshPreservesOpenDetail() {
  for (const failed of [false, true]) {
    const h = harness();
    await h.load([row(1)]);
    h.context.view = 'detail';
    h.context.api.setSelected(1);
    const displayed = { id: 1, state: 'active', value: { rating: 1 }, etag: 'displayed' };
    h.context.selectedShotMetadata = displayed;
    h.context.api.setLast(displayed);
    h.store.sessionStarted();
    h.context.metadataStreamSessionStarted();
    const pending = h.context.setLastShotMetadataId(1);
    const request = h.take(h.reads);
    assert.equal(h.context.selectedShotMetadata, displayed,
      'a Last Shot refresh replaced the open detail metadata with a loading state');
    assert(h.context.api.last().loading);
    if (failed) request.reject(new Error('offline'));
    else h.replyMetadata(request, 3, 'revalidated');
    await pending;
    if (failed) {
      assert.equal(h.context.selectedShotMetadata, displayed);
      assert.equal(h.context.api.last().state, 'unavailable');
    } else {
      assert.equal(h.context.selectedShotMetadata.etag, 'revalidated');
      assert.equal(h.context.api.last().etag, 'revalidated');
    }
  }
}

function historyViewport(h) {
  const viewport = { scrollY: 5200, scrollCalls: 0,
    scrollTo(_x, y) { this.scrollY = y; ++this.scrollCalls; } };
  const list = { children: [], contains(control) {
    return this.children.some(item => item.buttons.includes(control));
  }, querySelector(selector) {
    const id = Number(selector.match(/data-shot-id="(\d+)"/)[1]);
    return this.children.find(item => Number(item.dataset.shotId) === id) || null;
  } };
  function card(id, top) {
    const item = { dataset: { shotId: String(id) }, top,
      getBoundingClientRect() {
        return { top: this.top - viewport.scrollY, bottom: this.top - viewport.scrollY + 250 };
      },
      querySelectorAll() { return this.buttons; },
    };
    item.buttons = [{ closest() { return item; }, focus(options) {
      assert.equal(options.preventScroll, true);
      h.context.document.activeElement = this;
    } }];
    return item;
  }
  h.context.window = viewport;
  h.context.document.querySelector = selector => selector === 'ul.shotlist'
    ? list : list.querySelector(selector);
  h.context.loadShotMetadataForDetail = () => {};
  h.context.fetchBinary = async () => ({ status: 'ok', shot: { yieldCg: 3900 } });
  list.children = [card(90, 5500), card(89, 5750)];
  h.context.document.activeElement = list.children[0].buttons[0];
  return { viewport, list, card };
}

async function testHistoryReturnKeepsCardPosition() {
  for (const status of ['ok', 'missing', 'invalid']) {
    const h = harness();
    await h.load([row(90), row(89)]);
    const { viewport, list, card } = historyViewport(h);
    h.context.view = 'list';
    h.context.fetchBinary = async () => ({ status, shot: { yieldCg: 3900 } });
    await h.context.selectShot(90);
    viewport.scrollY = 0;
    h.context.document.activeElement = null;
    h.context.switchView('list');
    renderedHistory(h);
    assert.equal(viewport.scrollY, 5200, status + ': lost History position');
    assert.equal(h.context.document.activeElement, list.children[0].buttons[0],
      status + ': did not return focus to the shot');
    const refresh = h.take();
    h.reply(refresh, [row(91), row(90), row(89)], 'new-shot');
    await flush();
    h.context.rememberHistoryListPosition();
    list.children[0].top += 250;
    list.children[1].top += 250;
    list.children.unshift(card(91, 5500));
    renderedHistory(h);
    assert.equal(list.children[1].getBoundingClientRect().top, 300,
      status + ': a newer shot moved the card after returning');
    assert.equal(h.context.document.activeElement, list.children[1].buttons[0],
      status + ': the return refresh lost focus');
  }
}

async function testHistoryReturnWhenCardWasRemoved() {
  const h = harness();
  await h.load([row(90), row(89)]);
  const { viewport, list, card } = historyViewport(h);
  h.context.view = 'list';
  await h.context.selectShot(90);
  viewport.scrollY = 0;
  h.context.document.activeElement = null;
  h.context.switchView('list');
  h.reply(h.take(), [row(200)], 'replacement');
  await flush();
  list.children = [card(200, 200)];
  renderedHistory(h);
  assert.equal(viewport.scrollY, 5200, 'missing card lost the saved scroll fallback');
  assert.equal(h.context.document.activeElement, null, 'missing card focused a different shot');
}

async function testReconnectPreservesOlderHistoryAndRetry() {
  for (const change of ['wake', 'conditional', 'new-shot', 'retention']) {
    const h = harness({ automatic: true });
    h.context.document.querySelector = () => null;
    h.context.requestAnimationFrame = () => {};
    const range = top => Array.from({ length: 20 }, (_, i) => row(top - i));
    const initial = h.store.ensureLoaded();
    h.reply(h.take(), range(60), 'before-sleep', true, 60, 1);
    await initial;
    const older = h.store.loadMore();
    h.reply(h.take(), range(40), 'older', true, 60, 1);
    await older;
    const failed = h.context.loadOlderHistory();
    h.take().reject(new Error('device asleep'));
    await failed;
    assert(JSON.stringify(renderedHistory(h)).includes('Retry'));

    h.store.sessionStarted();
    const deferredView = JSON.stringify(renderedHistory(h));
    assert(deferredView.includes('Waiting to refresh…') && deferredView.includes('"aria-disabled":"true"'),
      change + ': revalidation removed the pagination control');
    assert(deferredView.includes("Couldn't load older shots"),
      change + ': revalidation removed the failed-page message');
    assert.equal((await h.store.loadMore()).status, 'deferred');
    const reconnected = h.store.observeDeviceState('ready');
    const refresh = h.take();
    assert.equal(refresh.options.headers['If-None-Match'], 'before-sleep');
    if (change === 'conditional') refresh.resolve(response(null, 304));
    else h.reply(refresh, change === 'new-shot' ? range(61) : range(60),
      'after-wake', true, change === 'new-shot' ? 61 : change === 'retention' ? 50 : 60, 1);
    await reconnected;
    assert.equal(h.store.rows.length, change === 'new-shot' ? 41 : 40,
      change + ': reconnect discarded loaded pages');
    assert.equal(h.store.rows.at(-1).id, 21);
    assert(h.store.rowsAreCurrent);
    assert(JSON.stringify(renderedHistory(h)).includes('Retry'),
      change + ': reconnect lost the failed-page Retry');
    const retry = h.context.loadOlderHistory();
    const next = h.take();
    assert.equal(next.url, pageUrl + '&before=21');
    const oldest = change === 'retention' ? range(20).slice(0, 10) : range(20);
    h.reply(next, oldest, 'oldest', false, change === 'new-shot' ? 61 :
      change === 'retention' ? 50 : 60, 1);
    await retry;
    assert.equal(h.store.rows.length, h.store.total);
    assert(!JSON.stringify(renderedHistory(h)).includes('Retry'));
  }
}

async function testReconnectResetsUnrelatedHistory() {
  for (const change of ['erase', 'missing-nonce', 'empty', 'disjoint']) {
    const h = harness({ automatic: true });
    const initial = h.store.ensureLoaded();
    h.reply(h.take(), [row(6), row(5)], 'before', true, 6, 1);
    await initial;
    const older = h.store.loadMore();
    h.reply(h.take(), [row(4), row(3)], 'older', true, 6, 1);
    await older;
    h.store.sessionStarted();
    const reconnected = h.store.observeDeviceState('ready');
    const shots = change === 'empty' ? [] : change === 'disjoint'
      ? [row(30), row(29)] : [row(6, 5), row(5, 5)];
    const nonce = change === 'erase' ? 2 : change === 'missing-nonce' ? null : 1;
    h.reply(h.take(), shots, 'after', false, shots.length, nonce);
    await reconnected;
    assert.deepEqual(Array.from(h.store.rows, r => [r.id, r.userMetadata.rating]),
      shots.map(r => [r.id, r.userMetadata.rating]), change + ': retained unrelated rows');
    assert(h.store.rowsAreCurrent);
  }
}

async function testPaginationRejectsChangedStoreIdentity() {
  const h = harness({ automatic: true });
  const initial = h.store.ensureLoaded();
  h.reply(h.take(), [row(6), row(5)], 'before', true, 6, 1);
  await initial;
  const older = h.store.loadMore();
  h.reply(h.take(), [row(4, 5)], 'erased', true, 6, 2);
  assert.equal((await older).status, 'cancelled');
  assert.deepEqual(Array.from(h.store.rows, r => r.id), [6, 5]);
  assert(!h.store.rowsAreCurrent);
  const refresh = h.take();
  assert.equal(refresh.url, pageUrl);
  h.reply(refresh, [row(6, 5), row(5, 5)], 'new-store', true, 6, 2);
  await flush();
  assert(h.store.rowsAreCurrent);
  assert.equal(h.store.rows[0].userMetadata.rating, 5);
}

const historyRange = (top, bottom, rating = 1) =>
  Array.from({ length: top - bottom + 1 }, (_, i) => row(top - i, rating));

async function loadFortyShots(h) {
  const first = h.store.ensureLoaded();
  h.reply(h.take(), historyRange(60, 41), 'before', true, 60, 1);
  await first;
  const older = h.store.loadMore();
  h.reply(h.take(), historyRange(40, 21), 'older', true, 60, 1);
  await older;
}

async function testManualRefreshUpdatesLoadedRange() {
  for (const change of ['metadata', 'new-shot', 'retention', 'erase']) {
    const h = harness();
    await loadFortyShots(h);
    h.context.document.querySelector = () => null;
    const before = h.store.rows;
    const button = findElement(renderedHistory(h), node =>
      node.attrs?.['aria-label'] === 'Refresh history');
    assert(button && !button.attrs['aria-disabled']);
    const refresh = button.attrs.onclick();
    assert.equal(button.attrs.onclick(), undefined, 'repeated Refresh opened another request');
    assert(h.store.refreshingLoaded && !h.store.canRefresh);
    const first = h.take();
    assert(!first.options.headers['If-None-Match'], 'manual refresh reused a conditional page');
    const top = change === 'new-shot' ? 61 : 60;
    const total = change === 'new-shot' ? 61 : change === 'retention' ? 30 : 60;
    const nonce = change === 'erase' ? 2 : 1;
    h.reply(first, historyRange(top, top - 19, 5), 'refreshed', true, total, nonce);
    await flush();
    if (change !== 'erase') {
      assert.equal(h.store.rows, before, 'partially refreshed rows were published');
      const second = h.take();
      assert.equal(second.url, pageUrl + '&before=' + (top - 19));
      const bottom = change === 'retention' ? 31 : top - 39;
      h.reply(second, historyRange(top - 20, bottom, 5), 'second',
        change !== 'retention', total, nonce);
      await flush();
      if (change === 'new-shot') {
        const third = h.take();
        assert.equal(third.url, pageUrl + '&before=22');
        h.reply(third, historyRange(21, 2, 5), 'third', true, total, nonce);
      }
    }
    assert.equal((await refresh).status, 200);
    const bottom = change === 'erase' ? 41 : change === 'retention' ? 31 : 21;
    assert.deepEqual(Array.from(h.store.rows, r => r.id), historyRange(top, bottom).map(r => r.id));
    assert(h.store.rows.every(r => r.userMetadata.rating === 5), 'older metadata stayed stale');
    assert.equal(h.store.hasMore, change !== 'retention');
    assert.equal(h.store.total, total);
    assert(!h.store.refreshingLoaded && h.store.canRefresh);
    assert.equal(h.store.etagFor(pageUrl), 'refreshed');
  }
}

async function testManualRefreshFailureAndRetry() {
  for (const failure of ['read', 'identity']) {
    const h = harness();
    await loadFortyShots(h);
    h.context.document.querySelector = () => null;
    const before = h.store.rows;
    const refresh = h.store.refreshLoaded();
    h.reply(h.take(), historyRange(60, 41, 5), 'unpublished', true, 60, 1);
    await flush();
    const second = h.take();
    if (failure === 'read') second.reject(new Error('offline'));
    else h.reply(second, historyRange(40, 21, 5), 'different-store', true, 60, 2);
    assert.equal((await refresh).status, 'error');
    assert.equal(h.store.rows, before);
    assert.equal(h.store.etagFor(pageUrl), 'before');
    const retry = findElement(renderedHistory(h), node =>
      node.attrs?.class === 'loadmore older-history-action');
    assert(retry && retry.children.includes('Retry') && !retry.attrs.disabled);
    const pending = retry.attrs.onclick();
    const first = h.take();
    assert.equal(first.url, pageUrl, 'retry resumed in the middle of a refresh');
    h.reply(first, historyRange(60, 41, 5), 'retried', true, 60, 1);
    await flush();
    h.reply(h.take(), historyRange(40, 21, 5), 'second', true, 60, 1);
    await pending;
    assert.equal(h.store.rows.length, 40);
    assert(h.store.rows.every(r => r.userMetadata.rating === 5));
    assert.equal(h.store.error, null);
  }
}

async function testManualRefreshOrdersWritesAndPagination() {
  const h = harness();
  await loadFortyShots(h);
  const refresh = h.store.refreshLoaded();
  const pagination = h.store.loadMore();
  h.reply(h.take(), historyRange(60, 41), 'stale', true, 60, 1);
  await flush();
  const staleOlder = h.take();
  await h.write('save', 25);
  h.reply(staleOlder, historyRange(40, 21), 'stale-older', true, 60, 1);
  await flush();
  const reread = h.take();
  assert.equal(reread.url, pageUrl, 'overtaken refresh did not restart the whole range');
  assert.equal(h.store.rows.find(r => r.id === 25).userMetadata.rating, 5);
  h.reply(reread, historyRange(60, 41, 5), 'fresh', true, 60, 1);
  await flush();
  h.reply(h.take(), historyRange(40, 21, 5), 'fresh-older', true, 60, 1);
  await refresh;
  await flush();
  const final = h.take();
  assert.equal(final.url, pageUrl + '&before=21');
  h.reply(final, historyRange(20, 1), 'last', false, 60, 1);
  await pagination;
  assert.equal(h.store.rows.length, 60);
  assert.equal(h.store.rows.find(r => r.id === 25).userMetadata.rating, 5);
}

async function testManualRefreshCancelledByReconnect() {
  const h = harness({ automatic: true });
  await loadFortyShots(h);
  const refresh = h.store.refreshLoaded();
  h.reply(h.take(), historyRange(60, 41, 5), 'unpublished', true, 60, 1);
  await flush();
  const older = h.take();
  h.store.sessionStarted();
  assert(older.options.signal.aborted);
  const reconnect = h.store.observeDeviceState('ready');
  h.reply(h.take(), historyRange(61, 42), 'reconnected', true, 61, 1);
  await reconnect;
  h.reply(older, historyRange(40, 21, 5), 'obsolete', true, 60, 1);
  assert.equal((await refresh).status, 'cancelled');
  assert.equal(h.store.rows.length, 41);
  assert.equal(h.store.rows.find(r => r.id === 25).userMetadata.rating, 1);
}

async function testManualRefreshSharesTransferBudget() {
  for (const timing of ['normal', 'near-deadline', 'expired']) {
    const h = harness();
    for (let top = 250; top > 0; top -= 20) {
      const bottom = Math.max(top - 19, 1);
      const load = top === 250 ? h.store.ensureLoaded() : h.store.loadMore();
      h.reply(h.take(), historyRange(top, bottom), 'baseline', bottom > 1, 250, 1);
      await load;
    }
    const before = h.store.rows;
    const refresh = h.store.refreshLoaded();
    let elapsedTotal = 0;
    for (let page = 0; page < 12; ++page) {
      const request = h.take();
      assert.equal(request.timeoutMs, Math.min(10000, 60000 - elapsedTotal),
        'page did not respect both the page and overall deadlines');
      const elapsed = timing === 'normal' ? 2500 : page < 11 ? 5000
        : timing === 'expired' ? 5000 : 4500;
      elapsedTotal += elapsed;
      h.advance(elapsed);
      const top = 250 - page * 20;
      h.reply(request, historyRange(top, top - 19, 5), 'refreshed', true, 250, 1);
      await flush();
      assert.equal(h.store.rows, before, 'partial refresh changed displayed shots');
    }
    if (timing !== 'expired') {
      const last = h.take();
      assert.equal(last.timeoutMs, timing === 'near-deadline' ? 500 : 10000,
        'last page did not respect both the page and overall deadlines');
      h.advance(timing === 'near-deadline' ? 250 : 2500);
      h.reply(last, historyRange(10, 1, 5), 'last', false, 250, 1);
      assert.equal((await refresh).status, 200);
      assert.equal(h.store.rows.length, 250);
      assert(h.store.rows.every(item => item.userMetadata.rating === 5));
    } else {
      assert.equal((await refresh).status, 'error');
      assert.equal(h.pages.length, 0, 'refresh opened another page after its deadline');
      assert.equal(h.store.rows, before);
    }
  }
}

async function testManualRefreshRetriesShareOverallDeadline() {
  const h = harness();
  await loadFortyShots(h);
  const refresh = h.store.refreshLoaded();
  for (let attempt = 0; attempt < 3; ++attempt) {
    const head = h.take();
    assert.equal(head.timeoutMs, 10000);
    h.advance(9000);
    h.reply(head, historyRange(60, 41), 'obsolete', true, 60, 1);
    await flush();
    const older = h.take();
    assert.equal(older.timeoutMs, 10000);
    await h.write('save', 25);
    h.advance(9000);
    h.reply(older, historyRange(40, 21), 'obsolete', true, 60, 1);
    await flush();
  }
  const last = h.take();
  assert.equal(last.url, pageUrl, 'metadata write did not restart the entire range');
  assert.equal(last.timeoutMs, 6000, 'metadata write reset the overall deadline');
  h.advance(6000);
  h.reply(last, historyRange(60, 41), 'unpublished', true, 60, 1);
  assert.equal((await refresh).status, 'error');
  assert.equal(h.pages.length, 0, 'expired refresh kept reading older pages');
  assert.equal(h.store.rows.length, 40);
  assert.equal(h.store.rows.find(item => item.id === 25).userMetadata.rating, 5,
    'failed refresh lost a confirmed write');
  assert.equal(h.store.etagFor(pageUrl), 'before');
}

async function testEmptyHistoryCanBeRefreshed() {
  const h = harness();
  await h.load([]);
  const button = findElement(renderedHistory(h), node =>
    node.attrs?.['aria-label'] === 'Refresh history');
  assert(button && !button.attrs['aria-disabled']);
  const refresh = button.attrs.onclick();
  const first = h.take();
  assert(!first.options.headers['If-None-Match']);
  h.reply(first, [row(1)], 'new-shot', false, 1, 1);
  await refresh;
  assert.equal(h.store.rows.length, 1);
  assert.equal(h.store.total, 1);
}

async function testHistoryTopAndUnchangedPosition() {
  for (const atTop of [true, false]) {
    const h = harness();
    await h.load([row(90), row(89)]);
    const { viewport, list, card } = historyViewport(h);
    if (atTop) viewport.scrollY = 0;
    h.context.rememberHistoryListPosition();
    renderedHistory(h);
    assert.equal(viewport.scrollCalls, 0, 'unchanged History caused a scroll');
    for (const item of list.children) item.top += 250;
    list.children.unshift(card(91, 5500));
    renderedHistory(h);
    assert.equal(viewport.scrollY, atTop ? 0 : 5450,
      atTop ? 'new shot was scrolled off the top' : 'new shot moved the reading position');
    assert.equal(viewport.scrollCalls, atTop ? 0 : 1);
  }
}

async function testDeferredHistoryFooterOffersRecovery() {
  const h = harness();
  await loadFortyShots(h);
  h.context.document.querySelector = () => null;
  h.store.sessionStarted();
  assert(JSON.stringify(renderedHistory(h)).includes('Waiting to refresh…'));
  const refresh = h.store.ensureLoaded();
  assert(JSON.stringify(renderedHistory(h)).includes('Refreshing…'));
  h.take().reject(new Error('revalidation failed'));
  await refresh;
  const failed = renderedHistory(h);
  assert(!JSON.stringify(failed).includes('Refreshing…'));
  const retry = findElement(failed, node => node.attrs?.class === 'loadmore older-history-action');
  assert(retry.children.includes('Retry') && !retry.attrs.disabled);
  const pending = retry.attrs.onclick();
  assert.equal(h.store.pagination.status, 'deferred');
  h.reply(h.take(), historyRange(60, 41), 'recovered', true, 60, 1);
  await pending;
  assert.equal(h.store.pagination.status, 'ready');
  assert.equal(h.store.rows.length, 40);
}

async function testOlderHistorySuccessKeepsKeyboardFocus() {
  for (const outcome of ['more', 'complete', 'focus-moved']) {
    const h = harness();
    await h.load([row(3)], true, 3);
    const ui = historyControlViewport(h);
    const frames = [];
    h.context.requestAnimationFrame = callback => frames.push(callback);
    h.context.scheduleRender = () => frames.push(() => ui.render());
    h.context.view = 'list';
    ui.render();
    ui.control('older').focus();
    const older = ui.control('older').attrs.onclick();
    if (outcome === 'focus-moved') ui.control('refresh').focus();
    h.reply(h.take(), outcome === 'complete' ? [row(2), row(1)] : [row(2)],
      'older', outcome !== 'complete', 3);
    await older;
    while (frames.length) frames.shift()();
    assert.equal(h.context.document.activeElement, outcome === 'focus-moved'
      ? ui.control('refresh')
      : h.context.document.querySelector('li[data-shot-id="2"] .shot-open-link'),
      outcome + ': pagination remount lost or stole focus');
  }
}

function historyControlViewport(h) {
  let root;
  function query(node, selector) {
    const id = selector.match(/data-shot-id="(\d+)"/)?.[1];
    if (id) {
      node = node && findElement(node, item => item.dataset?.shotId === id);
      if (!selector.endsWith('.shot-open-link')) return node;
      selector = '.shot-open-link';
    }
    const action = selector.match(/^\[data-history-action="([\w-]+)"\]$/)?.[1];
    return node && findElement(node, item => action
      ? item.attrs?.['data-history-action'] === action
      : selector.startsWith('.') ? item.classList?.contains(selector.slice(1))
      : item.tag === (selector === 'ul.shotlist' ? 'ul' : selector));
  }
  h.context.window = { scrollY: 0, scrollTo(_x, y) { this.scrollY = y; } };
  h.context.document.body = {};
  h.context.document.activeElement = h.context.document.body;
  h.context.el = (tag, attrs, ...children) => {
    const node = element(tag, attrs, ...children);
    node.classList = {
      contains: name => (node.attrs.class || '').split(/\s+/).includes(name),
      add: name => { node.attrs.class = (node.attrs.class || '') + ' ' + name; },
      remove: name => { node.attrs.class = (node.attrs.class || '').split(/\s+/).filter(item => item !== name).join(' '); },
    };
    node.scrollIntoView = () => { node.scrolled = true; };
    node.getAttribute = name => node.attrs[name];
    node.focus = options => {
      node.focusOptions = options;
      if (!node.attrs.disabled) h.context.document.activeElement = node;
    };
    node.contains = target => !!findElement(node, item => item === target);
    node.closest = selector => selector === 'li[data-shot-id]'
      ? findElement(root, item => item.tag === 'li' && item.contains(node)) : null;
    node.querySelector = selector => query(node, selector);
    node.querySelectorAll = selector => {
      const matches = [];
      findElement(node, item => { if (item.tag === selector) matches.push(item); return false; });
      return matches;
    };
    node.getBoundingClientRect = () => ({ top: 0, bottom: 250 });
    return node;
  };
  h.context.document.querySelector = selector => query(root, selector);
  return {
    get root() { return root; },
    leave() {
      root = element('main');
      h.context.document.activeElement = h.context.document.body;
    },
    render() {
      if (root) h.context.rememberHistoryListPosition();
      h.context.document.activeElement = h.context.document.body;
      root = element('main');
      h.context.renderList(root);
      return root;
    },
    control(action) {
      return h.context.document.querySelector(`[data-history-action="${action}"]`);
    },
  };
}

function coffeeRow(id, coffee, rating = 4) {
  return { ...row(id, rating), startUtcSec: 100, beginMs: 0,
    durationMs: 31000, yieldCg: 3900, totalPumpOnMs: 28000,
    userMetadata: { coffee, prep: { grind: '1.8', doseG: 16, targetYieldG: 40 }, rating } };
}

function coffeeHistoryUi(h) {
  Object.assign(h.context, { fmtDate: () => 'Oct 9, 2026',
    fmtG: value => String(value / 100), fmtMMSS: () => '00:31', rawFinalCg: () => null });
  const ui = historyControlViewport(h);
  h.context.view = 'list';
  const chooseView = mode => {
    const option = findElement(ui.root, node => node.tag === 'button' &&
      node.children.includes(mode === 'coffee' ? 'By coffee' : 'All shots'));
    option.focus(); option.attrs.onclick(); ui.render();
  };
  return { ...ui, chooseView, get root() { return ui.root; } };
}

async function testCoffeeGroupingUsesLoadedBatches() {
  const h = harness();
  const coffee = { name: 'Kercha', roaster: 'Royal Mile', roastDate: '2026-09-28' };
  const rows = [coffeeRow(9, coffee),
    coffeeRow(8, { ...coffee, name: ' kercha ', roaster: 'ROYAL MILE' }),
    coffeeRow(7, { ...coffee, roastDate: '2026-09-21' }),
    coffeeRow(6, { ...coffee, roastDate: '2026-09-21' }),
    coffeeRow(5, { ...coffee, roastDate: undefined }),
    coffeeRow(4, { ...coffee, roastDate: '' }),
    coffeeRow(3, { ...coffee, roaster: 'Another roaster' }), row(2),
    { ...coffeeRow(1, coffee), userMetadataState: 'corrupt' }];
  await h.load(rows, true, 40);
  const before = JSON.stringify(h.store.rows);
  const groups = h.context.historyCoffeeGroups(h.store.rows);
  assert.deepEqual(Array.from(groups, group => Array.from(group.rows, row => row.id)),
    [[9, 8], [7, 6], [5, 4], [3], [2], [1]]);
  assert.equal(JSON.stringify(h.store.rows), before, 'grouping changed stored metadata');
  const ui = coffeeHistoryUi(h);
  ui.render();
  assert.equal(h.context.document.querySelector('ul.shotlist').children.length, 9,
    'History did not start with All shots');
  ui.chooseView('coffee');
  const cards = h.context.document.querySelector('ul.shotlist').children;
  assert.equal(cards.length, 6);
  assert.equal(cards[0].dataset.shotId, '9', 'stack did not show its newest shot');
  assert.equal(cards[3].dataset.historyKey, 'shot:3', 'single shot acquired a stack');
  assert(findElement(cards[3], node => node.children?.includes('Roasted 2026-09-28')),
    'a single-shot coffee batch hid its roast date');
  assert(findElement(cards[0], node => node.children?.includes('1 more shot with this coffee')));
  assert.equal(h.pages.length, 0, 'grouping fetched unloaded history');
  assert.equal(findElement(ui.root, node => node.tag === 'h2').children[0], '9 of 40 shots loaded');
}

async function testCoffeeDrillDownAndReturn() {
  const h = harness();
  const coffee = { name: 'Kercha', roaster: 'Royal Mile', roastDate: '2026-09-28' };
  await h.load([coffeeRow(4, coffee), coffeeRow(3, { ...coffee, roastDate: '2026-09-21' }),
    coffeeRow(2, coffee), coffeeRow(1, coffee)]);
  const ui = coffeeHistoryUi(h);
  ui.render(); ui.chooseView('coffee');
  let list = h.context.document.querySelector('ul.shotlist');
  const context = list.dataset.historyContext;
  const stack = list.children[0];
  const open = stack.querySelector('.shot-open-link');
  open.focus(); open.attrs.onclick({ stopPropagation() {} }); ui.render();
  list = h.context.document.querySelector('ul.shotlist');
  assert.deepEqual(Array.from(list.children, row => Number(row.dataset.shotId)), [4, 2, 1]);
  assert.equal(h.context.document.activeElement, ui.control('back'));
  assert.equal(ui.control('view'), null, 'coffee drill-down retained the root view switch');
  assert.equal(h.pages.length, 0, 'opening a stack fetched history');
  assert.equal(findElement(ui.root, node => node.attrs?.class === 'shot-history-heading').children[0], '3 loaded shots');
  assert(!findElement(list, node => node.attrs?.class === 'shot-identity'),
    'coffee list repeated the coffee on every shot');
  h.context.fetchBinary = async () => ({ status: 'missing' });
  h.context.loadShotMetadataForDetail = () => {};
  await h.context.selectShot(2);
  const detail = element('main');
  h.context.renderDetail(detail);
  assert(detail.children[0].children.includes('← Back to coffee shots'));
  ui.leave();
  h.context.switchView('list');
  h.reply(h.take(), h.store.rows);
  await flush(); ui.render();
  assert.equal(h.context.document.activeElement.closest('li[data-shot-id]').dataset.shotId, '2');
  ui.control('back').attrs.onclick(); ui.render();
  assert.equal(h.context.document.querySelector('ul.shotlist').dataset.historyContext, context);
  assert.equal(h.context.document.activeElement.closest('li[data-shot-id]').dataset.shotId, '4');
}

async function testCoffeeGroupsFollowLoadedMetadata() {
  const h = harness();
  const coffee = { name: 'Kercha', roaster: 'Royal Mile', roastDate: '2026-09-28' };
  await h.load([coffeeRow(4, coffee), coffeeRow(3, coffee)], true, 4);
  const ui = coffeeHistoryUi(h);
  ui.render(); ui.chooseView('coffee');
  const older = h.store.loadMore();
  h.reply(h.take(), [coffeeRow(2, coffee), coffeeRow(1, { ...coffee, name: 'Kivu' })]);
  await older; ui.render();
  let cards = h.context.document.querySelector('ul.shotlist').children;
  assert.equal(cards.length, 2);
  assert(findElement(cards[0], node => node.children?.includes('2 more shots with this coffee')));
  const changed = { ...h.store.rows[1].userMetadata,
    coffee: { ...coffee, roastDate: '2026-09-21' } };
  h.store.metadataChanged({ id: 3, state: 'active', value: changed, etag: 'changed' });
  ui.render();
  cards = h.context.document.querySelector('ul.shotlist').children;
  assert.equal(cards.length, 3, 'edited roast date did not move the shot out of its batch');
  const refresh = ui.control('refresh').attrs.onclick();
  h.take().reject(new Error('device asleep'));
  await refresh; ui.render();
  assert.equal(h.context.document.querySelector('ul.shotlist').children.length, 3,
    'failed refresh discarded the displayed stacks');
}

async function testHistoryViewMenuInteraction() {
  const h = harness();
  await h.load([row(1)]);
  const ui = coffeeHistoryUi(h);
  ui.render();
  let menu = h.context.document.querySelector('.history-view-menu');
  let trigger = ui.control('view');
  assert.equal(trigger.attrs['aria-label'], 'History view: All shots');
  trigger.attrs.onclick(); menu.open = true;
  ui.render();
  menu = h.context.document.querySelector('.history-view-menu');
  assert.equal(menu.open, true, 'background render closed the view menu');
  menu.onkeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(menu.open, false);
  assert.equal(h.context.document.activeElement, ui.control('view'));
  ui.chooseView('coffee');
  assert.equal(ui.control('view').attrs['aria-label'], 'History view: By coffee');
  assert.equal(h.context.document.activeElement, ui.control('view'));
  menu = h.context.document.querySelector('.history-view-menu');
  trigger = ui.control('view');
  trigger.attrs.onclick(); menu.open = true;
  h.context.dismissHistoryViewMenu({ target: ui.control('refresh') });
  assert.equal(menu.open, false, 'outside click left the menu open');
  assert.equal(h.pages.length, 0, 'changing the view fetched history');
}

async function testHistoryViewPreferenceRestoresAndDefaults() {
  const coffee = { name: 'Kercha', roaster: 'Royal Mile' };
  for (const saved of [null, 'all', 'coffee', '', 'stacked', '{broken']) {
    const writes = [];
    const h = harness({ storage: {
      getItem: key => key === 'pumpbug.preferences.history-view' ? saved : null,
      setItem: (...args) => writes.push(args),
    } });
    await h.load([coffeeRow(2, coffee), coffeeRow(1, coffee)]);
    const ui = coffeeHistoryUi(h); ui.render();
    const grouped = saved === 'coffee';
    assert.equal(h.context.document.querySelector('ul.shotlist').children.length, grouped ? 1 : 2,
      String(saved) + ': wrong restored History view');
    assert.equal(ui.control('view').attrs['aria-label'],
      'History view: ' + (grouped ? 'By coffee' : 'All shots'));
    assert.equal(ui.control('back'), null, 'restoration reopened a coffee list');
    assert.deepEqual(writes, [], 'restoration wrote a preference without a selection');
  }
}

async function testHistoryViewPreferencePersistsOnlySelection() {
  const key = 'pumpbug.preferences.history-view';
  const recipeKey = 'pumpbug.shot-details.v1';
  const recipe = JSON.stringify({ nextShotRecipe: { coffee: { name: 'Kivu' } } });
  const saved = new Map([[recipeKey, recipe], ['pumpbug.preferences.future-setting', 'keep']]);
  const writes = [];
  const storage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => { writes.push([key, value]); saved.set(key, value); },
  };
  const coffee = { name: 'Kercha', roaster: 'Royal Mile' };
  const rows = [coffeeRow(2, coffee), coffeeRow(1, coffee)];
  const h = harness({ storage }); await h.load(rows);
  const ui = coffeeHistoryUi(h); ui.render(); ui.chooseView('coffee');
  assert.deepEqual(writes, [[key, 'coffee']]);
  h.context.document.querySelector('ul.shotlist').children[0]
    .querySelector('.shot-open-link').attrs.onclick({ stopPropagation() {} });
  ui.render(); ui.control('back').attrs.onclick(); ui.render();
  assert.deepEqual(writes, [[key, 'coffee']], 'coffee navigation persisted temporary state');

  const restored = harness({ storage }); await restored.load(rows);
  const restoredUi = coffeeHistoryUi(restored); restoredUi.render();
  assert.equal(restored.context.document.querySelector('ul.shotlist').children.length, 1);
  assert.equal(restoredUi.control('back'), null);
  assert.equal(restored.context.document.querySelector('.history-view-menu').open, false);
  restoredUi.chooseView('all');
  assert.deepEqual(writes, [[key, 'coffee'], [key, 'all']]);

  const restoredAll = harness({ storage }); await restoredAll.load(rows);
  const allUi = coffeeHistoryUi(restoredAll); allUi.render();
  assert.equal(restoredAll.context.document.querySelector('ul.shotlist').children.length, 2);
  assert.equal(saved.get(recipeKey), recipe, 'History preference overwrote the recipe');
  assert.equal(saved.get('pumpbug.preferences.future-setting'), 'keep');
  assert.equal(writes.length, 2, 'restoration or rendering wrote browser storage');
}

async function testHistoryViewPreferenceStorageFailuresStayUsable() {
  const coffee = { name: 'Kercha', roaster: 'Royal Mile' };
  for (const failure of ['read', 'write']) {
    const h = harness({ storage: {
      getItem() { if (failure === 'read') throw new Error('storage blocked'); return null; },
      setItem() { throw new Error('storage blocked'); },
    } });
    await h.load([coffeeRow(2, coffee), coffeeRow(1, coffee)]);
    const ui = coffeeHistoryUi(h); ui.render();
    assert.equal(h.context.document.querySelector('ul.shotlist').children.length, 2);
    ui.chooseView('coffee'); ui.render();
    assert.equal(h.context.document.querySelector('ul.shotlist').children.length, 1,
      failure + ': storage failure prevented grouping for this session');
    ui.chooseView('all');
    assert.equal(h.context.document.querySelector('ul.shotlist').children.length, 2);
  }
}

async function testCoffeeViewWhenBatchDisappears() {
  const h = harness();
  const coffee = { name: 'Kercha', roaster: 'Royal Mile', roastDate: '2026-09-28' };
  await h.load([coffeeRow(2, coffee), coffeeRow(1, coffee)]);
  const ui = coffeeHistoryUi(h);
  ui.render(); ui.chooseView('coffee');
  h.context.document.querySelector('ul.shotlist').children[0]
    .querySelector('.shot-open-link').attrs.onclick({ stopPropagation() {} });
  ui.render();
  for (const id of [2, 1]) {
    h.store.metadataChanged({ id, state: 'cleared', value: null, etag: 'cleared-' + id });
  }
  ui.render();
  assert.equal(h.context.document.querySelector('ul.shotlist').children.length, 0);
  assert(findElement(ui.root, node => node.children?.includes('No loaded shots with this coffee.')));
  assert(ui.control('back'), 'an empty batch left no way back to History');
  ui.control('back').attrs.onclick(); ui.render();
  assert.equal(h.context.document.querySelector('ul.shotlist').children.length, 2);
}

async function testCoffeeContextResetAfterStorageErase() {
  const h = harness();
  const coffee = { name: 'Kercha', roaster: 'Royal Mile', roastDate: '2026-09-28' };
  const first = h.store.ensureLoaded();
  h.reply(h.take(), [coffeeRow(2, coffee), coffeeRow(1, coffee)], 'before', false, 2, 1);
  await first;
  const ui = coffeeHistoryUi(h);
  ui.render(); ui.chooseView('coffee');
  h.context.document.querySelector('ul.shotlist').children[0]
    .querySelector('.shot-open-link').attrs.onclick({ stopPropagation() {} });
  ui.render();
  const refreshed = h.store.refreshLoaded();
  h.reply(h.take(), [row(1)], 'after', false, 1, 2);
  await refreshed; ui.render();
  assert.equal(h.context.document.querySelector('ul.shotlist').children.length, 1);
  assert.equal(ui.control('back'), null, 'storage erase retained an old coffee filter');
  assert.equal(h.context.document.activeElement, ui.control('view'));
}

async function testCoffeeBackFollowsRemainingBatch() {
  const coffee = { name: 'Kercha', roaster: 'Royal Mile' };
  const other = { name: 'Kivu', roaster: 'Royal Mile' };
  for (const remaining of [1, 2, 0]) {
    const h = harness();
    const rows = [coffeeRow(4, coffee), coffeeRow(3, coffee),
      coffeeRow(2, remaining === 2 ? coffee : other), coffeeRow(1, other)];
    await h.load(rows);
    const ui = coffeeHistoryUi(h);
    const cardTops = { 4: 1400, 3: 1650, 2: 1900, 1: 2150 };
    const createElement = h.context.el;
    h.context.el = (...args) => {
      const node = createElement(...args);
      if (node.tag === 'li') {
        node.getBoundingClientRect = () => {
          const top = cardTops[node.dataset.shotId] - h.context.window.scrollY;
          return { top, bottom: top + 250 };
        };
      }
      return node;
    };
    ui.render(); ui.chooseView('coffee');
    h.context.window.scrollY = 1200;
    h.context.document.querySelector('ul.shotlist').children[0]
      .querySelector('.shot-open-link').attrs.onclick({ stopPropagation() {} });
    ui.render();
    h.store.metadataChanged({ id: 4, state: 'active', value: { coffee: other }, etag: 'moved-4' });
    if (!remaining) {
      h.store.metadataChanged({ id: 3, state: 'active', value: { coffee: other }, etag: 'moved-3' });
    }
    cardTops[4] = 400;
    cardTops[3] = 1700;
    ui.render();
    ui.control('back').attrs.onclick(); ui.render();
    const expected = remaining
      ? h.context.document.querySelector('li[data-shot-id="3"] .shot-open-link')
      : ui.control('view');
    assert(expected, remaining + ': Back left no focus target');
    assert.equal(h.context.document.activeElement, expected,
      remaining + ': Back followed the former newest shot into another coffee');
    assert.equal(expected.focusOptions?.preventScroll, true);
    assert.equal(h.context.window.scrollY, remaining ? 1500 : 1200,
      remaining + ': Back restored the moved shot instead of the coffee or saved offset');
    if (remaining) {
      assert.equal(expected.closest('li[data-shot-id]').getBoundingClientRect().top, 200,
        remaining + ': remaining coffee did not return to its former screen position');
    }
  }
}

async function testSingleCoffeeCardBecomesStackWithoutLosingFocus() {
  const h = harness();
  const coffee = { name: 'Kercha', roaster: 'Royal Mile' };
  await h.load([coffeeRow(2, coffee)], true, 2);
  const ui = coffeeHistoryUi(h);
  ui.render(); ui.chooseView('coffee');
  h.context.document.querySelector('ul.shotlist').children[0].querySelector('.shot-open-link').focus();
  const older = h.store.loadMore();
  h.reply(h.take(), [coffeeRow(1, coffee)]);
  await older; ui.render();
  const stack = h.context.document.querySelector('ul.shotlist').children[0];
  assert(stack.classList.contains('history-stack'));
  assert.equal(h.context.document.activeElement, stack.querySelector('.shot-open-link'),
    'adding a second shot lost focus when the coffee card became a stack');
}

async function testEditedCoffeeRevealsShotOutsideBatch() {
  for (const state of ['active', 'cleared']) {
    const h = harness();
    const coffee = { name: 'Kercha', roaster: 'Royal Mile' };
    await h.load([coffeeRow(2, coffee), coffeeRow(1, coffee)]);
    const ui = coffeeHistoryUi(h);
    ui.render(); ui.chooseView('coffee');
    h.context.document.querySelector('ul.shotlist').children[0]
      .querySelector('.shot-open-link').attrs.onclick({ stopPropagation() {} });
    ui.render();
    const frames = [];
    h.context.requestAnimationFrame = callback => frames.push(callback);
    h.context.setTimeout = () => 0;
    h.context.revealHistoryShotAfterRender(2);
    h.store.metadataChanged({ id: 2, state, etag: 'edited',
      value: state === 'active' ? { coffee: { name: 'Kivu' } } : null });
    ui.render();
    while (frames.length) frames.shift()();
    const edited = h.context.historyRowForShot(2);
    assert.equal(ui.control('back'), null, state + ': edited shot stayed in the wrong coffee list');
    assert.equal(edited.dataset.shotId, '2');
    assert.equal(edited.scrolled, true, state + ': edited shot was not revealed');
    assert(edited.classList.contains('recently-edited'));
  }
}

async function testOlderCoffeeHistoryFocusesOnlyNewRows() {
  const coffee = { name: 'Kercha', roaster: 'Royal Mile' };
  const otherCoffee = { name: 'Kivu', roaster: 'Royal Mile' };
  for (const outcome of ['stack', 'single', 'new-coffee', 'complete']) {
    const h = harness();
    const initial = outcome === 'single' ? [coffeeRow(4, coffee), row(3)]
      : [coffeeRow(4, coffee), coffeeRow(3, coffee)];
    await h.load(initial, true, 4);
    const ui = coffeeHistoryUi(h);
    ui.render(); ui.chooseView('coffee');
    const frames = [];
    h.context.requestAnimationFrame = callback => frames.push(callback);
    h.context.scheduleRender = () => frames.push(() => ui.render());
    ui.control('older').focus();
    const older = ui.control('older').attrs.onclick();
    h.reply(h.take(), [coffeeRow(2, coffee), coffeeRow(1,
      outcome === 'new-coffee' ? otherCoffee : coffee)], 'older', outcome !== 'complete', 4);
    await older;
    while (frames.length) frames.shift()();
    const expected = outcome === 'new-coffee'
      ? h.context.document.querySelector('li[data-shot-id="1"] .shot-open-link')
      : ui.control(outcome === 'complete' ? 'pagination' : 'older');
    assert(expected, outcome + ': pagination left no focus target');
    assert.equal(h.context.document.activeElement, expected,
      outcome + ': older shots pulled focus to a coffee already displayed');
    if (outcome !== 'new-coffee') {
      assert.equal(expected.focusOptions?.preventScroll, true,
        outcome + ': retaining footer focus could scroll the page');
    }
  }
}

async function testHistoryTabDoesNotRestoreCoffeeRowFocus() {
  const coffee = { name: 'Kercha', roaster: 'Royal Mile' };
  for (const from of ['root', 'coffee', 'detail']) {
    const h = harness();
    await h.load([coffeeRow(2, coffee), coffeeRow(1, coffee)]);
    const ui = coffeeHistoryUi(h);
    ui.render(); ui.chooseView('coffee');
    const open = h.context.document.querySelector('ul.shotlist').children[0]
      .querySelector('.shot-open-link');
    open.focus();
    if (from !== 'root') {
      open.attrs.onclick({ stopPropagation() {} }); ui.render();
    }
    if (from === 'detail') {
      h.context.fetchBinary = async () => ({ status: 'missing' });
      h.context.loadShotMetadataForDetail = () => {};
      await h.context.selectShot(1); ui.leave();
    }
    h.context.switchView('live'); ui.leave();
    h.context.switchView('list', { fromTab: true });
    h.reply(h.take(), h.store.rows); await flush(); ui.render();
    assert.equal(h.context.document.activeElement, h.context.document.body,
      from + ': History tab restored focus from an earlier visit');
  }
}

async function testHistoryViewMenuKeepsFocusedOption() {
  const h = harness(); await h.load([row(1)]);
  const ui = coffeeHistoryUi(h); ui.render();
  const menu = h.context.document.querySelector('.history-view-menu');
  ui.control('view').attrs.onclick(); menu.open = true;
  for (const text of ['All shots', 'By coffee']) {
    const option = findElement(ui.root, node => node.tag === 'button' && node.children.includes(text));
    option.focus(); ui.render();
    const restored = findElement(ui.root, node => node.tag === 'button' && node.children.includes(text));
    assert.equal(h.context.document.activeElement, restored,
      text + ': background render moved focus out of the option');
    assert.equal(h.context.document.querySelector('.history-view-menu').open, true);
  }
}

async function testHistoryTabFromDetailDoesNotRestoreRowFocus() {
  for (const focusedTab of [false, true]) {
    const h = harness();
    await h.load([row(2), row(1)]);
    const ui = coffeeHistoryUi(h);
    ui.render();
    h.context.document.querySelector('li[data-shot-id="2"] .shot-open-link').focus();
    h.context.fetchBinary = async () => ({ status: 'missing' });
    h.context.loadShotMetadataForDetail = () => {};
    await h.context.selectShot(2);
    ui.leave();
    if (focusedTab) {
      h.context.document.activeElement = h.context.el('button', {
        'data-view-focus-key': 'history-tab',
      });
    }
    h.context.switchView('list', { fromTab: true });
    h.reply(h.take(), h.store.rows); await flush(); ui.render();
    assert.equal(h.context.document.activeElement, h.context.document.body,
      'History restored a shot row after tab navigation, focusedTab=' + focusedTab);
  }
}

async function testHistoryIdentityResetDoesNotFocusView() {
  const h = harness();
  const initial = h.store.ensureLoaded();
  h.reply(h.take(), [row(2)], 'before', false, 1, 1); await initial;
  const ui = coffeeHistoryUi(h); ui.render();
  h.context.window.scrollY = 600;
  ui.control('refresh').focus();
  const refresh = h.store.refreshLoaded();
  h.reply(h.take(), [row(1)], 'after', false, 1, 2); await refresh;
  ui.render();
  assert.equal(h.context.window.scrollY, 0, 'new storage kept the old scroll position');
  assert.notEqual(h.context.document.activeElement, ui.control('view'),
    'new storage took focus without removing a coffee list');
}

async function testHistoryFocusRequestExpiresWhenRestoreSkipped() {
  for (const skipped of ['unavailable', 'reveal']) {
    const h = harness(); await h.load([row(1)]);
    const ui = coffeeHistoryUi(h); ui.render();
    const frames = [];
    h.context.requestAnimationFrame = callback => frames.push(callback);
    h.context.setTimeout = () => 0;
    const option = findElement(ui.root, node => node.tag === 'button' && node.children.includes('By coffee'));
    option.attrs.onclick();
    if (skipped === 'unavailable') h.context.state.storage = 'unavailable';
    else h.context.revealHistoryShotAfterRender(1);
    ui.render();
    while (frames.length) frames.shift()();
    h.context.state.storage = 'ready';
    if (skipped === 'reveal') ui.control('refresh').focus();
    ui.render();
    assert.equal(h.context.document.activeElement,
      skipped === 'reveal' ? ui.control('refresh') : h.context.document.body,
      skipped + ': skipped restoration moved focus on an unrelated render');
  }
}

async function testRefreshKeepsControlFocus() {
  for (const initial of ['empty', 'complete', 'more']) {
    const h = harness();
    await h.load(initial === 'empty' ? [] : [row(2)], initial === 'more',
      initial === 'empty' ? 0 : initial === 'more' ? 2 : 1);
    const ui = historyControlViewport(h);
    ui.render();
    ui.control('refresh').focus();
    const refresh = ui.control('refresh').attrs.onclick();
    ui.render();
    assert.equal(h.context.document.activeElement, ui.control('refresh'));
    assert.equal(ui.control('refresh').attrs['aria-label'], 'Refreshing history');
    assert.equal(ui.control('refresh').attrs['aria-busy'], 'true');
    assert.equal(ui.control('refresh').attrs['aria-disabled'], 'true');
    h.take().reject(new Error('offline'));
    await refresh;
    ui.render();
    assert.equal(h.context.document.activeElement, ui.control('refresh'));
    assert.equal(ui.control('refresh').attrs['aria-busy'], undefined);

    const action = initial === 'empty' ? 'refresh' : 'older';
    ui.control(action).focus();
    const retry = ui.control(action).attrs.onclick();
    ui.render();
    assert.equal(h.context.document.activeElement, ui.control(action));
    assert.equal(ui.control(action).attrs.disabled, undefined);
    assert.equal(ui.control(action).attrs['aria-disabled'], 'true');
    h.reply(h.take(), initial === 'empty' ? [] : [row(2)], 'recovered',
      initial === 'more', initial === 'empty' ? 0 : initial === 'more' ? 2 : 1);
    await retry;
    ui.render();
    assert.equal(h.context.document.activeElement,
      ui.control(initial === 'complete' ? 'refresh' : action),
      initial + ': refresh completion lost focus');
    h.context.rememberHistoryListPosition();
    ui.leave();
    ui.render();
    assert.equal(h.context.document.activeElement,
      ui.control(initial === 'complete' ? 'refresh' : action),
      initial + ': returning from another view overwrote the saved focus');
  }
}

async function testRefreshFailureHasOneMessage() {
  const h = harness();
  await h.load([row(2)], true, 2);
  h.context.document.querySelector = () => null;
  for (const action of ['refresh', 'older']) {
    const button = findElement(renderedHistory(h), node =>
      node.attrs?.['data-history-action'] === action);
    const refresh = button.attrs.onclick();
    h.take().reject(new Error('offline'));
    await refresh;
    const root = renderedHistory(h);
    const messages = [];
    findElement(root, node => {
      if (node.attrs?.id === 'history-refresh-error') messages.push(node);
      return false;
    });
    assert.equal(messages.length, 1, 'refresh failure appeared twice');
    assert.equal(messages[0].attrs.role, undefined,
      'remounting a refresh failure would announce it again');
    const paging = findElement(root, node => node.attrs?.class === 'history-pagination');
    assert.equal(!!findElement(paging, node => node === messages[0]), action === 'older',
      'refresh failure was not beside its initiating action');
    const retry = findElement(root, node =>
      node.attrs?.['data-history-action'] === action);
    assert.equal(retry.attrs['aria-describedby'], messages[0].attrs.id);
  }
}

async function testRefreshRetryWaitsForStorage() {
  const h = harness();
  await h.load([row(2)], true, 2);
  h.context.document.querySelector = () => null;
  const refresh = h.store.refreshLoaded();
  h.take().reject(new Error('offline'));
  await refresh;
  h.store.observeDeviceState('unknown', false, false);
  const retry = findElement(renderedHistory(h), node =>
    node.attrs?.['data-history-action'] === 'older');
  assert(retry.children.includes('Retry'));
  assert.equal(retry.attrs['aria-disabled'], 'true');
  assert.equal(retry.attrs.disabled, undefined);
  assert.equal(retry.attrs.onclick(), undefined);
  assert.equal(h.pages.length, 0, 'unavailable Retry started a transfer');
}

async function testBackgroundRefreshFailureUsesHeading() {
  for (const previousResult of ['success', 'failure']) {
    for (const cause of ['reconnect', 'shot-saved']) {
      const h = harness({ automatic: true });
      await h.load([row(3), row(2)], true, 3);
      h.context.document.querySelector = () => null;
      const refresh = h.store.refreshLoaded();
      h.take().reject(new Error('initial refresh failed'));
      await refresh;
      const retryButton = findElement(renderedHistory(h), node =>
        node.attrs?.['data-history-action'] === 'older');
      const retry = retryButton.attrs.onclick();
      const request = h.take();
      if (previousResult === 'success') h.reply(request, [row(3), row(2)], 'retried', true, 3);
      else request.reject(new Error('footer retry failed'));
      await retry;
      if (previousResult === 'failure') {
        const paging = findElement(renderedHistory(h), node =>
          node.attrs?.class === 'history-pagination');
        assert(findElement(paging, node => node.attrs?.id === 'history-refresh-error'));
      }
      if (cause === 'reconnect') h.store.sessionStarted();
      const background = cause === 'reconnect'
        ? h.store.observeDeviceState('ready') : h.store.shotSaved();
      h.take().reject(new Error('background refresh failed'));
      await background;
      const root = renderedHistory(h);
      const paging = findElement(root, node => node.attrs?.class === 'history-pagination');
      assert(findElement(root, node => node.attrs?.id === 'history-refresh-error'));
      assert(!findElement(paging, node => node.attrs?.id === 'history-refresh-error'),
        cause + ' after footer ' + previousResult + ': background error stayed in footer');
      assert.equal(h.store.rows.length, 2);
    }
  }
}

async function testHistoryOverscrollStaysAtTop() {
  const h = harness();
  await h.load([row(90), row(89)]);
  const { viewport, list, card } = historyViewport(h);
  viewport.scrollY = -16;
  h.context.rememberHistoryListPosition();
  viewport.scrollY = 0;
  for (const item of list.children) item.top += 250;
  list.children.unshift(card(91, 5500));
  renderedHistory(h);
  assert.equal(viewport.scrollY, 0, 'overscrolling hid a new shot above the screen');
  assert.equal(viewport.scrollCalls, 0);
}

(async () => {
  const active = [
    testPageWrites, testUncachedWritesAndConditionalResponses,
    testAutomaticDeferralAndPromotion, testPaginationAndNotifications,
    testCancellationAndLateResponses, testFailuresAndExplicitRecovery,
    testRetryProgress, testReentrantInvalidation, testPaginationAfterOvertakenResponse,
    testDemandAndEventContracts, testRecipeDemandLifecycle,
    testIndividualMetadataFreshness, testConflictFreshnessAndAcceptance,
    testClearConflictAlreadyCleared,
    testDraftAndUncertainWrite, testCancelledConflictRead, testConflictIdentity,
    testRejectedWrites, testWriteConnectionFailures,
    testEmptyShotSave, testClearedDraftSurvivesFailedSave,
    testApplicationWriteFailuresStayIdentifiable,
    testRequestFailureClassification, testRecipeFailureOutcomes,
    testFailedWritesDoNotInvalidateReads, testStreamDefersNewBackgroundReads,
    testRepeatedWritesDuringRefresh, testCancellationDuringMetadataRevalidation,
    testMetadataRevalidationFailure, testMetadataReadDoesNotRestartPage,
    testPageReadDeadline, testIndividualReadDeadline, testOvertakenPageFailure,
    testTransferDeadlineIncludesRetriedBody, testEditorDoesNotBorrowLaterMeasurements,
    testConfirmedWriteAcrossReconnect, testCompletedReadAfterDeadline,
    testReadFailureAfterDeadline, testLastShotRefreshPreservesOpenDetail,
    testMissingEditorMeasurement, testOverlappingWriteConfirmations,
    testConflictDraftCanBeRecovered, testOverlappingWritesConfirmedInRequestOrder,
    testRecipeRefreshOutcomes, testBackToDraftRequiresOverwriteChoice,
    testMetadataDownloadsIdentifyDrafts,
    testHistoryReturnKeepsCardPosition, testHistoryReturnWhenCardWasRemoved,
    testReconnectPreservesOlderHistoryAndRetry, testReconnectResetsUnrelatedHistory,
    testPaginationRejectsChangedStoreIdentity,
    testManualRefreshUpdatesLoadedRange, testManualRefreshFailureAndRetry,
    testManualRefreshOrdersWritesAndPagination, testManualRefreshCancelledByReconnect,
    testManualRefreshSharesTransferBudget, testManualRefreshRetriesShareOverallDeadline,
    testEmptyHistoryCanBeRefreshed,
    testHistoryTopAndUnchangedPosition, testDeferredHistoryFooterOffersRecovery,
    testOlderHistorySuccessKeepsKeyboardFocus,
    testRefreshKeepsControlFocus, testRefreshFailureHasOneMessage,
    testRefreshRetryWaitsForStorage, testBackgroundRefreshFailureUsesHeading,
    testHistoryOverscrollStaysAtTop,
    testCoffeeGroupingUsesLoadedBatches, testCoffeeDrillDownAndReturn,
    testCoffeeGroupsFollowLoadedMetadata, testHistoryViewMenuInteraction,
    testHistoryViewPreferenceRestoresAndDefaults, testHistoryViewPreferencePersistsOnlySelection,
    testHistoryViewPreferenceStorageFailuresStayUsable,
    testCoffeeViewWhenBatchDisappears, testCoffeeContextResetAfterStorageErase,
    testCoffeeBackFollowsRemainingBatch,
    testSingleCoffeeCardBecomesStackWithoutLosingFocus, testEditedCoffeeRevealsShotOutsideBatch,
    testOlderCoffeeHistoryFocusesOnlyNewRows, testHistoryTabDoesNotRestoreCoffeeRowFocus,
    testHistoryTabFromDetailDoesNotRestoreRowFocus,
    testHistoryViewMenuKeepsFocusedOption, testHistoryIdentityResetDoesNotFocusView,
    testHistoryFocusRequestExpiresWhenRestoreSkipped,
  ];
  for (const scenario of active) {
    await test(scenario.name, async () => {
      const first = harnesses.length;
      await scenario();
      for (const verify of harnesses.slice(first)) verify();
    });
  }

})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
