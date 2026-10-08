// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// Newest-first pagination with a cheap in-app ETag revalidation. The first
// page's validator is kept in the history store and sent as If-None-Match.
// An unchanged in-app refresh is a 304: the device lists the page's IDs but
// skips reading each shot's summary and metadata. The cache lives only in
// memory, so a full page reload simply re-fetches page 1 (a 200, one bounded
// page) — we don't try to make reloads 304. Shot detail blobs are revalidated
// so reusing an ID after storage is erased cannot serve an old shot from the
// browser cache.
const SHOTS_LIMIT = 20;
// Default limit for receiving headers and body, so a stalled request releases
// its browser resources and the UI can recover. Reads retried after a confirmed
// metadata write share this budget across attempts.
const SHOTS_FETCH_TIMEOUT_MS = 10000;
let historyRevealShotId = null;

function revealHistoryShotAfterRender(id) {
  historyRevealShotId = id;
}

function requestError(kind, message, cause) {
  return Object.assign(new Error(message), { kind, cause });
}

async function readResponseBody(response, method) {
  if (response.bodyUsed || response.body?.locked) {
    throw new TypeError('Response body is already in use.');
  }
  const reading = response[method]();
  try {
    return await reading;
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'TypeError') {
      throw requestError('network', 'Device response was interrupted.', error);
    }
    throw error;
  }
}

async function fetchWithTimeout(path, opts, consume, timeoutMs) {
  const ctrl = new AbortController();
  const callerSignal = opts && opts.signal;
  let abortError = null;
  const abort = (kind, message) => {
    if (ctrl.signal.aborted) return;
    abortError = requestError(kind, message);
    ctrl.abort();
  };
  const abortForCaller = () => abort('cancelled', 'Request cancelled.');
  if (callerSignal) {
    if (callerSignal.aborted) abortForCaller();
    else callerSignal.addEventListener('abort', abortForCaller, { once: true });
  }
  const timer = setTimeout(() => abort('timeout', 'Device did not respond.'),
                           timeoutMs != null ? timeoutMs : SHOTS_FETCH_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(path, { ...(opts || {}), signal: ctrl.signal });
    } catch (error) {
      throw abortError || requestError('network', 'Could not reach the device.', error);
    }
    try {
      return await consume(response);
    } catch (error) {
      if (abortError && error.kind === 'network') throw abortError;
      throw error;
    }
  } finally {
    clearTimeout(timer);
    if (callerSignal) {
      callerSignal.removeEventListener('abort', abortForCaller);
    }
  }
}

async function fetchBinary(path) {
  // Default cache mode lets the browser revalidate a previously viewed shot
  // with its ETag instead of downloading it again.
  return fetchWithTimeout(path, { cache: 'default' }, async r => {
    if (r.status === 404) return { status: 'missing' };
    if (r.status === 422) return { status: 'invalid' };
    if (!r.ok) throw new Error(path + ' ' + r.status);
    const bytes = await readResponseBody(r, 'arrayBuffer');
    try {
      return { status: 'ok', shot: parseExtraction(bytes) };
    } catch (err) {
      console.warn('parseExtraction failed', err);
      return { status: 'invalid' };
    }
  });
}

// Fetch one page (before=0 → newest). Returns { status:304 } when the cached
// ETag still matches, else { status:200, shots, hasMore, total }. The caller
// commits the ETag only after applying the response. timeoutMs is the remaining
// budget for this attempt, including headers and body.
async function fetchShotsPage(before, signal, timeoutMs) {
  let url = '/app/extraction/shots?limit=' + SHOTS_LIMIT + '&meta=1';
  if (before) url += '&before=' + before;
  const headers = {};
  // Older pages are not retained separately after page one replaces the list,
  // so only page one has data available to satisfy a 304.
  const etag = !before ? historyStore.etagFor(url) : null;
  if (etag) headers['If-None-Match'] = etag;
  return fetchWithTimeout(
    url, { cache: 'no-store', headers, signal }, async r => {
      if (r.status === 304) return { status: 304 };
      if (!r.ok) throw new Error('shots ' + r.status);
      const j = await readResponseBody(r, 'json');
      return {
        status: 200,
        url,
        etag: r.headers.get('ETag'),
        shots: Array.isArray(j.shots) ? j.shots : [],
        hasMore: !!j.hasMore,
        total: typeof j.total === 'number' ? j.total : 0,
      };
    }, timeoutMs);
}

// Owns all history HTTP requests and their cached rows. History stays unloaded
// until a view requests it. Connection and storage events invalidate the
// cache, and the store orders replacement, saved-shot refresh, and pagination.
const historyStore = (() => {
  let rows = null;
  let hasMore = false;
  let total = 0;
  // Once requested, history remains available to the Live coffee context and
  // History view for the rest of this page session.
  let requested = false;
  let storageStatus = null;
  let invalidationGeneration = 0;
  let validatedGeneration = 0;
  // Automatic work stays pending while background reads are deferred. A
  // page-one request records which save notifications it can include, so a
  // notification received during that request causes a later refresh.
  let savedShotRevision = 0;
  let refreshedShotRevision = 0;
  // Prevents list and individual metadata reads from publishing results that
  // predate a confirmed metadata edit.
  let metadataWriteRevision = 0;
  let backgroundRefreshAllowed = true;
  let backgroundRefreshPromise = null;
  let activeRequest = null;
  let loadMorePromise = null;
  let loading = false;
  let error = null;
  let failedRequest = null;
  const listeners = new Set();
  const etags = {};

  function notify() {
    for (const listener of listeners) listener();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function invalidate() {
    ++invalidationGeneration;
    // Every active request was derived from this generation's rows or
    // validators. Revalidation establishes the next generation; foreground
    // pagination can then start again from its rows rather than crossing the
    // boundary with an obsolete cursor.
    if (activeRequest) activeRequest.controller.abort();
    // Invalidation changes whether cached rows and their actions are current,
    // even when there is no request to deliver a later notification.
    notify();
  }

  // Re-read when a confirmed metadata write overtakes an attempt. Apply its
  // result synchronously after checking the revision so no write can intervene.
  // The deadline limits retries; a completed, unaffected response is usable
  // even if browser timer throttling let the transfer finish late.
  async function readWithMetadataRevalidation(
      read, apply, { signal, fail = err => { throw err; } } = {}) {
    let remaining = SHOTS_FETCH_TIMEOUT_MS;
    const deadline = performance.now() + remaining;
    while (true) {
      if (signal && signal.aborted) return fail(new Error('Read cancelled.'));
      const revision = metadataWriteRevision;
      let result;
      let failure;
      try {
        result = await read(remaining);
      } catch (err) {
        failure = err;
      }
      if (signal && signal.aborted) return fail(new Error('Read cancelled.'));
      if (revision === metadataWriteRevision) {
        return failure ? fail(failure) : apply(result);
      }
      remaining = deadline - performance.now();
      if (remaining <= 0) {
        return fail(failure || new Error('Refresh timed out.'));
      }
    }
  }

  function applyShotsPage(request, res) {
    const { before, preserveRows } = request;
    if (activeRequest !== request ||
        request.invalidationGeneration !== invalidationGeneration) {
      return { status: 'cancelled' };
    }
    if (res.status === 200) {
      if (before) {
        rows = rows.concat(res.shots);
        hasMore = res.hasMore;
      } else if (preserveRows && rows) {
        const cachedIds = new Set(rows.map(row => row.id));
        const firstPageConnects = res.shots.length && rows.length &&
          res.shots[0].id >= rows[0].id &&
          res.shots.some(row => cachedIds.has(row.id));
        if (firstPageConnects) {
          const byId = new Map();
          for (const row of rows.concat(res.shots)) byId.set(row.id, row);
          rows = [...byId.values()].sort((a, b) => b.id - a.id)
            .slice(0, res.total);
          hasMore = rows.length < res.total;
        } else {
          rows = res.shots;
          hasMore = res.hasMore;
        }
      } else {
        rows = res.shots;
        hasMore = res.hasMore;
      }
      total = res.total;
      if (!before && res.etag) etags[res.url] = res.etag;
    }
    if (request.authoritative) {
      validatedGeneration = Math.max(
        validatedGeneration, request.invalidationGeneration);
    }
    if (!before && (res.status === 200 || res.status === 304)) {
      refreshedShotRevision = Math.max(
        refreshedShotRevision, request.savedShotRevision);
    }
    return { status: res.status };
  }

  function requestPage(before, preserveRows = false) {
    if (activeRequest) activeRequest.controller.abort();
    const request = {
      before,
      preserveRows,
      authoritative: !before && !preserveRows,
      invalidationGeneration,
      savedShotRevision,
      controller: new AbortController(),
      promise: null,
    };
    activeRequest = request;
    loading = true;
    // Page-one failures are durable because their retry is independent of any
    // row cursor. Pagination failures belong only to the initiating action.
    if (!before) {
      error = null;
      failedRequest = null;
    }
    request.promise = (async () => {
      try {
        return await readWithMetadataRevalidation(
          timeoutMs => fetchShotsPage(before, request.controller.signal, timeoutMs),
          res => applyShotsPage(request, res),
          { signal: request.controller.signal });
      } catch (err) {
        if (request.controller.signal.aborted || activeRequest !== request) {
          return { status: 'cancelled' };
        }
        if (!before) {
          error = err;
          failedRequest = { preserveRows };
        }
        return { status: 'error', error: err };
      } finally {
        if (activeRequest === request) {
          activeRequest = null;
          loading = false;
          // loadMore() owns the final pagination notification so consumers see
          // the settled rows/error and loading state in one render.
          if (!request.before) notify();
        }
      }
    })();
    notify();
    return request.promise;
  }

  function storageIsReady() {
    return storageStatus === 'ready';
  }

  function requestAuthoritativePage() {
    if (!storageIsReady()) {
      return Promise.resolve({ status: 'deferred' });
    }
    if (activeRequest && activeRequest.authoritative &&
        activeRequest.invalidationGeneration === invalidationGeneration) {
      return activeRequest.promise;
    }
    return requestPage(0);
  }

  async function ensureLoaded() {
    requested = true;
    if (!storageIsReady()) return { status: 'deferred' };
    if (rows !== null && validatedGeneration === invalidationGeneration) {
      return { status: 'ready' };
    }
    return requestAuthoritativePage();
  }

  async function refresh() {
    requested = true;
    return requestAuthoritativePage();
  }

  // Page-one replacement has priority over operations that depend on the
  // current rows. Once it completes, callers recompute their request from the
  // replacement rather than using cursors or merge assumptions from before it.
  async function waitForAuthoritativeRequest() {
    let result = null;
    while (activeRequest && activeRequest.authoritative) {
      result = await activeRequest.promise;
    }
    return result;
  }

  async function waitForPageOneRequest() {
    let result = null;
    while (activeRequest && !activeRequest.before) {
      result = await activeRequest.promise;
    }
    return result;
  }

  async function refreshPreservingRows() {
    requested = true;
    if (!storageIsReady()) return { status: 'deferred' };
    // Both dependencies can appear while the other is settling: pagination
    // may already be queued behind replacement, and replacement can supersede
    // pagination. Recheck until neither can invalidate a preserving merge.
    while (true) {
      if (activeRequest && activeRequest.authoritative) {
        const result = await waitForAuthoritativeRequest();
        if (result && result.status === 'error') return requestPage(0);
        continue;
      }
      if (loadMorePromise) {
        await loadMorePromise;
        continue;
      }
      break;
    }
    if (rows === null || validatedGeneration !== invalidationGeneration) {
      return requestAuthoritativePage();
    }
    return requestPage(0, true);
  }

  async function retry() {
    if (!failedRequest) return { status: 'ready' };
    if (!storageIsReady()) return { status: 'deferred' };
    const request = failedRequest;
    return request.preserveRows ? refreshPreservingRows()
                                : requestAuthoritativePage();
  }

  async function loadMore() {
    if (loadMorePromise) return loadMorePromise;
    if (!requested || !storageIsReady() || !hasMore || !rows ||
        !rows.length) {
      return { status: 'ready' };
    }
    if (validatedGeneration !== invalidationGeneration) {
      return { status: 'deferred' };
    }
    const operationGeneration = invalidationGeneration;
    const operation = (async () => {
      while (true) {
        if (operationGeneration !== invalidationGeneration) {
          return { status: 'cancelled' };
        }
        if (activeRequest && !activeRequest.before) {
          const pageOneResult = await waitForPageOneRequest();
          if (operationGeneration !== invalidationGeneration) {
            return { status: 'cancelled' };
          }
          if (pageOneResult && pageOneResult.status === 'error') {
            return pageOneResult;
          }
          continue;
        }
        // Page one may have failed before pagination began or while it waited.
        // Retry that prerequisite before calculating an older-page cursor.
        if (failedRequest) {
          const request = failedRequest;
          // Issue the prerequisite request directly: this pagination operation
          // owns loadMorePromise, which refreshPreservingRows() waits for.
          const pageOneResult = request.preserveRows
            ? await requestPage(0, true)
            : await requestAuthoritativePage();
          if (operationGeneration !== invalidationGeneration) {
            return { status: 'cancelled' };
          }
          if (pageOneResult.status === 'error' ||
              pageOneResult.status === 'deferred') {
            return pageOneResult;
          }
          continue;
        }
        break;
      }
      if (!hasMore || !rows || !rows.length) return { status: 'ready' };
      const pageResult = await requestPage(rows[rows.length - 1].id);
      return operationGeneration === invalidationGeneration
        ? pageResult : { status: 'cancelled' };
    })();
    const requestStarted = !!activeRequest && !!activeRequest.before;
    loadMorePromise = operation;
    // A queued pagination request has not called requestPage() yet, so publish
    // its loading state here. A request that started immediately already did.
    if (!requestStarted) notify();
    try {
      return await operation;
    } finally {
      if (loadMorePromise === operation) {
        loadMorePromise = null;
        notify();
      }
    }
  }

  function paginationState() {
    if (storageStatus === 'unavailable') {
      return { status: 'unavailable' };
    }
    if (!storageIsReady()) return { status: 'deferred' };
    if (validatedGeneration !== invalidationGeneration) {
      return { status: 'deferred' };
    }
    if (loadMorePromise || (activeRequest && activeRequest.before)) {
      return { status: 'loading' };
    }
    if (!hasMore || !rows || !rows.length) return { status: 'complete' };
    return { status: 'ready' };
  }

  // Only confirmed writes advance this revision. Publishing a GET result must
  // not restart other reads.
  function metadataWritten() {
    ++metadataWriteRevision;
  }

  function metadataChanged(record) {
    if (!record.state || !rows) return;
    const row = rows.find(item => item.id === record.id);
    if (!row) return;
    row.userMetadataState = record.state;
    row.userMetadata = record.value;
    row.userMetadataCrc = record.crc;
    row.userMetadataEtag = record.etag;
    notify();
  }

  function runBackgroundRefresh() {
    if (backgroundRefreshPromise) return backgroundRefreshPromise;
    if (!requested || !storageIsReady() || !backgroundRefreshAllowed) {
      return Promise.resolve({ status: 'deferred' });
    }
    const operation = (async () => {
      let lastResult = { status: 'ready' };
      while (requested && storageIsReady() && backgroundRefreshAllowed) {
        let result;
        if (validatedGeneration !== invalidationGeneration) {
          result = await requestAuthoritativePage();
        } else if (refreshedShotRevision < savedShotRevision) {
          result = await refreshPreservingRows();
        } else {
          return lastResult;
        }
        lastResult = result;
        if (result.status === 'error' || result.status === 'deferred') {
          return result;
        }
      }
      return lastResult.status === 'ready'
        ? { status: 'deferred' } : lastResult;
    })();
    backgroundRefreshPromise = operation;
    operation.finally(() => {
      if (backgroundRefreshPromise === operation) {
        backgroundRefreshPromise = null;
      }
    });
    return operation;
  }

  function shotSaved() {
    ++savedShotRevision;
    return runBackgroundRefresh();
  }

  function sessionStarted() {
    invalidate();
  }

  function observeDeviceState(
      storage, savedShot = false, allowBackgroundRefresh = true) {
    const previousStorage = storageStatus;
    storageStatus = storage;
    backgroundRefreshAllowed = allowBackgroundRefresh;
    if (savedShot) ++savedShotRevision;
    if (previousStorage === null) {
      notify();
    } else if (previousStorage !== storage) {
      invalidate();
    }
    if (!storageIsReady() && activeRequest) {
      activeRequest.controller.abort();
    }
    return runBackgroundRefresh();
  }

  function etagFor(url) {
    return etags[url] || null;
  }

  return {
    get rows() { return rows; },
    get rowsAreCurrent() {
      return rows !== null && validatedGeneration === invalidationGeneration;
    },
    get hasMore() { return hasMore; },
    get total() { return total; },
    get loading() { return loading; },
    get error() { return error; },
    get pagination() { return paginationState(); },
    subscribe,
    ensureLoaded,
    refresh,
    refreshPreservingRows,
    retry,
    loadMore,
    get metadataRevision() { return metadataWriteRevision; },
    metadataWritten,
    readWithMetadataRevalidation,
    metadataChanged,
    shotSaved,
    sessionStarted,
    observeDeviceState,
    etagFor,
  };
})();

function switchView(next) {
  if (view === next) return;
  cancelMetadataEditorLoad();
  view = next;
  if (next !== 'detail') {
    selectedShotId = null;
    selectedShot = null;
    selectedShotError = null;
    selectedShotMetadata = null;
  }
  scheduleRender();
  // On entry, revalidate page one without discarding older pages the user may
  // already have loaded for the coffee-history view.
  if (next === 'list') historyStore.refreshPreservingRows();
}

async function selectShot(id) {
  cancelMetadataEditorLoad();
  selectedShotId = id;
  selectedShot = null;
  selectedShotError = null;
  selectedShotMetadata = { id, loading: true };
  view = 'detail';
  scheduleRender();
  loadShotMetadataForDetail(id);
  try {
    const result = await fetchBinary('/app/extraction/shots?id=' + id);
    if (selectedShotId !== id) return;  // user navigated away
    if (result.status === 'ok') {
      selectedShot = result.shot;
    } else if (result.status === 'missing') {
      selectedShotError = 'not_found';
    } else {
      selectedShotError = 'invalid';
    }
    scheduleRender();
  } catch (err) {
    if (selectedShotId !== id) return;
    selectedShotError = 'error';
    flashBanner('Error loading shot #' + id + ': ' + err.message, 'bad');
    scheduleRender();
  }
}

// Load this shot onto the device as its on-device "last shot", so it can be
// replayed on the device for UI testing. Device-local only: it does not touch
// the shot history or other web clients (see ExtractionController).
async function setAsLastShot(id) {
  try {
    const res = await fetchWithTimeout('/app/extraction/loaded?id=' + id,
      { method: 'POST' }, response => ({
        ok: response.ok,
        status: response.status,
      }));
    if (res.ok) {
      // Jump to the live view — the operator's next step is at the device
      // (replay from the LAST SHOT screen). flashBanner survives the render the
      // view switch triggers, so the confirmation actually shows.
      switchView('live');
      flashBanner('Loaded shot #' + id + ' on the device — replay it from the '
                  + 'LAST SHOT screen', 'live');
    } else {
      flashBanner('Could not load shot #' + id + ' (HTTP ' + res.status + ')',
                  'bad');
    }
  } catch (err) {
    flashBanner('Could not load shot #' + id + ': ' + err.message, 'bad');
  }
}

// Render an enum index through its label table, falling back to the raw number
// for any value the table doesn't cover (e.g. a newer firmware enum).
function labelOf(table, i) {
  return i in table ? table[i] : i;
}

// Save the already-decoded shot as JSON, entirely client-side — the browser
// parsed the binary blob to render the detail view, so there's nothing to ask
// the device for. We tag the file with the shot id (which the decoded object
// itself doesn't carry) so the download is self-describing, and map the wire
// enums (phase, end cause, flag bits, event kinds) to their labels so the file
// reads on its own. Numeric measurements stay in centigrams, as decoded.
function downloadShotJson(id, shot, metadata) {
  if (!metadata || metadata.loading) return false;
  const readable = {
    id,
    ...shot,
    userMetadataState: metadata.state,
    userMetadata: metadata.state === 'active' ? metadata.value : null,
    phase: labelOf(PHASE, shot.phase),
    endCause: labelOf(END_CAUSE, shot.endCause),
    flags: {
      eventsOverflowed: (shot.flags & 0x01) !== 0,
      scaleTimers: (shot.flags & RECORD_FLAG_SCALE_TIMERS) !== 0,
    },
    events: shot.events.map(ev => ({
      ...ev,
      kind: eventKindLabel(shot.version, ev.kind),
    })),
  };
  const json = JSON.stringify(readable, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = el('a', { href: url, download: 'shot-' + id + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

function shotOpenButton(id, label) {
  return el('button', {
    type: 'button', class: 'when shot-open-link',
    'aria-label': label + ', open shot #' + id,
    onclick: event => {
      event.stopPropagation();
      selectShot(id);
    },
  }, label);
}

async function loadMoreHistory(reportError = message => flashBanner(message, 'bad')) {
  const result = await historyStore.loadMore();
  if (result.status === 'error') {
    reportError('Could not load older history: ' + result.error.message);
  }
  return result;
}

function renderHistoryShot(summary) {
  const data = shotSummaryData(summary);
  const { record } = data;
  const item = el('li', { onclick: () => selectShot(summary.id) },
    shotDate(summary),
    el('div', { class: 'shot-identity' },
      shotCoffeeIdentity(summary.id, data, 'Shot #' + summary.id),
      shotMetadataListAction(summary)), shotMetrics(summary));
  item.dataset.shotId = String(summary.id);
  appendShotResult(item, data, { compact: true });
  if (record && record.state !== 'active') appendShotSummary(item, summary);
  return item;
}

function renderList(app) {
  if (state.storage === 'unavailable') {
    return;
  }
  const rows = historyStore.rows;
  if (rows === null) {
    if (historyStore.error) {
      app.append(el('div', { class: 'empty' },
        el('p', { class: 'err' }, 'Shot history could not be loaded.'),
        el('button', { class: 'secondary',
          onclick: () => historyStore.retry() },
          'Retry')));
    } else if (historyStore.loading) {
      app.append(el('p', { class: 'empty' }, 'Loading shots…'));
    } else {
      app.append(el('p', { class: 'empty' },
        'Shot history is waiting to refresh.'));
    }
    return;
  }
  if (historyStore.error) {
    app.append(el('div', { class: 'storage-warning' },
      el('span', {}, 'Shot history may be out of date. '),
      el('button', { class: 'backlink',
        onclick: () => historyStore.retry() }, 'Retry')));
  }
  if (!rows.length) {
    app.append(el('p', { class: 'empty' }, 'No shots recorded yet.'));
    return;
  }
  const ul = el('ul', { class: 'shotlist' });
  for (const s of rows) {
    const hasSummary = Number.isFinite(s.startUtcSec) &&
      Number.isFinite(s.beginMs) && Number.isFinite(s.durationMs) &&
      Number.isFinite(s.yieldCg) && Number.isFinite(s.totalPumpOnMs);
    if (!hasSummary) {
      const item = el('li', { class: 'unavailable',
                             onclick: () => selectShot(s.id) },
        el('div', { class: 'head' },
          shotOpenButton(s.id, 'Record unavailable'),
          el('span', { class: 'shot-row-actions' },
            el('span', { class: 'id' }, '#' + s.id),
            shotMetadataListAction(s)),
        ),
      );
      item.dataset.shotId = String(s.id);
      appendShotSummary(item, s);
      ul.append(item);
      continue;
    }
    ul.append(renderHistoryShot(s));
  }
  const section = el('section', {},
    el('h2', { class: 'shot-history-heading' },
      `${historyStore.total} ${historyStore.total === 1 ? 'shot' : 'shots'}`), ul);
  const pagination = historyStore.pagination;
  if (pagination.status === 'ready' || pagination.status === 'loading') {
    const loading = pagination.status === 'loading';
    section.append(el('button', {
      type: 'button', class: 'loadmore older-history-action',
      ...(loading ? { 'aria-disabled': 'true' } : {}),
      onclick: () => {
        if (historyStore.pagination.status === 'ready') return loadMoreHistory();
      },
    }, loading ? 'Loading…' : 'Load older'));
  }
  app.append(section);
  if (historyRevealShotId !== null) {
    const revealShotId = historyRevealShotId;
    requestAnimationFrame(() => {
      const row = document.querySelector(
        `ul.shotlist li[data-shot-id="${revealShotId}"]`);
      if (historyRevealShotId === revealShotId) historyRevealShotId = null;
      if (!row) return;
      row.scrollIntoView({ block: 'center' });
      row.classList.add('recently-edited');
      setTimeout(() => row.classList.remove('recently-edited'), 1800);
    });
  }
}

function renderDetail(app) {
  app.append(el('button', { class: 'backlink',
                            onclick: () => switchView('list') },
    '← Back to history'));

  if (selectedShotError === 'not_found') {
    app.append(el('p', { class: 'empty' },
      `Shot #${selectedShotId} is no longer available ` +
      `(likely evicted to make room for newer shots).`));
    return;
  }
  if (selectedShotError === 'invalid') {
    app.append(el('p', { class: 'empty err' },
      `Shot #${selectedShotId} cannot be read because its record is damaged ` +
      `or unsupported.`));
    const metadataCard = el('div', { class: 'card record' });
    appendShotMetadataDetails(
      metadataCard, shotSummaryFromRecord(selectedShotId, null, selectedShotMetadata),
      { allowMetadataDownload: true });
    app.append(metadataCard);
    return;
  }
  if (selectedShotError === 'error') {
    app.append(el('p', { class: 'empty' },
      `Couldn't load shot #${selectedShotId}.`));
    return;
  }
  if (!selectedShot) {
    app.append(el('p', { class: 'empty' }, 'Loading shot…'));
    return;
  }
  const e = selectedShot;
  const when = fmtDate(e.startUtcSec) || 'Time unknown';
  const card = renderCompletedShot(
    app, shotSummaryFromRecord(selectedShotId, e, selectedShotMetadata), {
      title: `Shot #${selectedShotId} · ${when}` });
  card.append(techFold(e));
  const actions = el('div', { class: 'shot-detail-actions' });
  // Send this shot to the device's Last Shot slot for on-device replay.
  actions.append(el('button',
    { class: 'backlink', onclick: () => setAsLastShot(selectedShotId) },
    'Set as last shot (replay on device)'));
  // Save the decoded shot locally — no device round-trip, we already have it.
  const metadataPending = !selectedShotMetadata || selectedShotMetadata.loading;
  const download = el('button',
    { class: 'backlink', onclick: () => downloadShotJson(
      selectedShotId, e, selectedShotMetadata) },
    metadataPending ? 'Preparing download…' : 'Download shot data (JSON)');
  download.disabled = metadataPending;
  actions.append(download);
  app.append(actions);
}
