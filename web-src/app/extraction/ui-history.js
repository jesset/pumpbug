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
// A loaded-range refresh can read every page. Its attempts share this deadline
// so metadata writes cannot keep restarting it indefinitely.
const SHOTS_REFRESH_TIMEOUT_MS = 60000;
const HISTORY_VIEW_PREFERENCE_KEY = 'pumpbug.preferences.history-view';
let historyRevealShotId = null;
let historyListPosition = null;
let historyPaginationError = null;
let historyFooterRefreshError = null;
let historyViewMode = loadHistoryViewPreference();
let historyCoffeeBatch = null;
let historyViewMenuOpen = false;
let historyViewMenuListening = false;
let historyListFocusAction = null;
let historyListNonce = null;
const historyListPositions = new Map();

function loadHistoryViewPreference() {
  try {
    return localStorage.getItem(HISTORY_VIEW_PREFERENCE_KEY) === 'coffee' ? 'coffee' : 'all';
  } catch (_) {
    return 'all';
  }
}

function saveHistoryViewPreference(mode) {
  try {
    localStorage.setItem(HISTORY_VIEW_PREFERENCE_KEY, mode);
  } catch (_) {
    // Switching views must still work when browser storage is unavailable.
  }
}

function historyListContext() {
  return historyCoffeeBatch ? 'batch:' + historyCoffeeBatch.key : historyViewMode;
}

function historyRowKey(row) {
  return row.dataset.historyKey || 'shot:' + row.dataset.shotId;
}

function historyRowForShot(id) {
  const list = document.querySelector('ul.shotlist');
  if (!list) return null;
  const summary = historyStore.rows?.find(row => row.id === id);
  const batchKey = summary && historyCoffeeBatchKey(summary);
  return Array.from(list.children).find(row =>
    Number(row.dataset.shotId) === id ||
    (batchKey && row.dataset.historyKey === 'batch:' + batchKey)) || null;
}

// Keep the visible shot in place when History is rebuilt or reopened. A card
// anchor follows changes above it, including newly recorded shots.
function rememberHistoryListPosition(shotId = null) {
  const list = document.querySelector('ul.shotlist');
  if (!list && !document.querySelector('[data-history-action="refresh"]')) return;
  if (list?.dataset?.historyContext && list.dataset.historyContext !== historyListContext()) return;
  const row = !list ? null : shotId !== null
    ? historyRowForShot(shotId)
    : Array.from(list.children).find(item => item.getBoundingClientRect().bottom > 0);
  const focusedRow = list?.contains(document.activeElement)
    ? document.activeElement.closest('li[data-shot-id]') : null;
  const buttons = focusedRow ? Array.from(focusedRow.querySelectorAll('button')) : [];
  historyListPosition = {
    atTop: window.scrollY <= 0,
    id: row ? Number(row.dataset.shotId) : null,
    key: row ? historyRowKey(row) : null,
    top: row ? row.getBoundingClientRect().top : 0,
    scrollY: window.scrollY,
    focusId: focusedRow ? Number(focusedRow.dataset.shotId) : null,
    focusKey: focusedRow ? historyRowKey(focusedRow) : null,
    focusIndex: buttons.indexOf(document.activeElement),
    focusAction: document.activeElement?.getAttribute?.('data-history-action'),
  };
  historyListPositions.set(historyListContext(), historyListPosition);
}

function restoreHistoryListPosition(focusAction = null) {
  const position = historyListPosition;
  if (!position && !focusAction) return;
  const rows = Array.from(document.querySelector('ul.shotlist')?.children || []);
  if (position) {
    const row = !position.atTop && (rows.find(row => historyRowKey(row) === position.key) ||
      historyRowForShot(position.id));
    const scrollY = position.atTop ? 0 : row
      ? window.scrollY + row.getBoundingClientRect().top - position.top
      : position.scrollY;
    if (Math.abs(scrollY - window.scrollY) >= 1) window.scrollTo(0, scrollY);
    if (!focusAction && position.focusIndex >= 0) {
      const focusedRow = rows.find(row => historyRowKey(row) === position.focusKey) ||
        historyRowForShot(position.focusId);
      const index = focusedRow && historyRowKey(focusedRow) === position.focusKey ? position.focusIndex : 0;
      focusedRow?.querySelectorAll('button')[index]?.focus({ preventScroll: true });
    }
  } else if (focusAction) {
    window.scrollTo(0, 0);
  }
  const action = focusAction || (position?.focusIndex < 0 && position.focusAction);
  if (action) {
    const control = document.querySelector(`[data-history-action="${action}"]`) ||
      document.querySelector('[data-history-action="refresh"]');
    control?.focus({ preventScroll: true });
  }
}

function setHistoryListContext(mode, batch = null, anchorId = null) {
  rememberHistoryListPosition(anchorId);
  historyViewMode = mode;
  historyCoffeeBatch = batch;
  historyListPosition = historyListPositions.get(historyListContext()) || null;
}

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

// Fetch one page (before=0 → newest), including its validator and storage
// identity. A missing or invalid identity is null. The caller commits the
// validator after applying the response; a matching conditional read returns
// only { status:304 }. timeoutMs covers headers and body for this attempt.
async function fetchShotsPage(before, signal, timeoutMs, { conditional = true } = {}) {
  let url = '/app/extraction/shots?limit=' + SHOTS_LIMIT + '&meta=1';
  if (before) url += '&before=' + before;
  const headers = {};
  // Only page one's validator is retained. Older pages are folded into the
  // loaded range rather than cached with their own validators.
  const etag = conditional && !before ? historyStore.etagFor(url) : null;
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
        shotStoreNonce: Number.isInteger(j.shotStoreNonce) &&
          j.shotStoreNonce > 0 && j.shotStoreNonce <= 0xffffffff
          ? j.shotStoreNonce : null,
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
  let shotStoreNonce = null;
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
      read, apply, { signal, timeoutMs = SHOTS_FETCH_TIMEOUT_MS,
        fail = err => { throw err; } } = {}) {
    let remaining = timeoutMs;
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
      const sameStore = shotStoreNonce !== null &&
        res.shotStoreNonce === shotStoreNonce;
      if (before && shotStoreNonce !== null && !sameStore) {
        invalidate();
        runBackgroundRefresh();
        return { status: 'cancelled' };
      }
      // Firmware without a nonce can merge within a validated session;
      // revalidation after reconnect replaces those unidentified rows.
      const mergeWithoutIdentity = preserveRows && shotStoreNonce === null &&
        res.shotStoreNonce === null;
      if (before) {
        rows = rows.concat(res.shots);
        hasMore = res.hasMore;
      } else if (!request.refreshRange && rows && (sameStore || mergeWithoutIdentity)) {
        // Retain older pages across a wake when the storage identity matches.
        // An overlapping first page keeps the loaded range connected.
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
      if (!before) shotStoreNonce = res.shotStoreNonce;
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

  // Refresh the displayed range before publishing it, so a failed older-page
  // read leaves the displayed shots intact. Confirmed metadata writes cause
  // the entire read to retry through readWithMetadataRevalidation().
  async function fetchLoadedRange(range, signal, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    const read = before => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw requestError('timeout', 'History refresh timed out.');
      return fetchShotsPage(before, signal, Math.min(remaining, SHOTS_FETCH_TIMEOUT_MS),
        { conditional: false });
    };
    const first = await read(0);
    if (!range.oldestId || first.shotStoreNonce !== range.nonce) return first;
    let page = first;
    const shots = [...first.shots];
    while (page.hasMore && shots.length && shots.at(-1).id > range.oldestId) {
      const before = shots.at(-1).id;
      page = await read(before);
      if (page.shotStoreNonce !== first.shotStoreNonce) {
        throw new Error('Shot storage changed. Refresh history again.');
      }
      if (!page.shots.length || page.shots.some(row => row.id >= before)) {
        throw new Error('History page did not advance.');
      }
      shots.push(...page.shots);
    }
    const loaded = shots.filter(row => row.id >= range.oldestId);
    return { ...first, shots: loaded, total: page.total,
      hasMore: page.hasMore || loaded.length < shots.length };
  }

  function requestPage(before, preserveRows = false, refreshRange = null) {
    if (activeRequest) activeRequest.controller.abort();
    const request = {
      before,
      preserveRows,
      refreshRange,
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
          timeoutMs => refreshRange
            ? fetchLoadedRange(refreshRange, request.controller.signal, timeoutMs)
            : fetchShotsPage(before, request.controller.signal, timeoutMs),
          res => applyShotsPage(request, res),
          { signal: request.controller.signal,
            timeoutMs: refreshRange ? SHOTS_REFRESH_TIMEOUT_MS : SHOTS_FETCH_TIMEOUT_MS });
      } catch (err) {
        if (request.controller.signal.aborted || activeRequest !== request) {
          return { status: 'cancelled' };
        }
        if (!before) {
          error = err;
          failedRequest = { preserveRows, refreshRange };
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

  function refreshLoaded() {
    requested = true;
    if (!storageIsReady()) return Promise.resolve({ status: 'deferred' });
    if (activeRequest?.refreshRange) return activeRequest.promise;
    return requestPage(0, false, {
      oldestId: rows?.at(-1)?.id ?? 0, nonce: shotStoreNonce,
    });
  }

  // Page-one revalidation has priority over operations that depend on the
  // current rows. Once it completes, callers recompute their request from the
  // validated rows rather than using cursors from before it.
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
    if (request.refreshRange) return requestPage(0, false, request.refreshRange);
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
          const pageOneResult = request.refreshRange
            ? await requestPage(0, false, request.refreshRange) : request.preserveRows
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
    get shotStoreNonce() { return shotStoreNonce; },
    get rowsAreCurrent() {
      return rows !== null && validatedGeneration === invalidationGeneration;
    },
    get hasMore() { return hasMore; },
    get total() { return total; },
    get loading() { return loading; },
    get refreshingLoaded() { return !!activeRequest?.refreshRange; },
    get canRefresh() { return storageIsReady() && !loading; },
    get error() { return error; },
    get pagination() { return paginationState(); },
    subscribe,
    ensureLoaded,
    refresh,
    refreshLoaded,
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
  if (view === 'list') rememberHistoryListPosition();
  if (next === 'list' && view === 'detail' &&
      historyListPosition?.id === selectedShotId) {
    historyListPosition.focusKey = 'shot:' + selectedShotId;
    historyListPosition.focusId = selectedShotId;
    historyListPosition.focusIndex = 0;
  }
  cancelMetadataEditorLoad();
  historyViewMenuOpen = false;
  if (next === 'live' && historyCoffeeBatch) {
    setHistoryListContext(historyViewMode);
  }
  if (next === 'live') historyListFocusAction = null;
  if (next === 'list' && view === 'live' && historyListPosition) {
    // Tab navigation restores the reading position, not a previous visit's focus.
    historyListPosition.focusId = null;
    historyListPosition.focusKey = null;
    historyListPosition.focusIndex = -1;
    historyListPosition.focusAction = null;
  }
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
  if (view === 'list') rememberHistoryListPosition(id);
  else if (historyCoffeeBatch) setHistoryListContext(historyViewMode);
  historyViewMenuOpen = false;
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

async function loadOlderHistory() {
  if (historyStore.pagination.status !== 'ready') return;
  const hadFocus = document.activeElement?.classList.contains('older-history-action');
  const context = historyListContext();
  const grouped = historyViewMode === 'coffee' && !historyCoffeeBatch;
  // A single coffee card becoming a stack is still the same displayed coffee.
  const rowKey = summary => (grouped && historyCoffeeBatchKey(summary)) || summary.id;
  const previousKeys = new Set((historyStore.rows || []).map(rowKey));
  historyPaginationError = null;
  const result = await loadMoreHistory(() => {
    historyPaginationError = {
      cursor: historyStore.rows?.at(-1)?.id,
      shotStoreNonce: historyStore.shotStoreNonce,
      message: "Couldn't load older shots. Try again.",
    };
  });
  scheduleRender();
  if (result.status !== 'error' && result.status !== 200) return result;
  requestAnimationFrame(() => {
    if (view !== 'list' || historyListContext() !== context) return;
    const paging = document.querySelector('.history-pagination');
    if (!paging || paging.closest('[inert]')) return;
    if (result.status === 'error' && historyPaginationError) {
      const rect = paging.getBoundingClientRect();
      if (rect.top >= window.innerHeight || rect.bottom <= 0) return;
      paging.scrollIntoView({ block: 'end' });
    }
    const restoredToRefresh = historyListPosition?.focusAction === 'older' &&
      document.activeElement === document.querySelector('[data-history-action="refresh"]');
    if (hadFocus && (document.activeElement === document.body || restoredToRefresh ||
        document.activeElement?.classList?.contains('older-history-action'))) {
      const nextShot = historyStore.rows?.find(row =>
        !previousKeys.has(rowKey(row)) && historyRowForShot(row.id));
      const link = result.status === 200 && nextShot &&
        historyRowForShot(nextShot.id)?.querySelector('.shot-open-link');
      const control = link || paging.querySelector('button') || paging;
      control.focus({ preventScroll: !link || result.status === 'error' });
    }
  });
  return result;
}

function historyLoadedCount() {
  const loaded = historyStore.rows?.length ?? 0;
  const total = historyStore.total;
  return `${loaded} of ${total} ${total === 1 ? 'shot' : 'shots'} loaded`;
}

// A roast date separates bags of the same coffee. Missing dates share one
// group; shots without a named coffee stay individual.
function historyCoffeeBatchKey(summary) {
  const { coffee } = shotSummaryData(summary);
  const identity = coffeeIdentity(coffee);
  return identity ? JSON.stringify([identity, coffee.roastDate || '']) : null;
}

function historyCoffeeGroups(rows) {
  const batches = new Map();
  const groups = [];
  for (const summary of rows) {
    const key = historyCoffeeBatchKey(summary);
    const existing = key && batches.get(key);
    if (existing) existing.rows.push(summary);
    else {
      const group = { key, rows: [summary] };
      groups.push(group);
      if (key) batches.set(key, group);
    }
  }
  return groups;
}

function openHistoryCoffeeBatch(group) {
  setHistoryListContext(historyViewMode, {
    key: group.key, coffee: shotSummaryData(group.rows[0]).coffee,
  }, group.rows[0].id);
  historyListFocusAction = 'back';
  scheduleRender();
}

function historyViewMenu() {
  if (!historyViewMenuListening) {
    document.addEventListener('click', dismissHistoryViewMenu);
    historyViewMenuListening = true;
  }
  const label = 'History view: ' + (historyViewMode === 'coffee' ? 'By coffee' : 'All shots');
  const menu = el('details', { class: 'history-view-menu' });
  menu.open = historyViewMenuOpen;
  const trigger = el('summary', { title: label, 'aria-label': label,
    'data-history-action': 'view',
    onclick: () => { historyViewMenuOpen = !menu.open; },
  }, uiIcon(historyViewMode === 'coffee' ? 'stack' : 'list'));
  menu.append(trigger, el('div', { class: 'history-view-options', role: 'group', 'aria-label': 'History view' },
    ...[['all', 'All shots'], ['coffee', 'By coffee']].map(([mode, text]) => el('button', {
      type: 'button', 'aria-pressed': String(historyViewMode === mode),
      'data-history-action': 'view-' + mode,
      onclick: () => {
        setHistoryListContext(mode);
        saveHistoryViewPreference(mode);
        historyViewMenuOpen = false;
        historyListFocusAction = 'view';
        scheduleRender();
      },
    }, uiIcon(mode === 'coffee' ? 'stack' : 'list'), text,
      el('span', { class: 'history-view-check', 'aria-hidden': 'true' }, historyViewMode === mode ? '✓' : '')))));
  menu.onkeydown = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); historyViewMenuOpen = false; menu.open = false;
    trigger.focus({ preventScroll: true });
  };
  menu.onfocusout = event => {
    if (event.relatedTarget && !menu.contains(event.relatedTarget)) {
      historyViewMenuOpen = false; menu.open = false;
    }
  };
  return menu;
}

function dismissHistoryViewMenu(event) {
  const menu = document.querySelector('.history-view-menu');
  if (menu && !menu.contains(event.target)) {
    historyViewMenuOpen = false; menu.open = false;
  }
}

function historyHeading(count = historyLoadedCount()) {
  const refreshing = historyStore.refreshingLoaded;
  const showError = historyStore.error &&
    (historyStore.error !== historyFooterRefreshError || !historyStore.rows?.length);
  const refresh = el('button', { type: 'button', class: 'backlink history-refresh',
    'aria-label': refreshing ? 'Refreshing history' : 'Refresh history',
    title: 'Refresh history',
    ...(refreshing ? { 'aria-busy': 'true' } : {}),
    ...(historyStore.error ? { 'aria-describedby': 'history-refresh-error' } : {}),
    'data-history-action': 'refresh',
    ...(!historyStore.canRefresh ? { 'aria-disabled': 'true' } : {}),
    onclick: () => {
      if (!historyStore.canRefresh) return;
      historyFooterRefreshError = null;
      return historyStore.refreshLoaded();
    },
  }, uiIcon('refresh'));
  const heading = el('div', { class: 'history-heading' },
    el('h2', { class: 'shot-history-heading' }, count),
    el('div', { class: 'history-tools' }, historyCoffeeBatch ? null : historyViewMenu(), refresh));
  return showError ? el('div', {}, heading, historyRefreshError()) : heading;
}

function historyRefreshError() {
  return el('p', { class: 'err history-pagination-error', id: 'history-refresh-error' },
    "Couldn't refresh history. Try again.");
}

function renderHistoryShot(summary, { coffeeContext = false, showRoastDate = false } = {}) {
  const data = shotSummaryData(summary);
  const { record } = data;
  const date = coffeeContext ? el('div', { class: 'shot-date' },
    shotOpenButton(summary.id, fmtDate(summary.startUtcSec) || 'Time unknown'),
    el('span', { class: 'shot-row-actions' },
      el('span', {}, '#' + summary.id), shotMetadataListAction(summary))) : shotDate(summary);
  const coffee = coffeeContext ? null : shotCoffeeIdentity(summary.id, data, { unknownLabel: 'Shot #' + summary.id });
  if (coffee && showRoastDate && data.coffee.roastDate) {
    coffee.append(el('p', { class: 'coffee-roast-date' }, 'Roasted ' + data.coffee.roastDate));
  }
  const item = el('li', { onclick: () => selectShot(summary.id) },
    date,
    coffeeContext ? null : el('div', { class: 'shot-identity' },
      coffee,
      shotMetadataListAction(summary)), shotMetrics(summary));
  item.dataset.shotId = String(summary.id);
  item.dataset.historyKey = 'shot:' + summary.id;
  appendShotResult(item, data, { compact: true });
  if (record && record.state !== 'active') appendShotSummary(item, summary);
  return item;
}

function hasHistorySummary(summary) {
  return ['startUtcSec', 'beginMs', 'durationMs', 'yieldCg', 'totalPumpOnMs']
    .every(key => Number.isFinite(summary[key]));
}

function renderHistoryCard(summary, options) {
  if (hasHistorySummary(summary)) return renderHistoryShot(summary, options);
  const item = el('li', { class: 'unavailable', onclick: () => selectShot(summary.id) },
    el('div', { class: 'head' }, shotOpenButton(summary.id, 'Record unavailable'),
      el('span', { class: 'shot-row-actions' },
        el('span', { class: 'id' }, '#' + summary.id), shotMetadataListAction(summary))));
  item.dataset.shotId = String(summary.id);
  item.dataset.historyKey = 'shot:' + summary.id;
  appendShotSummary(item, summary, { showCoffeeName: !options?.coffeeContext });
  return item;
}

function renderHistoryStack(group) {
  const summary = group.rows[0];
  const data = shotSummaryData(summary);
  const open = event => { event.stopPropagation(); openHistoryCoffeeBatch(group); };
  const item = el('li', { class: 'history-stack', onclick: open });
  item.dataset.shotId = String(summary.id);
  item.dataset.historyKey = 'batch:' + group.key;
  const title = el('button', { type: 'button', class: 'shot-open-link shot-coffee-name',
    'aria-label': `${data.coffee.name}, ${group.rows.length} loaded shots, open coffee shots`,
    onclick: open }, data.coffee.name);
  const front = el('div', { class: 'history-stack-front' },
    el('div', { class: 'shot-date' }, 'Latest · ' + (fmtDate(summary.startUtcSec) || 'Time unknown')),
    el('div', { class: 'history-stack-head' },
      el('div', { class: 'shot-coffee' }, title,
        data.coffee.roaster ? el('div', { class: 'shot-roaster' }, data.coffee.roaster) : null,
        data.coffee.roastDate ? el('p', { class: 'coffee-roast-date' }, 'Roasted ' + data.coffee.roastDate) : null),
      uiIcon('chevronRight')),
    hasHistorySummary(summary) ? shotMetrics(summary) : el('p', { class: 'err' }, 'Record unavailable'));
  appendShotResult(front, data, { compact: true });
  const more = group.rows.length - 1;
  item.append(front, el('button', { type: 'button', class: 'history-stack-more', onclick: open },
    `${more} more ${more === 1 ? 'shot' : 'shots'} with this coffee`));
  return item;
}

function renderList(app) {
  let focusAction = historyListFocusAction;
  historyListFocusAction = null;
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
  const nonce = historyStore.shotStoreNonce;
  if (historyListNonce !== null && nonce !== null && historyListNonce !== nonce) {
    focusAction = historyCoffeeBatch ? 'view' : null;
    historyListPositions.clear();
    historyCoffeeBatch = null;
    historyListPosition = null;
    historyViewMenuOpen = false;
    window.scrollTo(0, 0);
  }
  historyListNonce = nonce;
  if (historyCoffeeBatch && historyRevealShotId !== null) {
    const revealed = rows.find(row => row.id === historyRevealShotId);
    if (revealed && historyCoffeeBatchKey(revealed) !== historyCoffeeBatch.key) {
      setHistoryListContext(historyViewMode);
    }
  }
  const coffeeRows = historyCoffeeBatch
    ? rows.filter(row => historyCoffeeBatchKey(row) === historyCoffeeBatch.key) : null;
  if (historyCoffeeBatch) {
    app.append(el('button', { type: 'button', class: 'backlink history-coffee-back',
      'data-history-action': 'back',
      onclick: () => {
        const key = historyCoffeeBatch.key;
        const latestShot = historyStore.rows?.find(row => historyCoffeeBatchKey(row) === key);
        setHistoryListContext(historyViewMode);
        if (historyListPosition) {
          historyListPosition.id = latestShot?.id ?? null;
          historyListPosition.focusKey = 'batch:' + key;
          historyListPosition.focusId = latestShot?.id ?? null;
          historyListPosition.focusIndex = latestShot ? 0 : -1;
          historyListPosition.focusAction = latestShot ? null : 'view';
        }
        scheduleRender();
      },
    }, '← Back to history'));
    const data = coffeeRows.length ? shotSummaryData(coffeeRows[0]) : {
      coffee: historyCoffeeBatch.coffee, record: { state: 'active' },
    };
    app.append(el('div', { class: 'history-coffee-context' },
      shotCoffeeIdentity(null, data, { heading: true }),
      data.coffee.roastDate ? el('p', { class: 'coffee-roast-date' }, 'Roasted ' + data.coffee.roastDate) : null));
  }
  if (!rows.length && !historyCoffeeBatch) {
    app.append(historyHeading());
    app.append(el('p', { class: 'empty' }, 'No shots recorded yet.'));
    restoreHistoryListPosition(focusAction);
    return;
  }
  const ul = el('ul', { class: 'shotlist' + (coffeeRows ? ' coffee-shots' : '') });
  ul.dataset.historyContext = historyListContext();
  if (coffeeRows) {
    ul.append(...coffeeRows.map(row => renderHistoryCard(row, { coffeeContext: true })));
  } else if (historyViewMode === 'coffee') {
    ul.append(...historyCoffeeGroups(rows).map(group => group.rows.length > 1
      ? renderHistoryStack(group) : renderHistoryCard(group.rows[0], { showRoastDate: true })));
  } else {
    ul.append(...rows.map(row => renderHistoryCard(row)));
  }
  const count = coffeeRows ? `${coffeeRows.length} loaded ${coffeeRows.length === 1 ? 'shot' : 'shots'}`
    : historyLoadedCount();
  const section = el('section', {},
    historyHeading(count), ul);
  if (coffeeRows && !coffeeRows.length) {
    section.append(el('p', { class: 'empty' }, 'No loaded shots with this coffee.'));
  }
  const pagination = historyStore.pagination;
  if (pagination.status === 'complete' ||
      historyPaginationError?.shotStoreNonce !== historyStore.shotStoreNonce ||
      historyPaginationError?.cursor !== rows.at(-1)?.id) {
    historyPaginationError = null;
  }
  const paging = el('div', { class: 'history-pagination', tabindex: '-1',
    'data-history-action': 'pagination' },
    el('p', { class: 'history-loaded-count' }, historyLoadedCount()));
  const waiting = pagination.status === 'deferred' && historyStore.hasMore;
  const refreshing = historyStore.refreshingLoaded || (waiting && historyStore.loading);
  if (pagination.status === 'ready' || pagination.status === 'loading' || waiting || refreshing || historyStore.error) {
    const loading = pagination.status === 'loading';
    const retryingRefresh = !!historyStore.error;
    const inactive = refreshing || (waiting && !retryingRefresh) || loading ||
      (retryingRefresh && !historyStore.canRefresh);
    if (retryingRefresh && historyStore.error === historyFooterRefreshError) {
      paging.append(historyRefreshError());
    } else if (!retryingRefresh && historyPaginationError) {
      paging.append(el('p', { class: 'err history-pagination-error', id: 'history-pagination-error' },
        historyPaginationError.message));
    }
    paging.append(el('button', {
      type: 'button', class: 'loadmore older-history-action',
      'data-history-action': 'older',
      ...(inactive ? { 'aria-disabled': 'true' } : {}),
      ...(retryingRefresh ? { 'aria-describedby': 'history-refresh-error' } : {}),
      ...(!retryingRefresh && historyPaginationError
        ? { 'aria-describedby': 'history-pagination-error' } : {}),
      onclick: () => {
        if (inactive) return;
        if (!historyStore.error) return loadOlderHistory();
        if (!historyStore.canRefresh) return;
        historyFooterRefreshError = null;
        return historyStore.retry().then(result => {
          if (result.status === 'error' && historyStore.error === result.error) {
            historyFooterRefreshError = result.error;
            scheduleRender();
          }
          return result;
        });
      },
    }, refreshing ? 'Refreshing…' : historyStore.error ? 'Retry' :
      waiting ? 'Waiting to refresh…' : loading ? 'Loading…' :
      historyPaginationError ? 'Retry' : 'Load older'));
  }
  section.append(paging);
  app.append(section);
  if (historyRevealShotId !== null) {
    const revealShotId = historyRevealShotId;
    requestAnimationFrame(() => {
      const row = historyRowForShot(revealShotId);
      if (historyRevealShotId === revealShotId) historyRevealShotId = null;
      if (!row) return;
      row.scrollIntoView({ block: 'center' });
      row.classList.add('recently-edited');
      setTimeout(() => row.classList.remove('recently-edited'), 1800);
    });
  } else {
    restoreHistoryListPosition(focusAction);
  }
}

function renderDetail(app) {
  app.append(el('button', { class: 'backlink',
                            onclick: () => switchView('list') },
    historyCoffeeBatch ? '← Back to coffee shots' : '← Back to history'));

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
  const summary = shotSummaryFromRecord(selectedShotId, e, selectedShotMetadata);
  const data = shotSummaryData(summary);
  const identity = shotCoffeeIdentity(null, data, {
    unknownLabel: 'Shot #' + selectedShotId, heading: true,
  });
  if (data.coffee.roastDate) identity.append(el('div', { class: 'coffee-roast-date' },
    'Roasted ' + data.coffee.roastDate));
  const head = el('div', { class: 'shot-detail-head' }, identity);
  const edit = shotMetadataEditAction(summary);
  if (edit) head.append(edit);
  const card = el('section', { class: 'card record shot-detail' },
    shotDate(summary), head);
  appendShotMetadataStatus(card, data.record);
  card.append(shotMetrics(summary));
  renderCurve(RecordChart, card, e);
  const metadata = shotDetailMetadata(summary);
  if (metadata) card.append(metadata);
  card.append(el('section', { class: 'shot-detail-recording' },
    el('h3', {}, 'Recording details'), recordRows(e, 'detail')));
  const footer = el('footer', { class: 'shot-detail-footer' }, techFold(e));
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
  footer.append(actions);
  card.append(footer);
  app.append(card);
}
