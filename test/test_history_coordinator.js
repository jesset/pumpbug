#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const [metadataPath, historyPath, constantsPath, streamPath] = process.argv.slice(2);
if (!metadataPath || !historyPath || !constantsPath || !streamPath) {
  throw new Error('usage: test_history_coordinator.js UI_METADATA_JS UI_HISTORY_JS CONSTANTS_JS STREAM_JS');
}
const pageUrl = '/app/extraction/shots?limit=20&meta=1';
const source = fs.readFileSync(historyPath, 'utf8') + '\n' +
  fs.readFileSync(metadataPath, 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const harnesses = [];

function element(tag, attrs = {}, ...children) {
  return { tag, attrs, children, childNodes: children, dataset: {},
    append(...more) { children.push(...more); }, addEventListener() {} };
}

function renderedHistory(h) {
  const root = element('main');
  h.context.renderList(root);
  return root;
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

function harness({ automatic = false, restoredRecipe = null, deferredWrites = false } = {}) {
  const pages = [];
  const reads = [];
  const writes = [];
  const banners = [];
  const transfers = new Set();
  let overlaps = 0;
  let now = 0;
  const context = {
    console, TextEncoder, AbortController, el: element, state: { storage: 'ready' },
    performance: { now: () => now },
    inPumpWindow: state => !!state && state.active &&
      (state.phase === 'RUNNING' || state.phase === 'POST_PUMP'),
    lastRecord: null, selectedShot: null, selectedShotId: null,
    selectedShotMetadata: null, view: 'live',
    scheduleRender() {}, flashBanner: message => banners.push(message),
    localStorage: {
      getItem: () => restoredRecipe ? JSON.stringify({ nextShotRecipe: restoredRecipe }) : null,
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
  function reply(request, shots, etag = 'baseline', hasMore = false, total = shots.length) {
    request.resolve(response({ shots, hasMore, total }, 200, { ETag: etag }));
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
    if (action === 'select') h.context.chooseCoffee({ name: 'Selected' });
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
          : h.context.loadShotMetadata(1);
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

async function testWritesAcrossReconnect() {
  for (const kind of ['save', 'clear', 'initialize']) {
    for (const transition of ['reconnect', 'storage']) {
      const h = harness({ deferredWrites: true });
      await h.load([row(1)]);
      h.context.api.setSelected(1);
      const editor = { kind: 'shot', id: 1, record: { etag: 'original' },
        original: { notes: 'Keep this draft' }, saving: false, conflict: null };
      h.context.api.setEditor(editor);
      const pending = kind === 'initialize'
        ? h.context.setLastShotMetadataId(1, { notes: 'Recipe' })
        : kind === 'clear' ? h.context.clearShotMetadata(editor)
        : h.context.writeShotMetadata(editor, editor.original);
      const write = h.take(h.writes);
      if (transition === 'reconnect') h.store.sessionStarted();
      else {
        h.store.observeDeviceState('unavailable');
        h.store.observeDeviceState('ready', false, false);
      }
      assert.equal(h.context.api.editor(), editor);
      assert.equal(editor.conflict, null);
      assert.equal(write.options.signal, undefined, 'read cancellation must not cancel a mutation');
      if (kind !== 'initialize') {
        assert(editor.saving);
        assert.equal(write.options.headers['If-Match'], 'original');
      }
      // Revalidate an ID that might refer to a different device record.
      const revalidation = h.store.refresh();
      h.reply(h.take(), [row(1, 2)], 'new-device');
      await revalidation;
      h.context.api.setSelected(1);
      h.context.selectedShotMetadata = { id: 1, state: 'active', value: { rating: 2 } };
      const reading = h.context.resolveShotMetadata(1);
      const staleRead = h.take(h.reads);
      const refreshing = h.store.refresh();
      const stalePage = h.take();
      h.replyMetadata(write, kind === 'clear' ? null : 5, 'old-device-confirmation');
      await pending;
      assert.equal(h.store.rows[0].userMetadata.rating, 2,
        'an old confirmation must not populate the revalidated ID');
      if (kind !== 'initialize') {
        assert.equal(h.context.api.editor(), null);
        assert(h.banners.includes(kind === 'clear' ? 'Shot details cleared.' : 'Shot details saved.'));
      }
      // Both current per-shot and page reads must observe the write boundary.
      h.replyMetadata(staleRead, 1, 'stale-read');
      h.reply(stalePage, [row(1)], 'stale-page');
      await flush();
      assert(h.reads.length >= 1);
      assert(!['stale-read', 'old-device-confirmation'].includes(
        h.context.selectedShotMetadata.etag));
      while (h.reads.length) h.replyMetadata(h.reads.shift(), 2, 'current-device');
      while (h.pages.length) {
        h.reply(h.pages.shift(), [row(1, 2)], 'current-device');
        await flush();
      }
      await Promise.all([reading, refreshing]);
      assert.equal(h.context.selectedShotMetadata.value.rating, 2);
      assert.equal(h.store.rows[0].userMetadata.rating, 2);
    }
  }
}

async function testDraftAndUncertainWrite() {
  for (const kind of ['save', 'clear']) {
    const h = harness({ deferredWrites: true });
    await h.load([row(1)]);
    const editor = { kind: 'shot', id: 1, record: { etag: 'original' },
      original: { notes: 'My draft' }, saving: false, conflict: null };
    h.context.api.setEditor(editor);
    const shot = h.context.metadataEditorShot();
    let renders = 0;
    h.context.renderMetadataOverlay = () => { ++renders; };
    h.store.sessionStarted();
    assert.equal(renders, 0, 'a reconnect must leave the editable form in place');
    assert.equal(h.context.metadataEditorShot(), shot);
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
  conflictRead.reject(new Error('aborted'));
  await pending;
  assert(!editor.saving);
  assert.equal(editor.conflict, null);
  assert.equal(editor.original.notes, 'My draft');
  assert.match(editor.error, /current version could not be loaded/);
}

async function testConflictIdentity(mismatchAt = 'write') {
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
      h.take(h.writes).resolve(response(null, 412, mismatchAt === 'write'
        ? { 'X-Shot-Metadata-Conflict': 'shot-identity' } : {}));
      await flush();
      if (mismatchAt === 'read') {
        h.replyMetadata(h.take(h.reads), 3, '"shot-meta-00000002-00000001-v-00000003"');
      }
      await pending;
      assert(!editor.saving);
      assert.equal(editor.conflict.action, 'identity');
      if (kind === 'clear') assert.equal(editor.conflict.localValue, null);
      else assert.equal(editor.conflict.localValue.notes, 'My draft');
      assert.equal(JSON.stringify(h.context.renderMetadataConflict()).includes('Your unsaved changes'),
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
      assert.match(editor.error, clearing ? /clear failed/ : /save failed/);
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
  h.context.openMetadataEditor(1, {
    id: 1, state: 'active', value: {}, etag,
  });
  const editor = h.context.api.editor();
  const shot = h.context.metadataEditorShot();
  h.store.sessionStarted();
  const refresh = h.store.refresh();
  h.reply(h.take(), [{ ...row(1), yieldCg: 9000,
    userMetadataEtag: '"shot-meta-00000002-00000001-v-00000001"' }]);
  await refresh;
  assert.equal(h.context.api.editor(), editor);
  assert.equal(h.context.metadataEditorShot(), shot,
    'an ID reused after a reboot replaced the editor measurement');
}

async function testOldRowActionRevalidates() {
  const h = harness();
  h.context.el = (_tag, attributes) => attributes;
  h.context.view = 'list';
  await h.load([row(1)]);
  const button = h.context.shotMetadataListAction(1, h.context.metadataRecordFromRow(row(1)));
  h.store.sessionStarted();
  button.onclick({ stopPropagation() {} });
  h.replyMetadata(h.take(h.reads), 3, 'revalidated');
  await flush();
  assert.equal(h.context.api.editor().record.etag, 'revalidated');
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
  vm.runInContext(fs.readFileSync(constantsPath, 'utf8') + '\n' +
    fs.readFileSync(streamPath, 'utf8'), h.context);
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
        : consumer === 'editor' ? h.context.loadShotMetadata(1)
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

async function testEditorMeasurementBecomesAvailable() {
  const h = harness();
  const record = { id: 1, state: 'active', etag: 'original', value: {} };
  h.context.openMetadataEditor(1, record);
  assert.equal(h.context.metadataEditorShot(), null);
  const editor = h.context.api.editor();
  await h.load([{ ...row(1), yieldCg: 3600 }]);
  assert.equal(h.context.api.editor(), editor);
  assert.equal(h.context.metadataEditorShot().yieldCg, 3600);
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

async function testConflictIdentityAfterReboot() {
  await testConflictIdentity('read');
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

// Execute unresolved device-identity and concurrent-write scenarios as TODOs.
// Their failures are reported separately from the enforced regression checks.
(async () => {
  const active = [
    testPageWrites, testUncachedWritesAndConditionalResponses,
    testAutomaticDeferralAndPromotion, testPaginationAndNotifications,
    testCancellationAndLateResponses, testFailuresAndExplicitRecovery,
    testRetryProgress, testReentrantInvalidation, testPaginationAfterOvertakenResponse,
    testDemandAndEventContracts, testRecipeDemandLifecycle,
    testIndividualMetadataFreshness, testConflictFreshnessAndAcceptance,
    testDraftAndUncertainWrite, testCancelledConflictRead, testConflictIdentity,
    testRejectedWrites, testRecipeFailureOutcomes,
    testFailedWritesDoNotInvalidateReads, testStreamDefersNewBackgroundReads,
    testRepeatedWritesDuringRefresh, testCancellationDuringMetadataRevalidation,
    testMetadataRevalidationFailure, testMetadataReadDoesNotRestartPage,
    testPageReadDeadline, testIndividualReadDeadline, testOvertakenPageFailure,
    testTransferDeadlineIncludesRetriedBody, testEditorMeasurementBecomesAvailable,
    testConfirmedWriteAcrossReconnect, testCompletedReadAfterDeadline,
    testReadFailureAfterDeadline, testLastShotRefreshPreservesOpenDetail,
  ];
  for (const scenario of active) {
    await test(scenario.name, async () => {
      const first = harnesses.length;
      await scenario();
      for (const verify of harnesses.slice(first)) verify();
    });
  }
  const pending = [
    testWritesAcrossReconnect, testConflictIdentityAfterReboot,
    testOldRowActionRevalidates, testMissingEditorMeasurement,
    testOverlappingWriteConfirmations,
  ];
  for (const scenario of pending) {
    await test(scenario.name, { todo: 'separate identity/write-order protection' }, scenario);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
