// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const SHOT_METADATA_MAX_BYTES = 1536;
const SHOT_METADATA_BROWSER_STATE_KEY = 'pumpbug.shot-details.v1';

// Saved-shot metadata comes from the device. The next-shot recipe belongs to
// this browser.
let lastShotMetadata = null;
let metadataEditorLoad = null;
let metadataEditor = null;
let coffeePicker = null;
let coffeeComparisonOpen = false;
let coffeeHistoryFeedback = null;
let metadataOverlayReturnFocus = null;
let nextShotRecipe = {};
let nextShotRecipeSourceId = null;

function loadMetadataBrowserState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SHOT_METADATA_BROWSER_STATE_KEY));
    if (!isPlainObject(saved)) return;
    if (isPlainObject(saved.nextShotRecipe)) {
      nextShotRecipe = saved.nextShotRecipe;
    }
  } catch (_) {
    // A malformed or unavailable browser store must not block shot history.
  }
}

function saveMetadataBrowserState() {
  try {
    localStorage.setItem(SHOT_METADATA_BROWSER_STATE_KEY, JSON.stringify({
      nextShotRecipe,
    }));
  } catch (_) {
    // The workflow remains available for the current page session.
  }
}

function metadataStreamSessionStarted() {
  // A reconnect may be the same running device or a reboot with a new storage
  // lifetime. Keep the prepared recipe, but stop attributing it to a numeric
  // shot ID that may now identify another record.
  let changed = false;
  if (nextShotRecipeSourceId !== null) {
    nextShotRecipeSourceId = null;
    changed = true;
  }
  if (metadataEditor && metadataEditor.kind === 'recipe' &&
      metadataEditor.recipeSourceId !== null) {
    metadataEditor.recipeSourceId = null;
    metadataEditor.recipeSourceCoffeeIdentity = null;
    changed = true;
  }
  if (changed) scheduleRender();
}

function metadataRecordFromRow(row) {
  if (!row || !row.userMetadataState) return null;
  return {
    id: row.id,
    state: row.userMetadataState,
    value: row.userMetadataState === 'active' ? row.userMetadata : null,
    crc: row.userMetadataCrc,
    etag: row.userMetadataEtag || null,
  };
}

function metadataStateFromResponse(response) {
  return response.headers.get('X-Shot-Metadata-State') || 'unavailable';
}

function encodeShotMetadata(value) {
  const body = JSON.stringify(value);
  return {
    body,
    tooLarge: new TextEncoder().encode(body).length >
      SHOT_METADATA_MAX_BYTES,
  };
}

async function fetchShotMetadata(id, timeoutMs) {
  return fetchWithTimeout(
    '/app/extraction/shot-metadata?id=' + id,
    { cache: 'no-store' }, async response => {
      const state = metadataStateFromResponse(response);
      const record = {
        id,
        state,
        value: null,
        crc: Number(response.headers.get('X-Shot-Metadata-Crc')) || 0,
        etag: response.headers.get('ETag'),
      };
      if (response.ok) {
        record.value = state === 'active' ? await response.json() : null;
        return record;
      }
      if (response.status === 404) throw new Error('not found');
      if (response.status === 409 &&
          (state === 'corrupt' || state === 'unsupported')) {
        return record;
      }
      throw new Error('shot metadata ' + response.status);
    }, timeoutMs);
}

async function initializeRecentShotMetadata(id, value) {
  const encoded = encodeShotMetadata(value);
  if (encoded.tooLarge) {
    throw new Error('captured recipe exceeds the shot-details limit');
  }
  const result = await fetchWithTimeout(
    '/app/extraction/shot-metadata?id=' + id,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: encoded.body,
    }, async response => ({
      status: response.status,
      ok: response.ok,
      state: metadataStateFromResponse(response),
      body: response.status === 200 || response.status === 409
        ? await response.json() : null,
      crc: Number(response.headers.get('X-Shot-Metadata-Crc')) || 0,
      etag: response.headers.get('ETag'),
    }));
  if (result.status === 409 && result.body &&
      result.body.reason === 'metadata_not_absent') {
    return null;
  }
  if (result.status === 409 && result.body &&
      result.body.reason === 'shot_not_eligible') {
    throw new Error('a newer shot was saved or the device restarted');
  }
  if (!result.ok) {
    throw new Error('initializing shot details failed (HTTP ' +
      result.status + ')');
  }
  return {
    id,
    state: result.state,
    value: result.body,
    crc: result.crc,
    etag: result.etag,
    needsResult: true,
  };
}

function shotForMetadataId(id) {
  if (lastRecord && lastRecord.shotId === id) return lastRecord;
  if (selectedShotId === id && selectedShot) return selectedShot;
  return (historyStore.rows || []).find(row => row.id === id) || null;
}

async function setLastShotMetadataId(id, completedShotRecipe = null) {
  const pending = id ? { id, loading: true } : null;
  lastShotMetadata = pending;
  scheduleRender();
  if (!id) return;
  if (completedShotRecipe) {
    try {
      const initialized =
        await initializeRecentShotMetadata(id, completedShotRecipe);
      if (initialized) {
        historyStore.metadataWritten();
        publishMetadataRecord(initialized);
        historyStore.shotSaved();
        return;
      }
    } catch (err) {
      flashBanner('The recipe could not be attached: ' + err.message, 'bad');
    }
  }
  await readCurrentShotMetadata(id, record => {
    publishMetadataRecord(record);
  }, err => {
    if (lastShotMetadata !== pending) return;
    lastShotMetadata = { id, state: 'unavailable', error: err.message };
    scheduleRender();
  });
}

function recipeForCompletedShot() {
  const recipe = cloneJson(nextShotRecipe);
  return Object.keys(recipe).length ? recipe : null;
}

// Metadata summaries appear in both History and Last Shot. They use only the
// fields this browser understands; the editor preserves everything else.
function metadataValue(record) {
  return record && record.state === 'active' &&
    record.value && typeof record.value === 'object' &&
    !Array.isArray(record.value) ? record.value : {};
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ratingText(value) {
  const rating = value && Number.isInteger(value.rating) ? value.rating : 0;
  return rating >= 1 && rating <= 5 ? '★'.repeat(rating) : null;
}

function metadataPreparationParts(prep) {
  const preparation = [];
  const grinder = nonemptyString(prep.grinder);
  if (grinder) preparation.push({ text: grinder });
  if (nonemptyString(prep.grind)) {
    const value = prep.grind.trim();
    preparation.push({ text: 'grind ' + value, prefix: 'grind ', value });
  }
  if (Number.isFinite(prep.doseG)) {
    const value = String(prep.doseG);
    preparation.push({ text: value + ' g', value, suffix: ' g' });
  }
  if (Number.isFinite(prep.tempC)) {
    preparation.push({ text: prep.tempC + '°C' });
  }
  if (nonemptyString(prep.pressure)) {
    preparation.push({ text: prep.pressure.trim() });
  }
  if (nonemptyString(prep.water)) {
    preparation.push({ text: prep.water.trim() });
  }
  return preparation;
}

function metadataSummaryEntries(value) {
  const entries = [];
  const coffee = value.coffee && typeof value.coffee === 'object'
    ? value.coffee : {};
  const prep = value.prep && typeof value.prep === 'object' ? value.prep : {};
  const coffeeName = nonemptyString(coffee.name);
  const roaster = nonemptyString(coffee.roaster);
  if (coffeeName) {
    entries.push({ text: roaster ? coffeeName + ' · ' + roaster : coffeeName });
  }
  const roastDate = nonemptyString(coffee.roastDate);
  if (roastDate) entries.push({ text: 'Roasted ' + roastDate });

  const preparation = metadataPreparationParts(prep);
  if (preparation.length) entries.push({ parts: preparation });

  const result = [];
  const rating = ratingText(value);
  if (rating) result.push(rating);
  if (Number.isFinite(value.tdsPct)) result.push(value.tdsPct + '% TDS');
  if (Array.isArray(value.tags)) {
    const tags = value.tags.filter(v => typeof v === 'string');
    if (tags.length) result.push(tags.join(', '));
  }
  if (result.length) entries.push({ text: result.join(' · ') });
  const notes = nonemptyString(value.notes);
  if (notes) {
    entries.push({ text: notes.length > 100
      ? notes.slice(0, 97) + '…' : notes });
  }
  return entries;
}

function metadataSummaryLines(value) {
  return metadataSummaryEntries(value).map(entry => entry.text ||
    entry.parts.map(part => part.text).join(' · '));
}

function appendShotMetadataSummary(parent, record, options = {}) {
  if (!record) return;
  const box = el('div', { class: 'metadata-summary' });
  if (record.state === 'active') {
    for (const entry of metadataSummaryEntries(metadataValue(record))) {
      const line = el('div');
      if (entry.parts && options.emphasizeRecipe) {
        entry.parts.forEach((part, index) => {
          if (index) line.append(' · ');
          if (part.value !== undefined) {
            if (part.prefix) line.append(part.prefix);
            line.append(el('strong', { class: 'recipe-key' }, part.value));
            if (part.suffix) line.append(part.suffix);
          } else {
            line.append(part.text);
          }
        });
      } else {
        line.append(entry.text ||
          entry.parts.map(part => part.text).join(' · '));
      }
      box.append(line);
    }
  } else if (record.state === 'corrupt') {
    box.append(el('div', { class: 'err' }, 'Shot details damaged'));
  } else if (record.state === 'unsupported') {
    box.append(el('div', { class: 'err' }, 'Shot details need newer firmware'));
  }
  if (box.childNodes.length) parent.append(box);
}

function metadataActionLabel(record) {
  if (record && record.needsResult) return 'Rate and save details';
  return record && record.state === 'active' ? 'Edit shot details'
    : 'Add shot details';
}

function shotMetadataListAction(id, record) {
  if (record && record.state === 'unsupported') return null;
  const label = 'Edit details';
  return el('button', {
    type: 'button', class: 'shot-details-link', 'aria-label': label,
    'data-overlay-return-key': 'shot-details-' + id,
    onclick: event => {
      event.stopPropagation();
      if (record && record.etag) {
        metadataOverlayReturnFocus = currentMetadataOverlayReturnFocus();
        openMetadataEditor(id, record, { returnToHistory: true });
      } else {
        loadShotMetadata(id, { returnToHistory: true });
      }
    },
  },
  el('span', { class: 'shot-details-label' }, label),
  el('span', { class: 'shot-details-label-compact', 'aria-hidden': 'true' },
    'Edit'));
}

function readCurrentShotMetadata(id, apply, fail) {
  return historyStore.readWithMetadataRevalidation(
    timeoutMs => fetchShotMetadata(id, timeoutMs), apply, { fail });
}

function resolveShotMetadata(
    id, apply = record => record, fail = err => { throw err; }) {
  const pending = { id, loading: true };
  publishMetadataRecord(pending, false);
  return readCurrentShotMetadata(id, record => {
    publishMetadataRecord(record);
    return apply(record);
  }, err => {
    // Preserve any record that replaced this read's loading indicator.
    const unavailable = { id, state: 'unavailable', error: err.message };
    if (lastShotMetadata === pending) lastShotMetadata = unavailable;
    if (selectedShotMetadata === pending) selectedShotMetadata = unavailable;
    scheduleRender();
    return fail(err);
  });
}

function metadataEditorLoadOriginIsCurrent(request) {
  return metadataEditorLoad === request && view === request.view &&
    (view !== 'detail' || selectedShotId === request.selectedShotId) &&
    (view !== 'live' ||
      (lastRecord && lastRecord.shotId === request.lastShotId));
}

function currentMetadataOverlayReturnFocus() {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!active) return null;
  return {
    element: active,
    key: active.getAttribute && active.getAttribute('data-overlay-return-key'),
  };
}

async function loadShotMetadata(id, options = {}) {
  const request = {
    id,
    view,
    selectedShotId,
    lastShotId: lastRecord && lastRecord.shotId,
    returnFocus: currentMetadataOverlayReturnFocus(),
  };
  metadataEditorLoad = request;
  await resolveShotMetadata(id, record => {
    if (!metadataEditorLoadOriginIsCurrent(request) || metadataEditor ||
        coffeePicker || coffeeComparisonOpen) {
      if (metadataEditorLoad === request) metadataEditorLoad = null;
      return;
    }
    metadataEditorLoad = null;
    metadataOverlayReturnFocus = request.returnFocus;
    if (!openMetadataEditor(id, record, options)) {
      metadataOverlayReturnFocus = null;
      flashBanner(record && record.state === 'unsupported'
        ? 'These shot details use an unsupported metadata version.'
        : 'Shot details cannot be edited.', 'bad');
    }
  }, err => {
    if (!metadataEditorLoadOriginIsCurrent(request)) return;
    metadataEditorLoad = null;
    flashBanner('Could not load shot details: ' + err.message, 'bad');
  });
}

function cancelMetadataEditorLoad() {
  metadataEditorLoad = null;
}

async function loadShotMetadataForDetail(id) {
  try {
    await resolveShotMetadata(id);
  } catch (_) {
    // resolveShotMetadata published the unavailable state and retry action.
  }
}

function downloadShotDetailsJson(id, record) {
  if (!record || record.state !== 'active') return;
  const body = JSON.stringify({
    id,
    userMetadataState: record.state,
    userMetadata: record.value,
  }, null, 2);
  const url = URL.createObjectURL(
    new Blob([body], { type: 'application/json' }));
  const link = el('a', {
    href: url, download: 'shot-' + id + '-details.json',
  });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function appendShotMetadataDetails(parent, id, record, options = {}) {
  const section = el('section', { class: 'shot-metadata' },
    el('h2', {}, 'Shot details'));
  const actions = el('div', { class: 'metadata-actions' });
  if (options.openInHistory) {
    actions.append(el('button', {
      class: 'secondary', onclick: () => selectShot(id),
    }, 'View shot'));
  }
  if (!record || record.state === 'unavailable') {
    section.append(el('p', { class: 'empty compact' },
      'Shot details have not been loaded.'));
    actions.append(el('button', {
      class: 'secondary',
      'data-overlay-return-key': 'shot-details-' + id,
      onclick: () => loadShotMetadata(id),
    }, 'Load shot details'));
  } else if (record.loading) {
    section.append(el('p', { class: 'empty compact' }, 'Loading shot details…'));
  } else {
    appendShotMetadataSummary(section, record);
    if (record.state !== 'unsupported' && record.etag) {
      actions.append(el('button', {
        class: 'secondary', 'data-overlay-return-key': 'shot-details-' + id,
        onclick: () => loadShotMetadata(id),
      }, metadataActionLabel(record)));
    }
    if (record.state === 'active') {
      appendCoffeeActionButtons(actions, id, metadataValue(record));
      if (options.allowMetadataDownload) {
        actions.append(el('button', {
          class: 'backlink',
          onclick: () => downloadShotDetailsJson(id, record),
        }, 'Download shot details'));
      }
    }
  }
  if (actions.childNodes.length) section.append(actions);
  parent.append(section);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function fieldValue(root, group, name, kind) {
  if (!editorFieldCompatible(root, group, name, kind)) return '';
  const owner = group ? root[group] : root;
  return isPlainObject(owner) && owner[name] != null ? owner[name] : '';
}

function setField(root, group, name, value) {
  const owner = group ? (isPlainObject(root[group]) ? root[group]
                                                  : (root[group] = {})) : root;
  if (value === '' || value == null || (Array.isArray(value) && !value.length)) {
    delete owner[name];
  } else {
    owner[name] = value;
  }
  if (group && !Object.keys(owner).length) delete root[group];
}

function inputField(label, options) {
  const input = el('input', {
    type: options.type || 'text',
    value: options.value == null ? '' : options.value,
    name: options.name,
    ...(options.initialFocus
      ? { 'data-overlay-initial-focus': 'true' }
      : {}),
    ...(options.step ? { step: options.step } : {}),
    ...(options.min != null ? { min: options.min } : {}),
    ...(options.max != null ? { max: options.max } : {}),
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
    ...(options.list ? { list: options.list } : {}),
  });
  if (options.disabled) input.disabled = true;
  return el('label', { class: options.wide ? 'field wide' : 'field' },
    el('span', {}, label), input);
}

// Search feedback belongs to the open coffee dialog. Closing or replacing the
// dialog, or invalidating its history, also abandons any pending feedback.
function coffeeHistoryFeedbackForDialog() {
  const owner = coffeePicker || (coffeeComparisonOpen ? nextShotCoffee() : null);
  if (!owner || !historyStore.rowsAreCurrent) {
    coffeeHistoryFeedback = null;
  } else if (!coffeeHistoryFeedback || coffeeHistoryFeedback.owner !== owner) {
    coffeeHistoryFeedback = { owner, message: null };
  }
  return coffeeHistoryFeedback;
}

function appendOlderCoffeeHistorySearch(parent, options) {
  const pagination = historyStore.pagination;
  const feedback = options.feedback || null;
  if (pagination.status === 'unavailable') {
    parent.append(el('div', { class: options.errorClass || 'err' },
      'Shot history is unavailable.'));
    return;
  }
  let loading = false;
  let label = 'Search older history';
  const retry = !!historyStore.error;
  if (retry) {
    parent.append(el('div', { class: options.errorClass || 'err' },
      'Shot history could not be refreshed.'));
    label = 'Retry history';
  } else if (pagination.status === 'complete' ||
      pagination.status === 'deferred') {
    return;
  } else if (pagination.status === 'loading') {
    loading = true;
    label = 'Loading…';
  }
  if (!retry && feedback && feedback.message) {
    parent.append(el('p', { class: 'err', role: 'status' }, feedback.message));
  }
  const button = el('button', {
    type: 'button',
    class: (options.buttonClass || 'secondary') + ' older-history-action',
    ...(options.focusKey
      ? { 'data-overlay-focus-key': options.focusKey }
      : {}),
    ...(loading ? { 'aria-disabled': 'true' } : {}),
    onclick: () => {
      if (loading) return;
      if (feedback) feedback.message = null;
      if (retry) return historyStore.retry();
      if (!feedback) return loadMoreHistory();
      return loadMoreHistory(message => {
        if (coffeeHistoryFeedbackForDialog() !== feedback) return;
        feedback.message = message;
        renderMetadataOverlay();
      });
    },
  }, label);
  if (options.actionsClass) {
    parent.append(el('div', { class: options.actionsClass }, button));
  } else {
    parent.append(button);
  }
}

function metadataSuggestions(path) {
  const values = new Set();
  for (const row of historyStore.rows || []) {
    const value = metadataValue(metadataRecordFromRow(row));
    let current = value;
    for (const part of path) current = current && current[part];
    if (typeof current === 'string' && current.trim()) values.add(current.trim());
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

function suggestionList(id, values) {
  return el('datalist', { id }, ...values.map(value => el('option', { value })));
}

// Coffee name and roaster identify related shots. Other coffee fields describe
// the particular batch copied into the next-shot recipe.
function coffeeIdentity(coffee) {
  if (!isPlainObject(coffee)) return null;
  const name = nonemptyString(coffee.name);
  if (!name) return null;
  const roaster = nonemptyString(coffee.roaster) || '';
  return name.toLowerCase() + '\n' + roaster.toLowerCase();
}

function nextShotCoffee() {
  return coffeeIdentity(nextShotRecipe.coffee) ? nextShotRecipe.coffee : null;
}

function matchingCoffeeRows(coffee) {
  const identity = coffeeIdentity(coffee);
  if (!identity) return [];
  return (historyStore.rows || []).filter(row => {
    const value = metadataValue(metadataRecordFromRow(row));
    return coffeeIdentity(value.coffee) === identity;
  });
}

function knownCoffees() {
  const found = new Map();
  for (const row of historyStore.rows || []) {
    const value = metadataValue(metadataRecordFromRow(row));
    const identity = coffeeIdentity(value.coffee);
    if (identity && !found.has(identity)) {
      found.set(identity, { coffee: cloneJson(value.coffee), row });
    }
  }
  return [...found.values()];
}

function recipeFromMetadata(value) {
  const recipe = {};
  if (isPlainObject(value.coffee)) recipe.coffee = cloneJson(value.coffee);
  if (isPlainObject(value.prep)) recipe.prep = cloneJson(value.prep);
  return recipe;
}

function fillMissingPreparationFromRecipe(value, recipe) {
  if (!isPlainObject(recipe.prep) ||
      (value.prep != null && !isPlainObject(value.prep))) {
    return;
  }
  const prep = isPlainObject(value.prep) ? value.prep : {};
  const fields = [
    ['grinder', 'string'], ['grind', 'string'], ['doseG', 'number'],
    ['tempC', 'number'], ['pressure', 'string'], ['water', 'string'],
  ];
  for (const [name, kind] of fields) {
    if (name in prep) continue;
    const source = recipe.prep[name];
    if ((kind === 'string' && nonemptyString(source)) ||
        (kind === 'number' && Number.isFinite(source))) {
      prep[name] = source;
    }
  }
  if (Object.keys(prep).length) value.prep = prep;
}

function useShotForNextRecipe(value, sourceId) {
  if (!coffeeIdentity(value.coffee)) return;
  nextShotRecipe = recipeFromMetadata(value);
  nextShotRecipeSourceId = sourceId || null;
  coffeePicker = null;
  coffeeComparisonOpen = false;
  saveMetadataBrowserState();
  scheduleRender();
  renderMetadataOverlay();
  loadCoffeeContextHistory();
}

function chooseCoffee(coffee) {
  const newest = matchingCoffeeRows(coffee)[0];
  const recipe = newest
    ? recipeFromMetadata(metadataValue(metadataRecordFromRow(newest)))
    : { coffee: cloneJson(coffee) };
  const sourceId = newest && historyStore.rowsAreCurrent ? newest.id : null;
  if (coffeePicker && coffeePicker.onChoose) {
    const onChoose = coffeePicker.onChoose;
    coffeePicker = null;
    try {
      onChoose(recipe, sourceId);
    } finally {
      renderMetadataOverlay();
    }
    return;
  }
  if (newest) {
    useShotForNextRecipe(recipe, sourceId);
    return;
  }
  nextShotRecipe = recipe;
  nextShotRecipeSourceId = null;
  coffeePicker = null;
  saveMetadataBrowserState();
  scheduleRender();
  renderMetadataOverlay();
  loadCoffeeContextHistory();
}

function clearNextShotRecipe() {
  nextShotRecipe = {};
  nextShotRecipeSourceId = null;
  coffeeComparisonOpen = false;
  saveMetadataBrowserState();
  renderMetadataOverlay();
  scheduleRender();
}

function coffeeClearButton() {
  return el('button', {
    class: 'backlink coffee-clear',
    'aria-label': 'Clear next recipe',
    onclick: () => clearNextShotRecipe(),
  }, 'Clear');
}

async function loadCoffeeContextHistory() {
  if (!nextShotCoffee()) return;
  await historyStore.ensureLoaded();
}

function shouldLoadCoffeeContextHistory(currentState) {
  return nextShotCoffee() && currentState.storage === 'ready' &&
      !inPumpWindow(currentState) && historyStore.rows === null &&
      !historyStore.loading && !historyStore.error;
}

function updateCoffeeContextHistoryForState(currentState) {
  if (shouldLoadCoffeeContextHistory(currentState)) {
    return loadCoffeeContextHistory();
  }
  return Promise.resolve();
}

async function loadCoffeePickerHistory(picker) {
  if (coffeePicker !== picker || picker.loadingHistory) return;
  picker.loadingHistory = true;
  renderMetadataOverlay();
  try {
    await historyStore.ensureLoaded();
  } finally {
    if (coffeePicker === picker) {
      picker.loadingHistory = false;
      renderMetadataOverlay();
    }
  }
}

async function openCoffeePicker(onChoose = null) {
  cancelMetadataEditorLoad();
  if (!onChoose) metadataEditor = null;
  coffeeComparisonOpen = false;
  const picker = {
    onChoose,
    newCoffee: { name: '', roaster: '' },
    loadingHistory: false,
  };
  coffeePicker = picker;
  await loadCoffeePickerHistory(picker);
}

function appendCoffeeActionButtons(actions, id, value) {
  if (!coffeeIdentity(value.coffee)) return;
  if (nextShotRecipeSourceId !== id) {
    actions.append(el('button', { class: 'secondary', onclick: event => {
      event.stopPropagation();
      useShotForNextRecipe(value, id);
    } }, 'Use for next shot'));
  }
}

function renderCoffeeContext(app) {
  const coffee = nextShotCoffee();
  const pumping = inPumpWindow(state);
  const section = el('section', {
    class: 'coffee-context' + (pumping ? ' compact' : ''),
  });
  if (pumping) {
    const name = coffee ? nonemptyString(coffee.name) : null;
    const roaster = coffee ? nonemptyString(coffee.roaster) : null;
    const label = coffee
      ? (roaster ? name + ' · ' + roaster : name)
      : 'No coffee selected';
    const head = el('div', { class: 'coffee-context-head' },
      el('div', {
        class: 'coffee-name' + (coffee ? '' : ' empty'),
      }, label));
    if (coffee) head.append(coffeeClearButton());
    section.append(head);
    app.append(section);
    return;
  }
  if (!coffee) {
    section.append(el('h2', {}, 'Coffee'));
    section.append(el('button', { class: 'secondary',
      'data-overlay-return-key': 'choose-coffee',
      onclick: () => openCoffeePicker() }, 'Choose coffee'));
    app.append(section);
    return;
  }

  const name = nonemptyString(coffee.name);
  const roaster = nonemptyString(coffee.roaster);
  const label = roaster ? name + ' · ' + roaster : name;
  section.append(el('div', { class: 'coffee-context-head' },
    el('h2', {}, 'Coffee'),
    el('div', { class: 'coffee-context-actions' },
      el('button', { class: 'backlink',
        'data-overlay-return-key': 'change-coffee',
        onclick: () => openCoffeePicker() }, 'Change'),
      coffeeClearButton())));
  section.append(el('div', { class: 'coffee-name' }, label));
  const next = el('div', { class: 'coffee-context-block' },
    el('h3', {}, 'Next recipe'));
  const prep = isPlainObject(nextShotRecipe.prep) ? nextShotRecipe.prep : {};
  const prepLine = metadataPreparationParts(prep).map(part => part.text);
  if (prepLine.length) {
    next.append(el('div', { class: 'coffee-prep' }, prepLine.join(' · ')));
  } else {
    next.append(el('div', { class: 'coffee-prep empty' }, 'No recipe set'));
  }
  if (nextShotRecipeSourceId) {
    const source = (historyStore.rows || [])
      .find(row => row.id === nextShotRecipeSourceId);
    next.append(el('div', { class: 'coffee-source' },
      'Based on shot #' + nextShotRecipeSourceId +
      (source && fmtDate(source.startUtcSec) ? ' · ' + fmtDate(source.startUtcSec)
                                           : '')));
  }
  next.append(el('div', { class: 'coffee-section-actions' },
    el('button', { class: 'primary',
      'data-overlay-return-key': 'adjust-recipe',
      onclick: () => openNextShotEditor() },
      'Adjust recipe')));
  section.append(next);
  if (state.storage === 'unavailable') {
    app.append(section);
    return;
  }
  const matches = matchingCoffeeRows(coffee);

  const previous = el('div', {
    class: 'coffee-context-block coffee-context-history',
  },
    el('h3', {}, 'Previous with this coffee'));
  if (historyStore.error && historyStore.rows === null) {
    previous.append(el('div', { class: 'coffee-last-detail' },
      'Previous shots could not be loaded.'));
    previous.append(el('div', { class: 'coffee-section-actions' },
      el('button', { class: 'secondary', onclick: () => {
        loadCoffeeContextHistory();
      } }, 'Retry')));
  } else if (historyStore.rows === null) {
    previous.append(el('div', { class: 'coffee-last-detail' },
      'Loading previous shots…'));
  } else if (matches.length) {
    const newest = matches[0];
    const value = metadataValue(metadataRecordFromRow(newest));
    previous.append(el('div', { class: 'coffee-last' },
      'Shot #' + newest.id +
      (fmtDate(newest.startUtcSec) ? ' · ' + fmtDate(newest.startUtcSec) : '')));
    const details = metadataSummaryLines(value).slice(1);
    if (Number.isFinite(newest.yieldCg)) {
      details.unshift(fmtG(newest.yieldCg) + ' g yield');
    }
    for (const line of details) {
      previous.append(el('div', { class: 'coffee-last-detail' }, line));
    }
    previous.append(el('div', { class: 'coffee-section-actions' },
      el('button', { class: 'secondary',
        onclick: () => selectShot(newest.id) }, 'View shot'),
      el('button', { class: 'secondary',
        'data-overlay-return-key': 'compare-coffee', onclick: () => {
        metadataEditor = null;
        coffeePicker = null;
        coffeeComparisonOpen = true;
        cancelMetadataEditorLoad();
        renderMetadataOverlay();
      } }, 'More shots')));
  } else {
    const loaded = historyStore.rows.length;
    previous.append(el('div', { class: 'coffee-last-detail' },
      historyStore.hasMore
        ? `No match in loaded history (newest ${loaded} shots).`
        : 'No saved shots with this coffee.'));
  }
  if (historyStore.rows !== null && (!matches.length || historyStore.error)) {
    appendOlderCoffeeHistorySearch(previous, {
      actionsClass: 'coffee-section-actions',
      errorClass: 'coffee-last-detail err',
    });
  }
  section.append(previous);
  app.append(section);
}

function renderCoffeePicker() {
  if (!coffeePicker) return null;
  const picker = coffeePicker;
  const body = el('div', { class: 'coffee-picker' });
  let initialFocus = 'close';
  if (state && state.storage === 'unavailable') {
    initialFocus = 'new-coffee';
    body.append(el('p', { class: 'empty' },
      'Shot history is unavailable. You can still enter a new coffee.'));
  } else if (historyStore.error && historyStore.rows === null) {
    initialFocus = 'new-coffee';
    body.append(el('p', { class: 'err' },
      'Could not load coffees: ' + historyStore.error.message),
    el('button', { type: 'button', class: 'secondary coffee-picker-action',
      'data-overlay-focus-key': 'coffee-picker-retry',
      onclick: () => loadCoffeePickerHistory(picker) }, 'Retry history'));
  } else if ((picker.loadingHistory || historyStore.loading) &&
      historyStore.rows === null) {
    body.append(el('p', { class: 'empty' }, 'Loading coffees…'));
  } else if (historyStore.rows === null) {
    initialFocus = 'new-coffee';
    body.append(el('p', { class: 'empty' },
      'Coffee history was not loaded. You can still enter a new coffee.'),
    el('button', { type: 'button', class: 'secondary coffee-picker-action',
      'data-overlay-focus-key': 'coffee-picker-retry',
      onclick: () => loadCoffeePickerHistory(picker) }, 'Retry history'));
  } else {
    const coffees = knownCoffees();
    if (coffees.length) {
      initialFocus = 'existing-coffee';
      const list = el('div', { class: 'coffee-choices' });
      for (const [index, item] of coffees.entries()) {
        const name = item.coffee.name;
        const roaster = nonemptyString(item.coffee.roaster);
        list.append(el('button', { type: 'button', class: 'coffee-choice',
          'data-overlay-focus-key': coffeeIdentity(item.coffee),
          ...(index === 0
            ? { 'data-overlay-initial-focus': 'true' }
            : {}),
          onclick: () => chooseCoffee(item.coffee) },
        el('strong', {}, name),
        roaster ? el('span', {}, roaster) : null));
      }
      body.append(list);
    } else {
      initialFocus = 'new-coffee';
      body.append(el('p', { class: 'empty' },
        'No coffees found in loaded history.'));
    }
    appendOlderCoffeeHistorySearch(body, {
      buttonClass: 'secondary coffee-picker-action',
      focusKey: 'coffee-picker-load-more',
      feedback: coffeeHistoryFeedbackForDialog(),
    });
  }
  const form = el('form', { class: 'new-coffee', onsubmit: event => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) return;
    const coffee = { name };
    const roaster = form.elements.roaster.value.trim();
    if (roaster) coffee.roaster = roaster;
    chooseCoffee(coffee);
  } },
    el('h2', {}, 'New coffee'),
    inputField('Coffee', {
      name: 'name', value: picker.newCoffee.name, wide: true,
      initialFocus: initialFocus === 'new-coffee',
    }),
    inputField('Roaster', {
      name: 'roaster', value: picker.newCoffee.roaster, wide: true,
    }),
    el('button', { type: 'submit', class: 'primary',
      'data-overlay-focus-key': 'coffee-picker-submit' }, 'Use coffee'));
  form.addEventListener('input', () => {
    if (coffeePicker !== picker) return;
    picker.newCoffee.name = form.elements.name.value;
    picker.newCoffee.roaster = form.elements.roaster.value;
  });
  body.append(form);
  return el('div', { class: 'modal-backdrop' },
    el('section', { class: 'modal compact', role: 'dialog', 'aria-modal': 'true',
      tabindex: '-1', 'aria-label': 'Choose coffee' },
    el('div', { class: 'modal-head' }, el('h1', {}, 'Choose coffee'),
      el('button', { type: 'button', class: 'modal-close',
        'data-overlay-focus-key': 'coffee-picker-close',
        ...(initialFocus === 'close'
          ? { 'data-overlay-initial-focus': 'true' }
          : {}),
        onclick: () => { coffeePicker = null; renderMetadataOverlay(); },
        'aria-label': 'Close' }, '×')),
    body));
}

function renderCoffeeComparison() {
  const coffee = nextShotCoffee();
  if (!coffeeComparisonOpen || !coffee) return null;
  const matches = matchingCoffeeRows(coffee);
  const body = el('div', { class: 'coffee-comparison' },
    el('p', { class: 'loaded-count' },
      matches.length + ' matching shots in ' +
      (historyStore.rows ? historyStore.rows.length : 0) +
      ' loaded history rows'));
  for (const row of matches) {
    const value = metadataValue(metadataRecordFromRow(row));
    const card = el('section', { class: 'comparison-row' },
      el('div', { class: 'head' },
        el('span', {}, fmtDate(row.startUtcSec) || 'time unknown'),
        el('span', { class: 'id' }, '#' + row.id)),
      el('div', { class: 'comparison-result' },
        [ratingText(value), Number.isFinite(row.yieldCg)
          ? fmtG(row.yieldCg) + ' g' : null].filter(Boolean).join(' · ')));
    appendShotMetadataSummary(card, metadataRecordFromRow(row));
    card.append(el('div', { class: 'metadata-actions' },
      el('button', { class: 'secondary',
        'data-overlay-focus-key': 'comparison-use-' + row.id,
        onclick: () => useShotForNextRecipe(
          value, historyStore.rowsAreCurrent ? row.id : null) },
      'Use for next shot'),
      el('button', { class: 'backlink',
        'data-overlay-focus-key': 'comparison-open-' + row.id,
        onclick: () => {
          coffeeComparisonOpen = false;
          renderMetadataOverlay();
          selectShot(row.id);
        } }, 'Open shot')));
    body.append(card);
  }
  if (!matches.length) {
    body.append(el('p', { class: 'empty' },
      'No matching shots are loaded yet.'));
  }
  appendOlderCoffeeHistorySearch(body, {
    buttonClass: 'loadmore',
    focusKey: 'comparison-load-more',
    feedback: coffeeHistoryFeedbackForDialog(),
  });
  return el('div', { class: 'modal-backdrop' },
    el('section', { class: 'modal', role: 'dialog', 'aria-modal': 'true',
      tabindex: '-1', 'aria-label': 'Compare coffee shots' },
    el('div', { class: 'modal-head' },
      el('h1', {}, nonemptyString(coffee.name) || 'Coffee'),
      el('button', { type: 'button', class: 'modal-close',
        onclick: () => {
          coffeeComparisonOpen = false;
          renderMetadataOverlay();
        },
        'aria-label': 'Close' }, '×')),
    body));
}

function setMetadataBackgroundInert(inert) {
  for (const element of document.querySelectorAll(
      '.page-head, #banner, #app')) {
    element.inert = inert;
  }
}

function metadataOverlayExpected() {
  return !!coffeePicker || !!metadataEditor ||
    (coffeeComparisonOpen && !!nextShotCoffee());
}

// Keeps the overlay and background interaction in sync without remounting an
// open editor and losing its input.
function synchronizeMetadataOverlayState() {
  coffeeHistoryFeedbackForDialog();
  const overlay = document.getElementById('overlay');
  const expected = metadataOverlayExpected();
  if (expected && !overlay.firstElementChild) {
    renderMetadataOverlay();
    return;
  }
  if (!expected && overlay.firstElementChild) overlay.replaceChildren();
  setMetadataBackgroundInert(expected && !!overlay.firstElementChild);
}

function renderMetadataOverlay() {
  coffeeHistoryFeedbackForDialog();
  const overlay = document.getElementById('overlay');
  const active = document.activeElement;
  const wasOpen = !!overlay.firstElementChild;
  const hadOverlayFocus = !!active && overlay.contains(active);
  const overlayFocusKey = hadOverlayFocus && active.getAttribute
    ? active.getAttribute('data-overlay-focus-key') : null;
  const pickerFocus = coffeePicker && active && active.name && active.form &&
    active.form.classList.contains('new-coffee')
    ? {
      name: active.name,
      start: active.selectionStart,
      end: active.selectionEnd,
    } : null;
  const content = renderCoffeePicker() || renderMetadataEditor() ||
    renderCoffeeComparison();
  if (!wasOpen && content && !metadataOverlayReturnFocus && active &&
      !overlay.contains(active)) {
    metadataOverlayReturnFocus = {
      element: active,
      key: active.getAttribute && active.getAttribute('data-overlay-return-key'),
    };
  }
  overlay.replaceChildren();
  if (content) overlay.append(content);
  setMetadataBackgroundInert(!!content);
  if (!overlay.dataset.modalKeyboard) {
    overlay.dataset.modalKeyboard = 'true';
    overlay.addEventListener('keydown', handleMetadataOverlayKeydown);
  }
  if (pickerFocus) {
    const form = overlay.querySelector('form.new-coffee');
    const input = form && form.elements[pickerFocus.name];
    if (input) {
      input.focus();
      if (pickerFocus.start !== null && input.setSelectionRange) {
        input.setSelectionRange(pickerFocus.start, pickerFocus.end);
      }
    }
  } else if (content && overlayFocusKey) {
    // Preserve an existing keyed focus target across asynchronous content
    // updates. Initial-focus hints apply only when the dialog first opens.
    const target = [...overlay.querySelectorAll('[data-overlay-focus-key]')]
      .find(element =>
        element.getAttribute('data-overlay-focus-key') === overlayFocusKey);
    if (target) target.focus();
    else focusFirstMetadataOverlayControl(overlay);
  } else if (content && (!wasOpen || hadOverlayFocus)) {
    focusFirstMetadataOverlayControl(overlay);
  } else if (!content && metadataOverlayReturnFocus) {
    const returnFocus = metadataOverlayReturnFocus;
    metadataOverlayReturnFocus = null;
    requestAnimationFrame(() => {
      let target = returnFocus.element && returnFocus.element.isConnected
        ? returnFocus.element : null;
      if (!target && returnFocus.key) {
        target = [...document.querySelectorAll('[data-overlay-return-key]')]
          .find(element =>
            element.getAttribute('data-overlay-return-key') === returnFocus.key);
      }
      if (target) target.focus();
    });
  }
}

function metadataOverlayFocusable(overlay) {
  return [...overlay.querySelectorAll(
    'button:not([disabled]), input:not([type="hidden"]):not([disabled]), ' +
    'select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
}

function focusFirstMetadataOverlayControl(overlay) {
  const controls = metadataOverlayFocusable(overlay);
  const preferred = controls.find(control =>
    control.hasAttribute('data-overlay-initial-focus'));
  const input = controls.find(control =>
    control.matches('input:not([type="hidden"]), select, textarea'));
  const dialog = overlay.querySelector('[role="dialog"]');
  const target = preferred || input || controls[0] || dialog;
  if (target) target.focus();
}

function closeActiveMetadataOverlay() {
  if (coffeePicker) {
    coffeePicker = null;
  } else if (metadataEditor && metadataEditor.conflict) {
    return false;
  } else if (metadataEditor) {
    if (metadataEditor.saving) return false;
    metadataEditor = null;
  } else if (coffeeComparisonOpen) {
    coffeeComparisonOpen = false;
  } else {
    return false;
  }
  renderMetadataOverlay();
  return true;
}

function handleMetadataOverlayKeydown(event) {
  const overlay = event.currentTarget;
  if (event.key === 'Escape') {
    if (closeActiveMetadataOverlay()) event.preventDefault();
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = metadataOverlayFocusable(overlay);
  if (!controls.length) {
    event.preventDefault();
    const dialog = overlay.querySelector('[role="dialog"]');
    if (dialog) dialog.focus();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey &&
      (document.activeElement === first || !overlay.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// The same form edits a saved record or the next-shot recipe. Saved-record
// writes use the ETag that was read with the metadata; recipe edits stay in
// browser storage until a shot is saved.
function readEditorValue(form, original) {
  const value = cloneJson(original);
  const textFields = [
    ['coffee', 'name'], ['coffee', 'roaster'], ['coffee', 'origin'],
    ['coffee', 'roastDate'], ['coffee', 'roast'], ['coffee', 'process'],
    ['coffee', 'variety'], ['prep', 'grinder'], ['prep', 'grind'],
    ['prep', 'pressure'], ['prep', 'water'],
  ];
  for (const [group, name] of textFields) {
    const input = form.elements[group + '.' + name];
    if (!input.disabled) setField(value, group, name, input.value.trim());
  }
  for (const [group, name] of [['prep', 'doseG'], ['prep', 'tempC']]) {
    const input = form.elements[group + '.' + name];
    if (!input.disabled) {
      const raw = input.value.trim();
      setField(value, group, name, raw === '' ? null : Number(raw));
    }
  }
  if (!form.elements.tdsPct.disabled) {
    const tds = form.elements.tdsPct.value.trim();
    setField(value, null, 'tdsPct', tds === '' ? null : Number(tds));
  }
  if (editorFieldCompatible(original, null, 'rating', 'rating')) {
    setField(value, null, 'rating', metadataEditor.rating || null);
  }
  if (!form.elements.tags.disabled) {
    const tags = [...metadataEditor.tags,
      ...form.elements.tags.value.split(',').map(v => v.trim()).filter(Boolean)];
    setField(value, null, 'tags', [...new Set(tags)]);
  }
  if (!form.elements.notes.disabled) {
    setField(value, null, 'notes', form.elements.notes.value.trim());
  }
  return value;
}

function metadataNumericInputError(form) {
  const fields = [
    ['prep.doseG', 'Dose must be a finite number greater than zero.',
      value => value > 0],
    ['prep.tempC', 'Temperature must be a finite number.', () => true],
    ['tdsPct', 'TDS must be a finite percentage from 0 to 100.',
      value => value >= 0 && value <= 100],
  ];
  for (const [name, message, inRange] of fields) {
    const input = form.elements[name];
    if (!input || input.disabled || input.value.trim() === '') continue;
    const value = Number(input.value);
    if (!Number.isFinite(value) || !inRange(value)) return message;
  }
  return null;
}

function showMetadataEditorError(form, message) {
  metadataEditor.error = message;
  if (!form.querySelector) return;
  let error = form.querySelector('.editor-error');
  if (!error) {
    error = el('p', { class: 'err editor-error' });
    const actions = form.querySelector('.editor-actions');
    if (actions) form.insertBefore(error, actions);
    else form.append(error);
  }
  error.textContent = message;
}

function editorFieldCompatible(root, group, name, kind) {
  const owner = group ? root[group] : root;
  if (owner == null) return true;
  if (!isPlainObject(owner)) return false;
  if (!(name in owner)) return true;
  if (kind === 'number') return typeof owner[name] === 'number';
  if (kind === 'rating') {
    return Number.isInteger(owner[name]) && owner[name] >= 1 && owner[name] <= 5;
  }
  if (kind === 'array') return Array.isArray(owner[name]) &&
    owner[name].every(v => typeof v === 'string');
  return typeof owner[name] === 'string';
}

const COFFEE_EDITOR_FIELDS = [
  ['name'], ['roaster'], ['origin'], ['roastDate'], ['roast'], ['process'],
  ['variety'],
];
const PREP_EDITOR_FIELDS = [
  ['grinder'], ['grind'], ['doseG', 'number'], ['tempC', 'number'],
  ['pressure'], ['water'],
];

function editorSectionCompatible(root, group, fields) {
  return fields.every(([name, kind]) =>
    editorFieldCompatible(root, group, name, kind));
}

function closeMetadataEditor() {
  if (metadataEditor && metadataEditor.saving) return;
  metadataEditor = null;
  renderMetadataOverlay();
}

function openMetadataEditor(id, record, options = {}) {
  if (!record || !record.etag || record.state === 'unsupported') return false;
  cancelMetadataEditorLoad();
  const original = cloneJson(metadataValue(record));
  metadataEditor = {
    kind: 'shot',
    id,
    record,
    original,
    rating: Number.isInteger(original.rating) ? original.rating : 0,
    tags: Array.isArray(original.tags) ? [...original.tags] : [],
    saving: false,
    error: null,
    conflict: null,
    returnToHistory: !!options.returnToHistory,
  };
  coffeePicker = null;
  coffeeComparisonOpen = false;
  renderMetadataOverlay();
  return true;
}

function openNextShotEditor() {
  cancelMetadataEditorLoad();
  const original = cloneJson(nextShotRecipe);
  metadataEditor = {
    kind: 'recipe',
    id: null,
    record: null,
    original,
    recipeSourceId: nextShotRecipeSourceId,
    recipeSourceCoffeeIdentity: nextShotRecipeSourceId
      ? coffeeIdentity(original.coffee) : null,
    rating: 0,
    tags: [],
    saving: false,
    error: null,
    conflict: null,
  };
  coffeePicker = null;
  coffeeComparisonOpen = false;
  renderMetadataOverlay();
}

function openEditorCoffeePicker(form) {
  if (!metadataEditor || metadataEditor.saving) {
    return;
  }
  const editor = metadataEditor;
  editor.original = readEditorValue(form, editor.original);
  openCoffeePicker((recipe, sourceId) => {
    if (metadataEditor !== editor) return;
    if (editor.kind === 'recipe') {
      editor.original = recipe;
      editor.recipeSourceId = sourceId;
      editor.recipeSourceCoffeeIdentity = sourceId
        ? coffeeIdentity(recipe.coffee) : null;
    } else {
      editor.original.coffee = cloneJson(recipe.coffee);
      fillMissingPreparationFromRecipe(editor.original, recipe);
    }
    editor.error = null;
  });
}

function publishMetadataRecord(record, updateHistory = true) {
  if (lastShotMetadata && lastShotMetadata.id === record.id) {
    lastShotMetadata = record;
  }
  if (selectedShotId === record.id) selectedShotMetadata = record;
  if (updateHistory) historyStore.metadataChanged(record);
  scheduleRender();
}

function metadataTooLargeMessage() {
  return 'Shot details exceed the ' +
    SHOT_METADATA_MAX_BYTES.toLocaleString() + '-byte limit.';
}

function startMetadataEditorBlank() {
  if (!metadataEditor || metadataEditor.saving) return;
  metadataEditor.original = {};
  metadataEditor.recipeSourceId = null;
  metadataEditor.recipeSourceCoffeeIdentity = null;
  metadataEditor.rating = 0;
  metadataEditor.tags = [];
  renderMetadataOverlay();
}

function useCurrentRecipeInMetadataEditor(form) {
  if (!metadataEditor || metadataEditor.kind !== 'shot' ||
      metadataEditor.saving ||
      metadataEditor.record.state !== 'absent') {
    return;
  }
  const recipe = recipeFromMetadata(nextShotRecipe);
  if (!coffeeIdentity(recipe.coffee)) return;
  const value = readEditorValue(form, metadataEditor.original);
  value.coffee = cloneJson(recipe.coffee);
  if (isPlainObject(recipe.prep)) value.prep = cloneJson(recipe.prep);
  metadataEditor.original = value;
  metadataEditor.error = null;
  renderMetadataOverlay();
}

async function loadMetadataConflict(editor, action, localValue = null) {
  await readCurrentShotMetadata(editor.id, record => {
    if (metadataEditor !== editor) return;
    publishMetadataRecord(record);
    editor.conflict = { action, record, localValue };
    editor.error = null;
  }, err => {
    if (metadataEditor !== editor) return;
    editor.error = 'Shot details changed, but the current version could not be '
      + 'loaded: ' + err.message;
  });
  if (metadataEditor === editor) {
    editor.saving = false;
    renderMetadataOverlay();
  }
}

async function writeShotMetadata(editor, value) {
  const encoded = encodeShotMetadata(value);
  editor.original = value;
  if (encoded.tooLarge) {
    editor.error = metadataTooLargeMessage();
    renderMetadataOverlay();
    return;
  }
  editor.saving = true;
  editor.error = null;
  editor.conflict = null;
  renderMetadataOverlay();
  try {
    const result = await fetchWithTimeout(
      '/app/extraction/shot-metadata?id=' + editor.id,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': editor.record.etag,
        },
        body: encoded.body,
      }, async response => ({
        status: response.status,
        ok: response.ok,
        conflict: response.headers.get('X-Shot-Metadata-Conflict'),
        state: metadataStateFromResponse(response),
        value: response.ok ? await response.json() : null,
        crc: Number(response.headers.get('X-Shot-Metadata-Crc')) || 0,
        etag: response.headers.get('ETag'),
      }));
    if (result.status === 412) {
      if (result.conflict === 'shot-identity') {
        editor.saving = false;
        editor.conflict = { action: 'identity', localValue: value };
        renderMetadataOverlay();
        return;
      }
      await loadMetadataConflict(editor, 'save', value);
      return;
    }
    if (!result.ok) throw new Error('save failed (HTTP ' + result.status + ')');
    const saved = {
      id: editor.id,
      state: result.state,
      value: result.value,
      crc: result.crc,
      etag: result.etag,
    };
    if (editor.returnToHistory && view === 'list') {
      revealHistoryShotAfterRender(editor.id);
    }
    historyStore.metadataWritten();
    publishMetadataRecord(saved);
    if (metadataEditor === editor) metadataEditor = null;
    renderMetadataOverlay();
    flashBanner('Shot details saved.', 'live');
  } catch (err) {
    if (metadataEditor === editor) {
      editor.saving = false;
      editor.error = err.message;
      renderMetadataOverlay();
    }
  }
}

async function saveMetadataEditor(form) {
  if (!metadataEditor || metadataEditor.saving) return;
  const editor = metadataEditor;
  const numericError = metadataNumericInputError(form);
  if (numericError) {
    showMetadataEditorError(form, numericError);
    return;
  }
  const value = readEditorValue(form, editor.original);
  if (editor.kind === 'recipe') {
    delete value.rating;
    delete value.tdsPct;
    delete value.tags;
    delete value.notes;
    editor.original = value;
    const identity = coffeeIdentity(value.coffee);
    if (!identity) {
      editor.error = 'Coffee is required for the next-shot recipe.';
      renderMetadataOverlay();
      return;
    }
    const encoded = encodeShotMetadata(value);
    if (encoded.tooLarge) {
      editor.error = metadataTooLargeMessage();
      renderMetadataOverlay();
      return;
    }
    nextShotRecipe = value;
    nextShotRecipeSourceId = editor.recipeSourceId &&
      identity === editor.recipeSourceCoffeeIdentity
      ? editor.recipeSourceId : null;
    saveMetadataBrowserState();
    metadataEditor = null;
    scheduleRender();
    renderMetadataOverlay();
    return;
  }
  await writeShotMetadata(editor, value);
}

async function clearShotMetadata(editor) {
  editor.saving = true;
  editor.error = null;
  editor.conflict = null;
  renderMetadataOverlay();
  try {
    const result = await fetchWithTimeout(
      '/app/extraction/shot-metadata?id=' + editor.id,
      { method: 'DELETE', headers: { 'If-Match': editor.record.etag } },
      response => ({
        status: response.status,
        ok: response.ok,
        conflict: response.headers.get('X-Shot-Metadata-Conflict'),
        state: metadataStateFromResponse(response),
        crc: Number(response.headers.get('X-Shot-Metadata-Crc')) || 0,
        etag: response.headers.get('ETag'),
      }));
    if (result.status === 412) {
      if (result.conflict === 'shot-identity') {
        editor.saving = false;
        editor.conflict = { action: 'identity', localValue: null };
        renderMetadataOverlay();
        return;
      }
      await loadMetadataConflict(editor, 'clear');
      return;
    }
    if (!result.ok) throw new Error('clear failed (HTTP ' + result.status + ')');
    const saved = {
      id: editor.id,
      state: result.state,
      value: null,
      crc: result.crc,
      etag: result.etag,
    };
    if (editor.returnToHistory && view === 'list') {
      revealHistoryShotAfterRender(editor.id);
    }
    historyStore.metadataWritten();
    publishMetadataRecord(saved);
    if (metadataEditor === editor) metadataEditor = null;
    renderMetadataOverlay();
    flashBanner('Shot details cleared.', 'idle');
  } catch (err) {
    if (metadataEditor === editor) {
      editor.saving = false;
      editor.error = err.message;
      renderMetadataOverlay();
    }
  }
}

async function clearSavedMetadata() {
  if (!metadataEditor || metadataEditor.saving) return;
  if (!confirm('Clear saved shot details? This cannot be undone.')) return;
  await clearShotMetadata(metadataEditor);
}

async function overwriteMetadataConflict() {
  if (!metadataEditor || !metadataEditor.conflict) return;
  const editor = metadataEditor;
  const conflict = editor.conflict;
  if (conflict.action === 'identity') return;
  editor.record = conflict.record;
  editor.conflict = null;
  if (conflict.action === 'save') {
    await writeShotMetadata(editor, conflict.localValue);
  } else {
    await clearShotMetadata(editor);
  }
}

function keepSavedMetadataConflict() {
  if (!metadataEditor || !metadataEditor.conflict) return;
  const editor = metadataEditor;
  if (editor.conflict.action === 'identity') return;
  metadataEditor = null;
  renderMetadataOverlay();
}

function tagInputField(value) {
  const compatible = editorFieldCompatible(value, null, 'tags', 'array');
  const input = el('input', {
    type: 'text', name: 'tags', placeholder: 'Add a tag', list: 'metadata-tags',
  });
  input.disabled = !compatible;
  const chips = el('div', { class: 'tag-chips' });
  const renderChips = () => {
    chips.replaceChildren();
    for (const tag of metadataEditor.tags) {
      const chip = el('button', { type: 'button', onclick: () => {
        if (!compatible) return;
        metadataEditor.tags = metadataEditor.tags.filter(value => value !== tag);
        renderChips();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } }, tag + ' ×');
      chip.disabled = !compatible;
      chips.append(chip);
    }
  };
  const commitInput = () => {
    if (!compatible) return;
    const additions = input.value.split(',').map(v => v.trim()).filter(Boolean);
    if (!additions.length) return;
    metadataEditor.tags = [...new Set([...metadataEditor.tags, ...additions])];
    input.value = '';
    renderChips();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commitInput();
    }
  });
  input.addEventListener('blur', commitInput);
  renderChips();
  return el('label', { class: 'field wide' }, el('span', {}, 'Tags'),
    el('div', { class: 'tag-editor' }, chips, input));
}

function metadataEditorShot() {
  if (!metadataEditor || metadataEditor.kind !== 'shot') return null;
  return shotForMetadataId(metadataEditor.id);
}

function metadataConflictText(record) {
  if (record.state === 'active') return JSON.stringify(record.value, null, 2);
  if (record.state === 'cleared') return 'Saved details were cleared.';
  if (record.state === 'absent') return 'No shot details are saved.';
  return 'Shot details are ' + record.state + '.';
}

function renderMetadataConflict() {
  const conflict = metadataEditor.conflict;
  if (conflict.action === 'identity') {
    const localChanges = conflict.localValue
      ? JSON.stringify(conflict.localValue, null, 2)
      : null;
    return el('div', { class: 'modal-backdrop' },
      el('section', { class: 'modal compact metadata-conflict', role: 'dialog',
        tabindex: '-1', 'aria-modal': 'true',
        'aria-label': 'Shot is no longer the same record' },
      el('div', { class: 'modal-head' },
        el('h1', {}, 'Shot changed')),
      el('p', {}, 'The device restarted or its storage changed. This shot ID ' +
        'can no longer be assumed to identify the record you opened.'),
      localChanges ? el('h2', {}, 'Your unsaved changes') : null,
      localChanges ? el('pre', {}, localChanges) : null,
      el('p', {}, 'Close this dialog and reopen the shot before editing it.'),
      el('div', { class: 'editor-actions' },
        el('button', { type: 'button', class: 'secondary',
          onclick: () => closeMetadataEditor() }, 'Close'))));
  }
  const localText = conflict.action === 'save'
    ? JSON.stringify(conflict.localValue, null, 2)
    : 'Clear all saved shot details.';
  return el('div', { class: 'modal-backdrop' },
    el('section', { class: 'modal compact metadata-conflict', role: 'dialog',
      tabindex: '-1', 'aria-modal': 'true',
      'aria-label': 'Shot details changed' },
    el('div', { class: 'modal-head' },
      el('h1', {}, 'Shot details changed')),
    el('p', {}, 'This record was updated elsewhere after you opened it. ' +
      'Choose which version to keep.'),
    el('h2', {}, 'Currently saved on device'),
    el('pre', {}, metadataConflictText(conflict.record)),
    el('h2', {}, conflict.action === 'save' ? 'Your changes' : 'Your action'),
    el('pre', {}, localText),
    el('div', { class: 'editor-actions' },
      el('button', { type: 'button', class: 'secondary',
        onclick: () => keepSavedMetadataConflict() }, 'Keep saved version'),
      el('button', { type: 'button', class: 'destructive-secondary',
        onclick: () => overwriteMetadataConflict() },
      conflict.action === 'save' ? 'Overwrite with my changes' : 'Clear anyway'))));
}

function renderMetadataEditor() {
  if (!metadataEditor) return null;
  if (metadataEditor.conflict) return renderMetadataConflict();
  const value = metadataEditor.original;
  const coffeeOk = editorSectionCompatible(
    value, 'coffee', COFFEE_EDITOR_FIELDS);
  const prepOk = editorSectionCompatible(value, 'prep', PREP_EDITOR_FIELDS);
  const form = el('form', {
    class: 'metadata-editor',
    onsubmit: event => {
      event.preventDefault();
      saveMetadataEditor(form);
    },
  });

  const coffeeName = inputField('Coffee', { name: 'coffee.name',
    value: fieldValue(value, 'coffee', 'name'),
    disabled: !editorFieldCompatible(value, 'coffee', 'name'), wide: true });
  const coffeeFields = el('div', { class: 'field-grid' },
    el('div', { class: 'field-with-action wide' }, coffeeName,
      el('button', { type: 'button', class: 'secondary',
        onclick: () => openEditorCoffeePicker(form) }, 'Choose')),
    inputField('Roaster', { name: 'coffee.roaster',
      value: fieldValue(value, 'coffee', 'roaster'), list: 'coffee-roasters',
      disabled: !editorFieldCompatible(value, 'coffee', 'roaster') }),
    inputField('Origin', { name: 'coffee.origin',
      value: fieldValue(value, 'coffee', 'origin'), list: 'coffee-origins',
      disabled: !editorFieldCompatible(value, 'coffee', 'origin') }),
    inputField('Roast date', { name: 'coffee.roastDate',
      value: fieldValue(value, 'coffee', 'roastDate'),
      placeholder: 'YYYY-MM-DD',
      disabled: !editorFieldCompatible(value, 'coffee', 'roastDate') }),
    inputField('Roast', { name: 'coffee.roast',
      value: fieldValue(value, 'coffee', 'roast'), list: 'coffee-roasts',
      disabled: !editorFieldCompatible(value, 'coffee', 'roast') }),
    inputField('Process', { name: 'coffee.process',
      value: fieldValue(value, 'coffee', 'process'), list: 'coffee-processes',
      disabled: !editorFieldCompatible(value, 'coffee', 'process') }),
    inputField('Variety', { name: 'coffee.variety',
      value: fieldValue(value, 'coffee', 'variety'), list: 'coffee-varieties',
      disabled: !editorFieldCompatible(value, 'coffee', 'variety') }),
  );
  if (!coffeeOk) coffeeFields.prepend(el('p', { class: 'field-warning' },
    'Some coffee fields contain values this editor cannot edit directly. ' +
    'They are preserved unless you choose another coffee.'));

  const prepFields = el('div', { class: 'field-grid' },
    inputField('Grinder', { name: 'prep.grinder',
      value: fieldValue(value, 'prep', 'grinder'), list: 'prep-grinders',
      disabled: !editorFieldCompatible(value, 'prep', 'grinder') }),
    inputField('Grind', { name: 'prep.grind',
      value: fieldValue(value, 'prep', 'grind'), list: 'prep-grinds',
      disabled: !editorFieldCompatible(value, 'prep', 'grind') }),
    inputField('Dose (g)', { name: 'prep.doseG', type: 'number', step: 'any',
      value: fieldValue(value, 'prep', 'doseG', 'number'),
      disabled: !editorFieldCompatible(value, 'prep', 'doseG', 'number') }),
    inputField('Temp (°C)', { name: 'prep.tempC', type: 'number', step: 'any',
      value: fieldValue(value, 'prep', 'tempC', 'number'),
      disabled: !editorFieldCompatible(value, 'prep', 'tempC', 'number') }),
    inputField('Pressure / profile', { name: 'prep.pressure',
      value: fieldValue(value, 'prep', 'pressure'), list: 'prep-pressures',
      disabled: !editorFieldCompatible(value, 'prep', 'pressure') }),
    inputField('Water', { name: 'prep.water',
      value: fieldValue(value, 'prep', 'water'), list: 'prep-waters',
      disabled: !editorFieldCompatible(value, 'prep', 'water') }),
  );
  if (!prepOk) prepFields.prepend(el('p', { class: 'field-warning' },
    'Some preparation fields contain values this editor cannot edit. ' +
    'They are preserved when you save.'));

  const rating = el('div', { class: 'rating', role: 'group',
    'aria-label': 'Rating' });
  const ratingCompatible = editorFieldCompatible(value, null, 'rating', 'rating');
  for (let i = 1; i <= 5; ++i) {
    const button = el('button', {
      type: 'button', class: i <= metadataEditor.rating ? 'on' : '',
      'data-rating': i,
      'aria-pressed': i === metadataEditor.rating ? 'true' : 'false',
      onclick: () => {
        metadataEditor.rating = i;
        for (const button of rating.querySelectorAll('[data-rating]')) {
          button.classList.toggle('on', Number(button.dataset.rating) <= i);
          button.setAttribute('aria-pressed',
            Number(button.dataset.rating) === i ? 'true' : 'false');
        }
        clearRating.setAttribute('aria-pressed', 'false');
        rating.dispatchEvent(new Event('input', { bubbles: true }));
      },
      'aria-label': i + ' star' + (i === 1 ? '' : 's'),
    }, '★');
    button.disabled = !ratingCompatible;
    rating.append(button);
  }
  const clearRating = el('button', { type: 'button', class: 'clear-rating',
    'aria-pressed': metadataEditor.rating === 0 ? 'true' : 'false',
    onclick: () => {
      metadataEditor.rating = 0;
      for (const button of rating.querySelectorAll('[data-rating]')) {
        button.classList.remove('on');
        button.setAttribute('aria-pressed', 'false');
      }
      clearRating.setAttribute('aria-pressed', 'true');
      rating.dispatchEvent(new Event('input', { bubbles: true }));
    } }, 'Unrated');
  clearRating.disabled = !ratingCompatible;
  rating.append(clearRating);

  form.append(el('h2', {}, 'Coffee'), coffeeFields,
    el('h2', {}, 'Preparation'), prepFields);
  if (metadataEditor.kind === 'shot') {
    form.append(el('h2', {}, 'Result'),
      el('label', { class: 'field wide' }, el('span', {}, 'Rating'), rating),
      el('div', { class: 'field-grid' },
      tagInputField(value),
      el('label', { class: 'field wide' }, el('span', {}, 'Notes'),
        (() => {
          const notes = el('textarea', { name: 'notes', rows: '5' },
            typeof value.notes === 'string' ? value.notes : '');
          notes.disabled = !editorFieldCompatible(value, null, 'notes');
          return notes;
        })()),
      inputField('TDS (%)', { name: 'tdsPct', type: 'number', step: 'any',
        min: '0', max: '100',
        value: fieldValue(value, null, 'tdsPct', 'number'),
        disabled: !editorFieldCompatible(value, null, 'tdsPct', 'number') }),
      ));
    const shot = metadataEditorShot();
    const extractionYield = el('div', { class: 'extraction-yield' });
    const updateExtractionYield = () => {
      const doseText = form.elements['prep.doseG'].value.trim();
      const tdsText = form.elements.tdsPct.value.trim();
      const dose = Number(doseText);
      const tds = Number(tdsText);
      if (shot && shot.yieldCg > 0 && doseText && tdsText &&
          Number.isFinite(dose) && dose > 0 && Number.isFinite(tds) &&
          tds >= 0 && tds <= 100) {
        extractionYield.textContent = 'Extraction yield: ' +
          (tds * (shot.yieldCg / 100) / dose).toFixed(1) + '%';
      } else {
        extractionYield.textContent = '';
      }
    };
    form.addEventListener('input', updateExtractionYield);
    updateExtractionYield();
    form.append(extractionYield);
  } else {
    for (const name of ['tdsPct', 'tags', 'notes']) {
      form.append(el('input', { type: 'hidden', name, value: '' }));
    }
  }

  form.append(
    suggestionList('coffee-roasters', metadataSuggestions(['coffee', 'roaster'])),
    suggestionList('coffee-origins', metadataSuggestions(['coffee', 'origin'])),
    suggestionList('coffee-roasts', [...new Set([
      'light', 'medium-light', 'medium', 'medium-dark', 'dark',
      ...metadataSuggestions(['coffee', 'roast']),
    ])]),
    suggestionList('coffee-processes', metadataSuggestions(['coffee', 'process'])),
    suggestionList('coffee-varieties', metadataSuggestions(['coffee', 'variety'])),
    suggestionList('prep-grinders', metadataSuggestions(['prep', 'grinder'])),
    suggestionList('prep-grinds', metadataSuggestions(['prep', 'grind'])),
    suggestionList('prep-pressures', metadataSuggestions(['prep', 'pressure'])),
    suggestionList('prep-waters', metadataSuggestions(['prep', 'water'])),
    suggestionList('metadata-tags', (() => {
      const tags = new Set();
      for (const row of historyStore.rows || []) {
        const value = metadataValue(metadataRecordFromRow(row));
        if (Array.isArray(value.tags)) {
          value.tags.filter(tag => typeof tag === 'string')
            .forEach(tag => tags.add(tag));
        }
      }
      return [...tags].sort((a, b) => a.localeCompare(b));
    })()),
  );

  const size = el('div', { class: 'metadata-size' });
  const updateSize = () => {
    const value = readEditorValue(form, metadataEditor.original);
    const encodedBytes = new TextEncoder().encode(JSON.stringify(value)).length;
    const remaining = SHOT_METADATA_MAX_BYTES - encodedBytes;
    size.textContent = remaining >= 0
      ? remaining + ' bytes available'
      : -remaining + ' bytes over limit';
    size.classList.toggle('err', encodedBytes > SHOT_METADATA_MAX_BYTES);
  };
  form.addEventListener('input', () => {
    updateSize();
    if (metadataEditor.error) {
      metadataEditor.error = null;
      const error = form.querySelector('.editor-error');
      if (error) error.remove();
    }
  });
  updateSize();
  form.append(size);
  if (metadataEditor.error) {
    form.append(el('p', { class: 'err editor-error' }, metadataEditor.error));
  }
  const actions = el('div', { class: 'editor-actions' });
  if (metadataEditor.kind === 'shot' &&
      metadataEditor.record.state === 'absent' &&
      coffeeIdentity(nextShotRecipe.coffee)) {
    actions.append(el('button', { type: 'button', class: 'secondary',
      onclick: () => useCurrentRecipeInMetadataEditor(form) },
    'Copy next recipe'));
  }
  if (metadataEditor.kind === 'shot' &&
      metadataEditor.record.state !== 'absent') {
    const clear = el('button', {
      type: 'button', class: 'destructive-secondary',
      onclick: () => clearSavedMetadata() }, 'Clear saved details');
    clear.disabled = metadataEditor.saving;
    actions.append(clear);
  }
  actions.append(el('button', { type: 'button', class: 'secondary blank',
    onclick: () => startMetadataEditorBlank() }, 'Start blank'));
  const cancel = el('button', { type: 'button', class: 'secondary',
    onclick: () => closeMetadataEditor() }, 'Cancel');
  const save = el('button', { type: 'submit', class: 'primary' },
    metadataEditor.saving ? 'Saving…' : 'Save');
  cancel.disabled = metadataEditor.saving;
  save.disabled = metadataEditor.saving;
  actions.append(cancel, save);
  form.append(actions);

  if (metadataEditor.saving) {
    for (const control of form.elements) control.disabled = true;
  }

  const close = el('button', { type: 'button', class: 'modal-close',
    onclick: () => closeMetadataEditor(), 'aria-label': 'Close' }, '×');
  close.disabled = metadataEditor.saving;

  return el('div', { class: 'modal-backdrop' },
    el('section', { class: 'modal', role: 'dialog', 'aria-modal': 'true',
      tabindex: '-1', 'aria-label': metadataEditor.kind === 'shot'
        ? 'Shot details' : 'Next shot' },
    el('div', { class: 'modal-head' },
      el('h1', {}, metadataEditor.kind === 'shot'
        ? 'Shot details · #' + metadataEditor.id : 'Next shot'),
      close),
    form));
}

loadMetadataBrowserState();
