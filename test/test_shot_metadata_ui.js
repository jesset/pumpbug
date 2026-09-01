#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const fs = require('fs');
const vm = require('vm');

const [sourcePath, historyPath, codecHeaderPath] = process.argv.slice(2);
if (!sourcePath || !historyPath || !codecHeaderPath) {
  console.error(
    'usage: test_shot_metadata_ui.js UI_METADATA_JS UI_HISTORY_JS CODEC_HEADER');
  process.exit(2);
}

// A pending Promise does not keep Node alive. Fail closed so a test that
// stalls while waiting for an unresolved mock request cannot exit successfully.
process.exitCode = 1;

let storedBrowserState = null;
const banners = [];
const context = {
  console,
  lastRecord: null,
  selectedShot: null,
  selectedShotId: null,
  selectedShotMetadata: null,
  view: 'live',
  state: null,
  TextEncoder,
  performance,
  AbortController,
  setTimeout,
  clearTimeout,
  confirm: () => true,
  inPumpWindow: current => !!current && current.active &&
    (current.phase === 'RUNNING' || current.phase === 'POST_PUMP'),
  el: (tag, attrs = {}, ...children) => ({
    tag,
    attrs,
    children,
    childNodes: children,
    dataset: {},
    append(...more) {
      this.children.push(...more);
      this.childNodes = this.children;
    },
    addEventListener() {},
  }),
  setBanner: (message, kind) => banners.push({ message, kind }),
  flashBanner: (message, kind) => banners.push({ message, kind }),
  localStorage: {
    getItem: () => storedBrowserState,
    setItem: (_key, value) => { storedBrowserState = value; },
  },
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(historyPath, 'utf8') + '\n' +
  fs.readFileSync(sourcePath, 'utf8') + '\n' +
  'globalThis.api = { maxBytes: SHOT_METADATA_MAX_BYTES, fetchWithTimeout,' +
    'metadataRecordFromRow, metadataValue, metadataSummaryLines,' +
    'coffeeIdentity, recipeFromMetadata, nextShotCoffee,' +
    'fieldValue, editorSectionCompatible,' +
    'readEditorValue, metadataNumericInputError, metadataEditorShot,' +
    'recipeForCompletedShot, initializeRecentShotMetadata,' +
    'setLastShotMetadataId,' +
    'setEditor: value => { metadataEditor = value; },' +
    'editor: () => metadataEditor,' +
    'setNextRecipe: (value, sourceId = null) => {' +
      'nextShotRecipe = value; nextShotRecipeSourceId = sourceId; },' +
    'clearNextShotRecipe, startMetadataEditorBlank,' +
    'useCurrentRecipeInMetadataEditor, resolveShotMetadata,' +
    'loadCoffeeContextHistory, shouldLoadCoffeeContextHistory,' +
    'updateCoffeeContextHistoryForState,' +
    'renderCoffeeContext,' +
    'metadataStreamSessionStarted,' +
    'loadShotMetadata, openNextShotEditor,' +
    'shotMetadataListAction,' +
    'openEditorCoffeePicker, openCoffeePicker,' +
    'renderCoffeePicker, renderCoffeeComparison, renderMetadataOverlay,' +
    'focusFirstMetadataOverlayControl,' +
    'setCoffeePicker: value => { coffeePicker = value; },' +
    'setCoffeeComparisonOpen: value => { coffeeComparisonOpen = value; },' +
    'coffeePickerState: () => coffeePicker,' +
    'chooseCoffee, saveMetadataEditor, clearSavedMetadata,' +
    'closeActiveMetadataOverlay,' +
    'overwriteMetadataConflict, keepSavedMetadataConflict,' +
    'historyStore, loadMoreHistory, downloadShotJson,' +
    'selectShot, renderList,' +
    'browserState: () => ({ nextShotRecipe, nextShotRecipeSourceId }),' +
    'lastMetadata: () => lastShotMetadata,' +
    'selected: () => ({ shot: selectedShot, metadata: selectedShotMetadata }),' +
    'historyState: () => ({ rows: historyStore.rows,' +
      'coffeeHistoryLoading: historyStore.loading,' +
      'coffeeHistoryError: historyStore.error })' +
  '};',
  context,
);

let checkCount = 0;
function check(condition, message) {
  ++checkCount;
  if (!condition) throw new Error(message);
}

function descendants(root) {
  const result = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    result.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return result;
}

const codecHeader = fs.readFileSync(codecHeaderPath, 'utf8');
const maxBytesMatch = codecHeader.match(
  /kMaxShotMetadataJsonBytes\s*=\s*(\d+)/);
check(maxBytesMatch && Number(maxBytesMatch[1]) === context.api.maxBytes,
  'browser and firmware metadata limits differ');

context.api.setCoffeePicker({
  onChoose: null, newCoffee: { name: '', roaster: '' }, loadingHistory: true,
});
const loadingPickerNodes = descendants(context.api.renderCoffeePicker());
const loadingPickerClose = loadingPickerNodes.find(
  node => node.attrs && node.attrs.class === 'modal-close');
const loadingPickerCoffee = loadingPickerNodes.find(
  node => node.attrs && node.attrs.name === 'name');
check(loadingPickerClose.attrs['data-overlay-initial-focus'] === 'true' &&
      !loadingPickerCoffee.attrs['data-overlay-initial-focus'],
  'an unresolved coffee picker focused the new-coffee form below its results');

context.api.setCoffeePicker({
  onChoose: null, newCoffee: { name: '', roaster: '' }, loadingHistory: false,
});
const unloadedPickerNodes = descendants(context.api.renderCoffeePicker());
const unloadedPickerCoffee = unloadedPickerNodes.find(
  node => node.attrs && node.attrs.name === 'name');
check(unloadedPickerCoffee.attrs['data-overlay-initial-focus'] === 'true' &&
      JSON.stringify(unloadedPickerNodes).includes('Retry history'),
  'an interrupted coffee-history load left the picker stuck loading');

context.state = { storage: 'unavailable' };
const unavailablePickerNodes = descendants(context.api.renderCoffeePicker());
const unavailablePickerCoffee = unavailablePickerNodes.find(
  node => node.attrs && node.attrs.name === 'name');
check(unavailablePickerCoffee.attrs['data-overlay-initial-focus'] === 'true' &&
      JSON.stringify(unavailablePickerNodes).includes(
        'Shot history is unavailable'),
  'unavailable history did not leave new-coffee entry usable');
context.state = null;
context.api.setCoffeePicker(null);

const focused = [];
const focusControl = (name, { initial = false, input = false } = {}) => ({
  hasAttribute: attribute =>
    attribute === 'data-overlay-initial-focus' && initial,
  matches: selector => input && selector.startsWith('input'),
  focus: () => focused.push(name),
});
const focusDialog = focusControl('dialog');
context.api.focusFirstMetadataOverlayControl({
  querySelectorAll: () => [
    focusControl('close'),
    focusControl('choice', { initial: true }),
    focusControl('input', { input: true }),
  ],
  querySelector: () => focusDialog,
});
check(focused.join(',') === 'choice',
  'explicit modal focus did not take priority over a later form input');

const row = {
  id: 7,
  userMetadataState: 'active',
  userMetadata: { coffee: { name: 'Halo Beriti' }, future: { retained: true } },
  userMetadataCrc: 123,
  userMetadataEtag: 'etag-7',
};
const record = context.api.metadataRecordFromRow(row);
check(record.id === 7 && record.value.future.retained && record.etag === 'etag-7',
  'history row did not retain its metadata identity');
context.renderMetadataOverlay = () => {};
const editAction = context.api.shotMetadataListAction(7, record);
editAction.attrs.onclick({ stopPropagation() {} });
check(context.api.editor().record.etag === 'etag-7',
  'editing a history row discarded its available metadata version');
check(context.api.coffeeIdentity({ name: ' Halo Beriti ', roaster: ' Example ' }) ===
      context.api.coffeeIdentity({ name: 'halo beriti', roaster: 'example' }),
  'coffee identity is not trim- and case-insensitive');
check(context.api.metadataSummaryLines({
  coffee: { name: 'Halo Beriti', roastDate: '2026-08-12' },
  prep: { pressure: '9 bar' },
}).includes('Roasted 2026-08-12'),
  'shot summaries omit the coffee roast date');
check(context.api.metadataSummaryLines({ prep: { pressure: 'Blooming profile' } })
  .includes('Blooming profile'),
  'shot summaries omit the pressure or profile');
check(context.api.metadataSummaryLines({ prep: { water: 'Lotus Light & Bright' } })
  .includes('Lotus Light & Bright'),
  'shot summaries omit the water');
check(context.api.metadataSummaryLines({ rating: 3, tags: [1, 2] })
  .join('\n') === '★★★',
  'non-string tags added an empty shot-summary field');

const recipe = context.api.recipeFromMetadata({
  coffee: { name: 'Halo Beriti' },
  prep: { grinder: 'Niche Zero', grind: '18.5' },
  rating: 5,
  notes: 'Do not copy',
});
check(recipe.coffee.name === 'Halo Beriti' && recipe.prep.grind === '18.5' &&
      recipe.rating === undefined && recipe.notes === undefined,
  'next-shot recipe copied result fields');

const original = {
  coffee: { name: 'Old', futureCoffeeField: 9 },
  prep: { grinder: 'Old grinder', grind: { unsupported: true } },
  rating: 3,
  tags: ['old'],
  future: { retained: true },
};
check(!context.api.editorSectionCompatible(
  original, 'prep', [['grinder'], ['grind']]) &&
  context.api.fieldValue(original, 'prep', 'grind') === '',
  'nested unsupported preparation data was displayed as an editable value');
const futureCoffee = {
  coffee: { name: { localized: 'Old' }, roaster: 'Roaster' },
};
check(!context.api.editorSectionCompatible(
  futureCoffee, 'coffee', [['name'], ['roaster']]) &&
  context.api.fieldValue(futureCoffee, 'coffee', 'name') === '' &&
  context.api.fieldValue(futureCoffee, 'coffee', 'roaster') === 'Roaster',
  'nested unsupported coffee data lacked a warning-safe presentation');
context.api.setEditor({ rating: 4, tags: ['old', 'floral'] });
const element = (value, disabled = false) => ({ value, disabled });
const historyPage = (shots, options = {}) => ({
  status: 200,
  shots,
  hasMore: !!options.hasMore,
  total: options.total == null ? shots.length : options.total,
  etag: options.etag ||
    `W/"shots-${options.nonce || '11111111'}-1-m-0-20"`,
  url: '/app/extraction/shots?limit=20&meta=1',
});
const form = { elements: {
  'coffee.name': element('New'),
  'coffee.roaster': element('Roaster'),
  'coffee.origin': element(''),
  'coffee.roastDate': element(''),
  'coffee.roast': element('light'),
  'coffee.process': element('washed'),
  'coffee.variety': element('74110'),
  'prep.grinder': element('Niche Zero'),
  'prep.grind': element('', true),
  'prep.doseG': element('18.0'),
  'prep.tempC': element('93'),
  'prep.pressure': element('9 bar'),
  'prep.water': element('Lotus Light & Bright'),
  tdsPct: element('8.6'),
  tags: element('dial-in'),
  notes: element('Try finer'),
} };
const edited = context.api.readEditorValue(form, original);
check(edited.future.retained && edited.coffee.futureCoffeeField === 9,
  'editing removed unknown metadata fields');
check(edited.prep.grind.unsupported,
  'editing replaced a recognized field the editor cannot represent');
check(edited.rating === 4 && edited.tags.join(',') === 'old,floral,dial-in',
  'rating or tags were not collected from the editor');
check(edited.prep.pressure === '9 bar',
  'pressure or profile was not collected from the editor');
check(edited.prep.water === 'Lotus Light & Bright',
  'water was not collected from the editor');

context.api.setNextRecipe({
  coffee: { name: 'Current coffee', roaster: 'Current roaster' },
  prep: { grind: '21', doseG: 17.5 },
});
context.api.setEditor({
  kind: 'shot', id: 8,
  record: { id: 8, state: 'absent', etag: 'etag-8' },
  original,
  rating: 4, tags: ['old', 'floral'], saving: false, error: null,
  conflict: null,
});
context.api.useCurrentRecipeInMetadataEditor(form);
const recoveredEditor = context.api.editor();
check(recoveredEditor.original.coffee.name === 'Current coffee' &&
      recoveredEditor.original.prep.grind === '21' &&
      recoveredEditor.original.prep.doseG === 17.5 &&
      recoveredEditor.original.notes === 'Try finer' &&
      recoveredEditor.original.tdsPct === 8.6 &&
      recoveredEditor.original.future.retained,
  'using the current recipe lost result fields or copied the wrong recipe');

context.api.setNextRecipe({ coffee: { name: 'Coffee-only recipe' } });
context.api.setEditor({
  kind: 'shot', id: 8,
  record: { id: 8, state: 'absent', etag: 'etag-8' },
  original: { prep: { grind: '22' }, notes: 'Keep this result' },
  rating: 0, tags: [], saving: false, error: null, conflict: null,
});
context.api.useCurrentRecipeInMetadataEditor({ elements: {
  ...form.elements,
  'prep.grind': element('22'),
  notes: element('Keep this result'),
} });
check(context.api.editor().original.coffee.name === 'Coffee-only recipe' &&
      context.api.editor().original.prep.grind === '22' &&
      context.api.editor().original.notes === 'Keep this result',
  'a recipe without preparation erased preparation entered for the shot');

context.api.setNextRecipe({
  coffee: { name: 'Halo Beriti' }, prep: { grind: '18.5' },
});
const shotARecipe = context.api.recipeForCompletedShot();
check(shotARecipe.prep.grind === '18.5',
  'the completed shot did not receive the current recipe');

context.api.setNextRecipe({ prep: { grind: '19' } });
context.api.setNextRecipe({ prep: { grind: '20' } });
const shotBRecipe = context.api.recipeForCompletedShot();
check(shotARecipe.prep.grind === '18.5' && shotBRecipe.prep.grind === '20',
  'recipe copies were not independent at shot completion');

context.api.setNextRecipe({});
check(context.api.recipeForCompletedShot() === null,
  'an empty next-shot recipe created a metadata initialization attempt');

context.api.setNextRecipe({
  coffee: { name: 'Halo Beriti', roaster: 'Example' },
  prep: { grind: '19' },
});
context.state = { storage: 'ready', active: true, phase: 'RUNNING' };
context.scheduleRender = () => {};
context.renderMetadataOverlay = () => {};
const pumpingCoffeeApp = {
  children: [],
  append(...children) { this.children.push(...children); },
};
context.api.renderCoffeeContext(pumpingCoffeeApp);
const compactCoffee = pumpingCoffeeApp.children[0];
const compactCoffeeHead = compactCoffee.children[0];
check(compactCoffee.attrs.class === 'coffee-context compact' &&
      compactCoffee.children.length === 1 &&
      compactCoffeeHead.children[0].children[0] === 'Halo Beriti · Example' &&
      compactCoffeeHead.children[1].children[0] === 'Clear' &&
      compactCoffeeHead.children[1].attrs['aria-label'] ===
        'Clear next recipe',
  'the pump-window coffee card did not retain its identity and Clear action');
compactCoffeeHead.children[1].attrs.onclick();
const cleared = context.api.browserState();
check(Object.keys(cleared.nextShotRecipe).length === 0,
  'clearing the coffee left a hidden next-shot recipe');
const pumpingWithoutCoffeeApp = {
  children: [],
  append(...children) { this.children.push(...children); },
};
context.api.renderCoffeeContext(pumpingWithoutCoffeeApp);
const compactWithoutCoffee = pumpingWithoutCoffeeApp.children[0];
const compactWithoutCoffeeHead = compactWithoutCoffee.children[0];
check(compactWithoutCoffee.attrs.class === 'coffee-context compact' &&
      compactWithoutCoffee.children.length === 1 &&
      compactWithoutCoffeeHead.children.length === 1 &&
      compactWithoutCoffeeHead.children[0].children[0] ===
        'No coffee selected',
  'the pump-window coffee card exposed its full empty-state controls');
context.state = null;

context.api.setNextRecipe({
  coffee: { name: 'Halo Beriti', roaster: 'Example' },
  prep: { grind: '19' },
});
context.api.setEditor({
  kind: 'recipe',
  original: {
    coffee: { name: 'Halo Beriti', roaster: 'Example' },
    prep: { grind: '19' },
  },
  recipeSourceId: null,
  recipeSourceCoffeeIdentity: null,
  rating: 0, tags: [], saving: false, error: null,
});
const noCoffeeForm = { elements: {
  ...form.elements,
  'coffee.name': element(''),
  'coffee.roaster': element(''),
  'coffee.origin': element(''),
  'coffee.roastDate': element(''),
  'coffee.roast': element(''),
  'coffee.process': element(''),
  'coffee.variety': element(''),
  'prep.grinder': element(''),
  'prep.grind': element('19'),
  'prep.doseG': element(''),
  'prep.tempC': element(''),
  'prep.pressure': element(''),
  'prep.water': element(''),
} };
context.api.saveMetadataEditor(noCoffeeForm);
check(context.api.editor().error &&
      context.api.browserState().nextShotRecipe.coffee.name === 'Halo Beriti' &&
      context.api.browserState().nextShotRecipe.prep.grind === '19',
  'saving a recipe without coffee created hidden preparation state');

const sourceCoffee = { name: 'Halo Beriti', roaster: 'Example' };
context.api.setNextRecipe({ coffee: sourceCoffee, prep: { grind: '19' } }, 42);
context.api.openNextShotEditor();
context.api.saveMetadataEditor({ elements: {
  ...noCoffeeForm.elements,
  'coffee.name': element('Halo Beriti'),
  'coffee.roaster': element('Example'),
  'prep.grind': element('20'),
} });
check(context.api.browserState().nextShotRecipeSourceId === 42,
  'adjusting a recipe discarded its source shot');
check(!('nextShotRecipeSourceId' in JSON.parse(storedBrowserState)),
  'a storage-relative recipe source id was persisted across page reloads');
context.api.setNextRecipe({
  coffee: sourceCoffee, prep: { grind: '20' },
}, 42);
context.api.openNextShotEditor();
context.api.metadataStreamSessionStarted();
check(context.api.editor().recipeSourceId === null,
  'a new stream session left stale provenance in an open recipe editor');
context.api.saveMetadataEditor({ elements: {
  ...noCoffeeForm.elements,
  'coffee.name': element('Halo Beriti'),
  'coffee.roaster': element('Example'),
  'prep.grind': element('20'),
} });
check(context.api.browserState().nextShotRecipeSourceId === null &&
      context.api.browserState().nextShotRecipe.coffee.name === 'Halo Beriti',
  'saving after reconnect restored stale provenance or discarded the recipe');

context.api.setNextRecipe({ coffee: sourceCoffee, prep: { grind: '19' } }, 42);
context.api.openNextShotEditor();
context.api.saveMetadataEditor({ elements: {
  ...noCoffeeForm.elements,
  'coffee.name': element('Different coffee'),
  'coffee.roaster': element('Example'),
  'prep.grind': element('20'),
} });
check(context.api.browserState().nextShotRecipeSourceId === null,
  'changing coffee identity retained another shot as the recipe source');
check(!context.api.shouldLoadCoffeeContextHistory({
  storage: 'ready', active: true, phase: 'RUNNING',
}), 'restored coffee history was eligible to load during a pump window');
check(context.api.shouldLoadCoffeeContextHistory({
  storage: 'ready', active: true, phase: 'IDLE',
}), 'restored coffee history was not eligible to load while idle');

context.api.setEditor({
  original: { coffee: { name: 'Halo Beriti' } },
  rating: 5,
  tags: ['floral'],
  saving: false,
});
context.api.startMetadataEditorBlank();
const blankEditor = context.api.editor();
check(Object.keys(blankEditor.original).length === 0 &&
      blankEditor.rating === 0 && blankEditor.tags.length === 0,
  'starting blank retained editor fields');

(async () => {
  let bodyReadStarted;
  const bodyStarted = new Promise(resolve => { bodyReadStarted = resolve; });
  context.fetch = async (_path, options) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_resolve, reject) => {
      bodyReadStarted();
      options.signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const caller = new AbortController();
  const bodyRead = context.api.fetchWithTimeout(
    '/slow', { signal: caller.signal }, response => response.json());
  await bodyStarted;
  caller.abort();
  let bodyWasCancelled = false;
  try {
    await bodyRead;
  } catch (err) {
    bodyWasCancelled = err.name === 'AbortError';
  }
  check(bodyWasCancelled,
    'request cancellation stopped at headers instead of cancelling the body');

  context.state = { storage: 'ready' };
  const realEnsureLoaded = context.api.historyStore.ensureLoaded;
  let finishPickerHistory;
  context.api.historyStore.ensureLoaded = () => new Promise(resolve => {
    finishPickerHistory = resolve;
  });
  const openingPicker = context.api.openCoffeePicker();
  check(context.api.coffeePickerState().loadingHistory,
    'opening the coffee picker did not track its history request');
  finishPickerHistory({ status: 'cancelled' });
  await openingPicker;
  const interruptedPicker = JSON.stringify(
    descendants(context.api.renderCoffeePicker()));
  check(!context.api.coffeePickerState().loadingHistory &&
        interruptedPicker.includes('Coffee history was not loaded.') &&
        interruptedPicker.includes('Retry history'),
    'a superseded picker history request left the picker loading');
  context.api.historyStore.ensureLoaded = realEnsureLoaded;
  context.api.setCoffeePicker(null);

  let undemandedHistoryRequests = 0;
  context.fetchShotsPage = async () => {
    ++undemandedHistoryRequests;
    return historyPage([]);
  };
  context.api.historyStore.sessionStarted();
  await context.api.historyStore.observeDeviceState('ready');
  check(undemandedHistoryRequests === 0,
    'a device session loaded history before a view requested it');
  context.fetchShotsPage = async () => {
    throw new Error('history unavailable');
  };
  const failedHistoryLoad =
    await context.api.historyStore.refreshPreservingRows();
  const historyErrorView = context.el('main');
  context.api.renderList(historyErrorView);
  const historyErrorText = JSON.stringify(historyErrorView);
  check(failedHistoryLoad.status === 'error' &&
        historyErrorText.includes('Shot history could not be loaded.') &&
        historyErrorText.includes('Retry'),
    'an initial history failure remained stuck in the loading state');
  context.api.setCoffeePicker({
    onChoose: null, newCoffee: { name: '', roaster: '' },
    loadingHistory: false,
  });
  const failedPickerNodes = descendants(context.api.renderCoffeePicker());
  const failedPickerCoffee = failedPickerNodes.find(
    node => node.attrs && node.attrs.name === 'name');
  check(failedPickerCoffee.attrs['data-overlay-initial-focus'] === 'true' &&
        JSON.stringify(failedPickerNodes).includes('Could not load coffees:') &&
        JSON.stringify(failedPickerNodes).includes('Retry history'),
    'a coffee-history error did not leave new-coffee entry and retry usable');
  context.api.setCoffeePicker(null);

  let failedHistoryInvalidationNotifications = 0;
  const unsubscribeFailedHistory = context.api.historyStore.subscribe(
    () => { ++failedHistoryInvalidationNotifications; });
  context.api.historyStore.sessionStarted();
  const invalidatedHistoryErrorView = context.el('main');
  context.api.renderList(invalidatedHistoryErrorView);
  check(failedHistoryInvalidationNotifications === 1 &&
        JSON.stringify(invalidatedHistoryErrorView).includes('Retry'),
    'session invalidation left an unreported or dead initial-history retry');
  let initialHistoryRetryRequests = 0;
  context.fetchShotsPage = async () => {
    ++initialHistoryRetryRequests;
    throw new Error('history still unavailable');
  };
  const initialHistoryRetry = await context.api.historyStore.retry();
  check(initialHistoryRetry.status === 'error' &&
        initialHistoryRetryRequests === 1 &&
        context.api.historyStore.error,
    'initial-history retry did not remain actionable after invalidation');
  unsubscribeFailedHistory();

  context.selectedShotId = 8;
  context.scheduleRender = () => {};
  context.fetchShotMetadata = async id => ({
    id, state: 'absent', value: null, crc: 0, etag: 'etag-' + id,
  });
  const resolved = await context.api.resolveShotMetadata(8);
  check(resolved.state === 'absent' &&
        context.selectedShotMetadata.state === 'absent',
  'resolving shot metadata did not update the selected shot');

  context.api.setEditor(null);
  context.lastRecord = { shotId: 999 };
  context.flashBanner = (message, kind) => banners.push({ message, kind });
  context.fetchShotMetadata = async id => ({
    id, state: 'unsupported', value: null, crc: 0, etag: null,
  });
  await context.api.loadShotMetadata(999);
  check(context.api.editor() === null &&
        banners.some(entry => entry.message.includes('unsupported')),
    'an unsupported metadata record left a silent, stale editor action');

  let initializationRequest = null;
  context.fetchWithTimeout = async (_path, options, consume) => {
    initializationRequest = options;
    return consume({
      ok: true,
      status: 200,
      headers: { get: name => name === 'ETag' ? 'saved-etag' : '0' },
      json: async () => JSON.parse(options.body),
    });
  };
  context.metadataStateFromResponse = () => 'active';
  const initialized = await context.api.initializeRecentShotMetadata(8, {
    coffee: { name: 'Halo Beriti' }, prep: { grind: '20' },
  });
  check(initialized.needsResult && initialized.etag === 'saved-etag' &&
        initializationRequest.method === 'POST' &&
        initializationRequest.headers['Content-Type'] === 'application/json' &&
        JSON.parse(initializationRequest.body).prep.grind === '20',
  'recent-shot initialization did not send the independent recipe copy');

  context.fetchWithTimeout = async (_path, _options, consume) => consume({
    ok: false,
    status: 409,
    headers: { get: () => null },
    json: async () => ({ reason: 'metadata_not_absent' }),
  });
  check(await context.api.initializeRecentShotMetadata(9,
    { coffee: { name: 'First writer lost' } }) === null,
  'an already-initialized shot was not treated as an expected no-op');

  context.fetchWithTimeout = async (_path, _options, consume) => consume({
    ok: false,
    status: 409,
    headers: { get: () => null },
    json: async () => ({ reason: 'shot_not_eligible' }),
  });
  let ineligibleError = null;
  try {
    await context.api.initializeRecentShotMetadata(9,
      { coffee: { name: 'Too late' } });
  } catch (err) {
    ineligibleError = err;
  }
  check(ineligibleError && ineligibleError.message.includes('newer shot'),
    'an ineligible shot did not report why its recipe was rejected');

  const realShotSaved = context.api.historyStore.shotSaved;
  let savedShotNotifications = 0;
  context.api.historyStore.shotSaved = async () => {
    ++savedShotNotifications;
    return { status: 200 };
  };
  context.initializeRecentShotMetadata = async (id, value) => ({
    id, state: 'active', value, crc: 12, etag: 'initialized-etag',
    needsResult: true,
  });
  await context.api.setLastShotMetadataId(12, {
    coffee: { name: 'Attached coffee' }, prep: { grind: '21' },
  });
  check(context.api.lastMetadata().value.prep.grind === '21' &&
        savedShotNotifications === 1,
    'successful recent-shot initialization was not published');

  context.initializeRecentShotMetadata = async () => null;
  context.fetchShotMetadata = async id => ({
    id, state: 'active', value: { notes: 'Already written' },
    crc: 13, etag: 'existing-etag',
  });
  await context.api.setLastShotMetadataId(13,
    { coffee: { name: 'Losing first writer' } });
  check(context.api.lastMetadata().value.notes === 'Already written',
    'an expected initialization no-op did not load the stored metadata');

  context.initializeRecentShotMetadata = async () => {
    throw new Error('temporary failure');
  };
  context.fetchShotMetadata = async id => ({
    id, state: 'absent', value: null, crc: 0, etag: 'absent-etag',
  });
  context.flashBanner = (message, kind) => banners.push({ message, kind });
  await context.api.setLastShotMetadataId(14,
    { coffee: { name: 'Failed coffee' } });
  check(context.api.lastMetadata().state === 'absent' &&
        banners.some(entry => entry.message.includes('temporary failure')),
    'initialization failure did not leave manual editing available');
  context.api.historyStore.shotSaved = realShotSaved;

  const initialHistoryRequests = [];
  context.fetchShotsPage = (_before, signal) => new Promise((resolve, reject) => {
    initialHistoryRequests.push({ resolve, signal });
    signal.addEventListener('abort', () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
  context.api.chooseCoffee({ name: 'Halo Beriti' });
  const savedDuringInitialLoad = context.api.historyStore.shotSaved();
  check(initialHistoryRequests.length === 1 &&
        !initialHistoryRequests[0].signal.aborted,
    'a saved shot cancelled the initial history request');
  initialHistoryRequests[0].resolve(historyPage([{ id: 8 }], {
    hasMore: true, total: 100,
  }));
  await new Promise(resolve => setImmediate(resolve));
  check(initialHistoryRequests.length === 2,
    'a saved shot was not refreshed after the initial history request');
  initialHistoryRequests[1].resolve(historyPage([{ id: 8 }], {
    hasMore: true, total: 100,
  }));
  await savedDuringInitialLoad;
  await new Promise(resolve => setImmediate(resolve));
  const history = context.api.historyState();
  check(history.rows.length === 1 && history.rows[0].id === 8 &&
        !history.coffeeHistoryLoading && history.coffeeHistoryError === null,
  'choosing a coffee did not load history after browser reload');

  const historyRequests = [];
  context.fetchShotsPage = (_before, signal) => new Promise((resolve, reject) => {
    const request = { resolve, signal };
    historyRequests.push(request);
    signal.addEventListener('abort', () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
  const firstHistoryRequest = context.api.historyStore.refresh();
  context.api.historyStore.sessionStarted();
  const newerHistoryRequest =
    context.api.historyStore.observeDeviceState('ready');
  check(historyRequests.length === 2 && historyRequests[0].signal.aborted,
    'a newer history request did not cancel the previous request');
  historyRequests[1].resolve(historyPage([{ id: 9 }]));
  const [cancelled, completed] = await Promise.all(
    [firstHistoryRequest, newerHistoryRequest]);
  check(cancelled.status === 'cancelled' && completed.status === 200,
    'history cancellation did not remain distinct from completion');
  check(context.api.historyState().rows[0].id === 9,
    'the newest history request did not publish its page');

  const lateResponses = [];
  context.fetchShotsPage = () => new Promise(resolve => lateResponses.push(resolve));
  const lateRequest = context.api.historyStore.refresh();
  context.api.historyStore.sessionStarted();
  const winningRequest = context.api.historyStore.observeDeviceState('ready');
  lateResponses[1](historyPage([{ id: 10 }]));
  await winningRequest;
  lateResponses[0](historyPage([{ id: 1 }]));
  check((await lateRequest).status === 'cancelled' &&
        context.api.historyState().rows[0].id === 10,
    'a late response from an aborted history request replaced newer rows');

  let historyNotifications = 0;
  const unsubscribe = context.api.historyStore.subscribe(
    () => { ++historyNotifications; });
  context.api.historyStore.metadataChanged({
    id: 10, state: 'active', value: { rating: 5 }, crc: 7, etag: 'meta-10',
  });
  check(historyNotifications === 1 &&
        context.api.historyState().rows[0].userMetadata.rating === 5,
    'a metadata event did not update and notify history consumers');
  context.fetchShotsPage = async () => historyPage([
    { id: 11, yieldCg: 3900 },
  ]);
  await context.api.historyStore.shotSaved();
  check(context.api.historyState().rows[0].id === 11 &&
        historyNotifications > 1,
    'a saved-shot event did not refresh loaded history');
  unsubscribe();

  context.fetchShotsPage = async before => before
    ? historyPage([{ id: 12 }, { id: 11, yieldCg: 3900 }], { total: 4 })
    : historyPage([{ id: 14 }, { id: 13 }], { hasMore: true, total: 4 });
  await context.api.historyStore.refresh();
  await context.api.historyStore.loadMore();
  context.fetchShotsPage = async () => historyPage(
    [{ id: 15 }, { id: 14 }], { hasMore: true, total: 5 });
  await context.api.historyStore.shotSaved();
  check(context.api.historyState().rows.map(row => row.id).join(',') ===
        '15,14,13,12,11',
    'a saved-shot refresh discarded history pages already loaded by the user');

  context.fetchShotsPage = async () => historyPage(
    [{ id: 16 }, { id: 15 }], { hasMore: true, total: 6 });
  await context.api.historyStore.refreshPreservingRows();
  check(context.api.historyState().rows.map(row => row.id).join(',') ===
        '16,15,14,13,12,11',
    'view-entry refresh discarded history pages loaded by the coffee view');

  context.api.historyStore.metadataChanged({
    id: 11,
    state: 'active',
    value: {
      coffee: {
        name: 'Prior coffee', roaster: 'Prior roaster',
        origin: 'Ethiopia', roastDate: '2026-08-12', variety: '74110',
        futureCoffeeField: { retained: true },
      },
      prep: {
        grinder: 'Niche Zero', grind: '18.5', doseG: 18, tempC: 93,
        pressure: '9 bar', water: 'Lotus Light & Bright',
      },
    },
    crc: 8,
    etag: 'meta-11',
  });
  context.api.historyStore.metadataChanged({
    id: 12,
    state: 'active',
    value: { coffee: { name: 'Second coffee', roaster: 'Other roaster' } },
    crc: 9,
    etag: 'meta-12',
  });
  context.api.setCoffeePicker({
    onChoose: null, newCoffee: { name: '', roaster: '' },
  });
  const loadedPickerNodes = descendants(context.api.renderCoffeePicker());
  const coffeeChoices = loadedPickerNodes.filter(
    node => node.attrs && node.attrs.class === 'coffee-choice');
  const initiallyFocusedChoices = coffeeChoices.filter(node =>
    node.attrs['data-overlay-initial-focus'] === 'true');
  const loadedPickerCoffee = loadedPickerNodes.find(
    node => node.attrs && node.attrs.name === 'name');
  check(coffeeChoices.length === 2 && initiallyFocusedChoices.length === 1 &&
        initiallyFocusedChoices[0] === coffeeChoices[0] &&
        !loadedPickerCoffee.attrs['data-overlay-initial-focus'],
    'a coffee picker with saved choices focused its new-coffee form');
  context.api.setCoffeePicker(null);
  context.api.setNextRecipe({ coffee: { name: 'Existing template' } });
  context.api.openNextShotEditor();
  context.api.openEditorCoffeePicker(form);
  context.api.chooseCoffee({ name: 'Prior coffee', roaster: 'Prior roaster' });
  check(context.api.editor().original.coffee.origin === 'Ethiopia' &&
        context.api.editor().original.coffee.roastDate === '2026-08-12' &&
        context.api.editor().original.coffee.futureCoffeeField.retained &&
        context.api.editor().original.prep.grind === '18.5' &&
        context.api.editor().recipeSourceId === 11 &&
        context.api.browserState().nextShotRecipe.coffee.name ===
          'Existing template',
    'choosing from history did not replace only the open recipe editor');

  context.api.setEditor({
    kind: 'shot', id: 22, record: { id: 22, etag: 'meta-22' },
    original: { coffee: { name: 'Unknown' }, prep: { grind: '20' } },
    rating: 4, tags: ['dial-in'], saving: false, error: null, conflict: null,
  });
  const savedShotForm = { elements: {
    ...form.elements,
    'prep.grinder': element(''),
    'prep.grind': element('20'),
    'prep.doseG': element(''),
    'prep.tempC': element(''),
    'prep.pressure': element(''),
    'prep.water': element(''),
    notes: element('Saved shot note'),
  } };
  context.api.openEditorCoffeePicker(savedShotForm);
  context.api.chooseCoffee({ name: 'Prior coffee', roaster: 'Prior roaster' });
  check(context.api.editor().original.coffee.origin === 'Ethiopia' &&
        context.api.editor().original.prep.grinder === 'Niche Zero' &&
        context.api.editor().original.prep.grind === '20' &&
        context.api.editor().original.prep.doseG === 18 &&
        context.api.editor().original.prep.tempC === 93 &&
        context.api.editor().original.prep.pressure === '9 bar' &&
        context.api.editor().original.prep.water === 'Lotus Light & Bright' &&
        context.api.editor().original.notes === 'Saved shot note' &&
        context.api.editor().original.rating === 4,
    'saved-shot coffee selection did not fill blanks or preserve entered fields');

  context.api.historyStore.sessionStarted();
  context.api.chooseCoffee({ name: 'Prior coffee', roaster: 'Prior roaster' });
  check(context.api.browserState().nextShotRecipeSourceId === null &&
        context.api.browserState().nextShotRecipe.coffee.origin === 'Ethiopia',
    'cached history attributed a recipe to an unvalidated shot identity');

  context.lastRecord = null;
  context.selectedShotId = null;
  context.selectedShot = null;
  context.api.setEditor({ kind: 'shot', id: 11 });
  check(context.api.metadataEditorShot().yieldCg === 3900,
    'a history-row editor could not use the row measurement summary');

  await context.api.loadCoffeeContextHistory();
  const oldHead = Array.from({ length: 20 }, (_, index) => ({ id: 100 - index }));
  const detachedHead = Array.from(
    { length: 20 }, (_, index) => ({ id: 125 - index }));
  context.fetchShotsPage = async () => historyPage(oldHead, {
    hasMore: true, total: 100,
  });
  await context.api.historyStore.refresh();
  const historyListNodes = () => {
    const app = context.el('main');
    context.api.renderList(app);
    return descendants(app);
  };
  context.state = { storage: 'ready', active: false, phase: 'IDLE' };
  for (const before of [0, 81]) {
    let completeObsoletePage;
    let obsoletePageSignal;
    context.fetchShotsPage = (_before, signal) => new Promise((resolve, reject) => {
      completeObsoletePage = resolve;
      obsoletePageSignal = signal;
      signal.addEventListener('abort', () => {
        const err = new Error('cancelled');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });
    const obsoleteResponse = historyPage([{ id: before ? 80 : 200 }], {
      hasMore: true, total: 200, etag: 'obsolete-page',
    });
    const previousValidator = context.api.historyStore.etagFor(obsoleteResponse.url);
    const obsoletePage = before
      ? context.api.historyStore.loadMore() : context.api.historyStore.refresh();
    // Fulfillment queues the commit. Invalidation in the same task aborts a
    // promise that has already settled, so the commit must check its generation.
    completeObsoletePage(obsoleteResponse);
    context.api.historyStore.sessionStarted();
    const obsoleteResult = await obsoletePage;
    check(obsoleteResult.status === 'cancelled' && obsoletePageSignal.aborted &&
          context.api.historyStore.rows.map(row => row.id).join(',') ===
            oldHead.map(row => row.id).join(',') &&
          context.api.historyStore.total === 100 &&
          context.api.historyStore.hasMore && !context.api.historyStore.rowsAreCurrent &&
          context.api.historyStore.etagFor(obsoleteResponse.url) === previousValidator,
      'a fulfilled old-generation page committed rows or validators before cancellation');
    context.fetchShotsPage = async () => historyPage(oldHead, {
      hasMore: true, total: 100,
    });
    await context.api.historyStore.refresh();
  }

  let historyButtonRequests = 0;
  let rejectHistoryButtonPage;
  context.fetchShotsPage = () => new Promise((_resolve, reject) => {
    ++historyButtonRequests;
    rejectHistoryButtonPage = reject;
  });
  const historyOlderButton = historyListNodes().find(node =>
    node.tag === 'button' && node.children.includes('Load older'));
  const historyButtonBannerCount = banners.length;
  const historyButtonRequest = historyOlderButton.attrs.onclick();
  const repeatedHistoryButtonRequest = historyOlderButton.attrs.onclick();
  const busyHistoryButton = historyListNodes().find(node =>
    node.tag === 'button' && node.children.includes('Loading…'));
  check(busyHistoryButton && busyHistoryButton.attrs['aria-disabled'] === 'true',
    'History did not expose its in-flight pagination state');
  const busyHistoryButtonRequest = busyHistoryButton.attrs.onclick();
  rejectHistoryButtonPage(new Error('history pagination unavailable'));
  await Promise.all([
    historyButtonRequest, repeatedHistoryButtonRequest, busyHistoryButtonRequest,
  ]);
  check(historyButtonRequests === 1 &&
        banners.length === historyButtonBannerCount + 1 &&
        banners[banners.length - 1].message.includes('history pagination unavailable') &&
        historyListNodes().some(node =>
          node.tag === 'button' && node.children.includes('Load older')),
    'repeated History activation duplicated a request or its failure feedback');

  context.fetchShotsPage = async () => historyPage([], { hasMore: true, total: 1 });
  await context.api.historyStore.refresh();
  const cursorlessPagination = await context.api.historyStore.loadMore();
  check(context.api.historyStore.pagination.status === 'complete' &&
        cursorlessPagination.status === 'ready',
    'pagination advertised a ready action without a row cursor');
  context.fetchShotsPage = async () => historyPage(oldHead, {
    hasMore: true, total: 100,
  });
  await context.api.historyStore.refresh();
  context.api.setCoffeePicker({
    onChoose: null, newCoffee: { name: '', roaster: '' },
  });
  let olderHistoryPickerNodes = descendants(context.api.renderCoffeePicker());
  const olderHistoryPicker = JSON.stringify(olderHistoryPickerNodes);
  check(olderHistoryPicker.includes('No coffees found in loaded history.') &&
        olderHistoryPicker.includes('Search older history'),
    'the coffee picker could not search older history for prior coffees');
  let finishOlderHistory;
  let olderHistoryFetches = 0;
  context.fetchShotsPage = () => new Promise(resolve => {
    ++olderHistoryFetches;
    finishOlderHistory = resolve;
  });
  let olderHistoryButton = olderHistoryPickerNodes.find(node =>
    node.attrs && node.attrs['data-overlay-focus-key'] ===
      'coffee-picker-load-more');
  const olderHistoryRequest = olderHistoryButton.attrs.onclick();
  const joinedOlderHistoryRequest = olderHistoryButton.attrs.onclick();
  olderHistoryPickerNodes = descendants(context.api.renderCoffeePicker());
  const loadingOlderButton = olderHistoryPickerNodes.find(node =>
    node.attrs && node.attrs['data-overlay-focus-key'] ===
      'coffee-picker-load-more');
  check(loadingOlderButton.attrs['aria-disabled'] === 'true' &&
        loadingOlderButton.children.includes('Loading…') &&
        olderHistoryFetches === 1,
    'older-coffee search gave no in-flight feedback');
  finishOlderHistory(historyPage([{ id: 80 }], { hasMore: true, total: 100 }));
  await Promise.all([olderHistoryRequest, joinedOlderHistoryRequest]);

  context.fetchShotsPage = async () => {
    throw new Error('older history unavailable');
  };
  olderHistoryPickerNodes = descendants(context.api.renderCoffeePicker());
  olderHistoryButton = olderHistoryPickerNodes.find(node =>
    node.attrs && node.attrs['data-overlay-focus-key'] ===
      'coffee-picker-load-more');
  const bannerCountBeforeOlderFailure = banners.length;
  await olderHistoryButton.attrs.onclick();
  const failedOlderHistoryPicker = JSON.stringify(
    descendants(context.api.renderCoffeePicker()));
  check(banners.length === bannerCountBeforeOlderFailure &&
        failedOlderHistoryPicker.includes('Could not load older history') &&
        failedOlderHistoryPicker.includes('Search older history') &&
        !failedOlderHistoryPicker.includes('Retry older history'),
    'an older-coffee search failure was only reported behind the dialog');
  context.api.setNextRecipe({ coffee: { name: 'No matching saved coffee' } });
  const backgroundCoffeeAfterFailure = context.el('main');
  context.api.renderCoffeeContext(backgroundCoffeeAfterFailure);
  check(!JSON.stringify(backgroundCoffeeAfterFailure)
    .includes('Could not load older history') &&
    JSON.stringify(context.api.renderCoffeePicker()).includes('Could not load older history'),
  'Live adopted the open coffee dialog\'s pagination feedback');

  context.fetchShotsPage = () => new Promise(resolve => {
    finishOlderHistory = resolve;
  });
  olderHistoryPickerNodes = descendants(context.api.renderCoffeePicker());
  olderHistoryButton = olderHistoryPickerNodes.find(node =>
    node.attrs && node.attrs['data-overlay-focus-key'] ===
      'coffee-picker-load-more');
  const repeatedOlderSearch = olderHistoryButton.attrs.onclick();
  check(!JSON.stringify(descendants(context.api.renderCoffeePicker()))
    .includes('Could not load older history'),
  'starting another search retained the previous dialog error');
  finishOlderHistory(historyPage([{ id: 79 }], { hasMore: true, total: 100 }));
  await repeatedOlderSearch;
  const retriedOlderHistoryPicker = JSON.stringify(
    descendants(context.api.renderCoffeePicker()));
  check(retriedOlderHistoryPicker.includes('Search older history'),
    'retrying older coffee history did not leave pagination usable');
  context.api.setCoffeePicker(null);

  context.api.setEditor(null);
  context.api.setNextRecipe({ coffee: { name: 'Comparison coffee' } });
  context.api.setCoffeeComparisonOpen(true);
  context.fetchShotsPage = async () => {
    throw new Error('comparison history unavailable');
  };
  let comparisonNodes = descendants(context.api.renderCoffeeComparison());
  let comparisonSearch = comparisonNodes.find(node =>
    node.attrs && node.attrs['data-overlay-focus-key'] === 'comparison-load-more');
  await comparisonSearch.attrs.onclick();
  comparisonNodes = descendants(context.api.renderCoffeeComparison());
  check(comparisonNodes.some(node => node.attrs && node.attrs.role === 'status' &&
          node.children.some(text => String(text).includes('Could not load older history'))) &&
        context.api.historyStore.error === null,
    'comparison pagination failure was not visible inside its dialog');

  // Exercise the close renderer so feedback cannot outlive this dialog, even
  // when the next comparison uses the same coffee object.
  const closedOverlay = {
    firstElementChild: null, dataset: { modalKeyboard: 'true' },
    replaceChildren() {},
  };
  context.document = {
    activeElement: null,
    getElementById: () => closedOverlay,
    querySelectorAll: () => [],
  };
  context.renderMetadataOverlay = context.api.renderMetadataOverlay;
  context.api.closeActiveMetadataOverlay();
  context.renderMetadataOverlay = () => {};
  context.api.setCoffeeComparisonOpen(true);
  comparisonNodes = descendants(context.api.renderCoffeeComparison());
  check(!JSON.stringify(comparisonNodes).includes('Could not load older history'),
    'reopening the comparison restored its previous search failure');

  let rejectAbandonedSearch;
  context.fetchShotsPage = () => new Promise((_resolve, reject) => {
    rejectAbandonedSearch = reject;
  });
  comparisonSearch = comparisonNodes.find(node =>
    node.attrs && node.attrs['data-overlay-focus-key'] === 'comparison-load-more');
  const abandonedSearch = comparisonSearch.attrs.onclick();
  context.renderMetadataOverlay = context.api.renderMetadataOverlay;
  context.api.closeActiveMetadataOverlay();
  context.renderMetadataOverlay = () => {};
  context.api.setCoffeeComparisonOpen(true);
  context.api.renderCoffeeComparison();
  rejectAbandonedSearch(new Error('abandoned comparison request'));
  await abandonedSearch;
  check(!JSON.stringify(context.api.renderCoffeeComparison())
    .includes('Could not load older history'),
  'a closed comparison published a late error into the reopened dialog');
  context.api.setCoffeeComparisonOpen(false);
  context.fetchShotsPage = async () => historyPage(detachedHead, {
    hasMore: true, total: 125,
  });
  await context.api.historyStore.shotSaved();
  check(context.api.historyState().rows.map(row => row.id).join(',') ===
        detachedHead.map(row => row.id).join(','),
    'a background refresh retained a disconnected range of cached history');

  const previousLifetime = Array.from(
    { length: 20 }, (_, index) => ({ id: 60 - index }));
  context.fetchShotsPage = async () => historyPage(previousLifetime, {
    hasMore: true, total: 60,
  });
  await context.api.historyStore.refresh();
  context.fetchShotsPage = async () => historyPage(
    [{ id: 3 }, { id: 2 }, { id: 1 }], { total: 3 });
  await context.api.historyStore.shotSaved();
  check(context.api.historyState().rows.map(row => row.id).join(',') ===
        '3,2,1',
    'a restarted shot-id range retained rows from the previous lifetime');

  context.fetchShotsPage = async () => historyPage(detachedHead, {
    hasMore: true, total: 125,
  });
  await context.api.historyStore.refresh();

  const paginationRequests = [];
  context.fetchShotsPage = (_before, signal) => new Promise((resolve, reject) => {
    paginationRequests.push({ resolve, signal });
    signal.addEventListener('abort', () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
  const pagination = context.api.historyStore.loadMore();
  const savedDuringPagination = context.api.historyStore.shotSaved();
  check(paginationRequests.length === 1 &&
        !paginationRequests[0].signal.aborted,
    'a background refresh interrupted foreground history pagination');
  paginationRequests[0].resolve(historyPage([{ id: 105 }], {
    hasMore: true, total: 125,
  }));
  await pagination;
  await new Promise(resolve => setImmediate(resolve));
  check(paginationRequests.length === 2,
    'history was not refreshed after foreground pagination completed');
  paginationRequests[1].resolve(historyPage(detachedHead, {
    hasMore: true, total: 125,
  }));
  await savedDuringPagination;
  check(context.api.historyState().rows.some(row => row.id === 105),
    'the refresh following pagination discarded the newly loaded page');

  context.fetchShotsPage = async () => historyPage(
    [{ id: 20 }, { id: 19 }], { hasMore: true, total: 100 });
  await context.api.historyStore.refresh();
  const paginationAfterRefreshRequests = [];
  context.fetchShotsPage = (before, signal) => new Promise((resolve, reject) => {
    paginationAfterRefreshRequests.push({ before, resolve, signal });
    signal.addEventListener('abort', () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
  const refreshBeforePagination = context.api.historyStore.shotSaved();
  const paginationAfterRefresh = context.api.historyStore.loadMore();
  check(paginationAfterRefreshRequests.length === 1 &&
        paginationAfterRefreshRequests[0].before === 0 &&
        !paginationAfterRefreshRequests[0].signal.aborted,
    'pagination cancelled a saved-shot page-one refresh');
  paginationAfterRefreshRequests[0].resolve(historyPage(
    [{ id: 21 }, { id: 20 }], { hasMore: true, total: 101 }));
  await refreshBeforePagination;
  await new Promise(resolve => setImmediate(resolve));
  check(paginationAfterRefreshRequests.length === 2 &&
        paginationAfterRefreshRequests[1].before === 19,
    'pagination did not recompute its cursor after page one refreshed');
  paginationAfterRefreshRequests[1].resolve(historyPage(
    [{ id: 18 }], { hasMore: true, total: 101 }));
  await paginationAfterRefresh;
  check(context.api.historyState().rows.map(row => row.id).join(',') ===
        '21,20,19,18',
    'pagination lost the saved shot after waiting for its refresh');

  const failedPrerequisiteRequests = [];
  context.fetchShotsPage = (before, signal) =>
    new Promise((resolve, reject) => {
      failedPrerequisiteRequests.push({ before, resolve, reject, signal });
      signal.addEventListener('abort', () => {
        const err = new Error('cancelled');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });
  const failedRefreshBeforePagination = context.api.historyStore.shotSaved();
  const bannerCountBeforeFailedPagination = banners.length;
  const failedPaginationAfterRefresh = context.api.loadMoreHistory();
  check(failedPrerequisiteRequests.length === 1 &&
        failedPrerequisiteRequests[0].before === 0,
    'pagination did not wait for its page-one refresh prerequisite');
  failedPrerequisiteRequests[0].reject(
    new Error('page-one refresh unavailable'));
  const [failedRefreshResult, failedPaginationResult] = await Promise.all([
    failedRefreshBeforePagination, failedPaginationAfterRefresh,
  ]);
  check(failedRefreshResult.status === 'error' &&
        failedPaginationResult.status === 'error' &&
        context.api.historyStore.pagination.status === 'ready' &&
        banners.length === bannerCountBeforeFailedPagination + 1 &&
        banners.at(-1).message.includes('Could not load older history'),
    'a failed pagination prerequisite was not reported to its initiator');
  context.api.setCoffeePicker({
    onChoose: null, newCoffee: { name: '', roaster: '' },
  });
  let failedPrerequisitePickerNodes = descendants(
    context.api.renderCoffeePicker());
  const failedPrerequisitePicker = JSON.stringify(failedPrerequisitePickerNodes);
  check(failedPrerequisitePicker.includes('Retry history') &&
        failedPrerequisitePicker.includes('Shot history could not be refreshed.') &&
        !failedPrerequisitePicker.includes('Retry older history'),
    'a failed page-one prerequisite left no manual history recovery');

  const retriedPrerequisiteRequests = [];
  context.fetchShotsPage = (before, signal) =>
    new Promise((resolve, reject) => {
      retriedPrerequisiteRequests.push({ before, resolve, reject, signal });
      signal.addEventListener('abort', () => {
        const err = new Error('cancelled');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });
  const retryPaginationButton = failedPrerequisitePickerNodes.find(node =>
    node.attrs && node.attrs['data-overlay-focus-key'] ===
      'coffee-picker-load-more');
  const retriedRefresh = retryPaginationButton.attrs.onclick();
  check(retriedPrerequisiteRequests.length === 1 &&
        retriedPrerequisiteRequests[0].before === 0,
    'pagination retry skipped its failed page-one prerequisite');
  retriedPrerequisiteRequests[0].resolve(historyPage(
    [{ id: 22 }, { id: 21 }], { hasMore: true, total: 102 }));
  await retriedRefresh;
  const recoveredSearchButton = descendants(context.api.renderCoffeePicker())
    .find(node => node.attrs && node.attrs['data-overlay-focus-key'] ===
      'coffee-picker-load-more');
  const retriedPaginationAfterRefresh = recoveredSearchButton.attrs.onclick();
  check(retriedPrerequisiteRequests.length === 2 &&
        retriedPrerequisiteRequests[1].before === 18,
    'pagination retry did not continue to the requested older page');
  retriedPrerequisiteRequests[1].resolve(historyPage(
    [{ id: 17 }], { hasMore: true, total: 102 }));
  await retriedPaginationAfterRefresh;
  check(context.api.historyStore.pagination.status === 'ready' &&
        context.api.historyState().rows.map(row => row.id).join(',') ===
          '22,21,20,19,18,17',
    'successful pagination retry did not clear its prerequisite failure');
  context.api.setCoffeePicker(null);

  context.fetchShotsPage = async () => {
    throw new Error('old-session pagination failure');
  };
  context.api.setCoffeePicker({
    onChoose: null, newCoffee: { name: '', roaster: '' },
  });
  const oldSessionBannerCount = banners.length;
  const oldSessionSearch = descendants(context.api.renderCoffeePicker()).find(node =>
    node.attrs && node.attrs['data-overlay-focus-key'] === 'coffee-picker-load-more');
  const oldSessionPagination = await oldSessionSearch.attrs.onclick();
  check(oldSessionPagination.status === 'error' &&
        context.api.historyStore.pagination.status === 'ready' &&
        context.api.historyState().coffeeHistoryError === null &&
        JSON.stringify(context.api.renderCoffeePicker()).includes(
          'Could not load older history') &&
        banners.length === oldSessionBannerCount,
    'an older-page failure escaped its initiating action');
  let invalidationNotifications = 0;
  let invalidatedPicker;
  const unsubscribeInvalidation = context.api.historyStore.subscribe(
    () => {
      ++invalidationNotifications;
      invalidatedPicker = JSON.stringify(context.api.renderCoffeePicker());
    });
  context.api.historyStore.sessionStarted();
  check(context.api.historyStore.pagination.status === 'deferred' &&
        context.api.historyState().coffeeHistoryError === null &&
        invalidationNotifications === 1 &&
        !invalidatedPicker.includes('Could not load older history'),
    'session invalidation did not publish its reset pagination state');
  unsubscribeInvalidation();
  let deferredRevalidationRequests = 0;
  context.fetchShotsPage = async () => {
    ++deferredRevalidationRequests;
    throw new Error('must remain deferred during the pump window');
  };
  await context.api.historyStore.observeDeviceState('ready', false, false);
  context.api.setCoffeePicker({
    onChoose: null, newCoffee: { name: '', roaster: '' },
  });
  const deferredRevalidationPicker = JSON.stringify(
    descendants(context.api.renderCoffeePicker()));
  check(deferredRevalidationRequests === 0 &&
        !deferredRevalidationPicker.includes(
          'Shot history could not be refreshed.') &&
        !deferredRevalidationPicker.includes('Retry history'),
    'deferred revalidation exposed an obsolete pagination retry');
  const deferredHistoryNodes = historyListNodes();
  await historyOlderButton.attrs.onclick();
  check(!deferredHistoryNodes.some(node =>
          node.tag === 'button' && node.children.includes('Load older')) &&
        deferredRevalidationRequests === 0,
    'History exposed an active pagination control while revalidation was deferred');
  context.api.setNextRecipe({ coffee: { name: 'Recovery coffee' } });
  context.api.historyStore.metadataChanged({
    id: 22, state: 'active', value: { coffee: { name: 'Recovery coffee' } },
  });
  context.state = { storage: 'ready', active: false, phase: 'IDLE' };
  context.fmtDate = () => '';
  let recoveryPickerNodes;
  let recoveryHistory;
  let recoveryCoffee;
  const unsubscribeIdleRecovery = context.api.historyStore.subscribe(() => {
    recoveryPickerNodes = descendants(context.api.renderCoffeePicker());
    recoveryHistory = context.el('main');
    context.api.renderList(recoveryHistory);
    recoveryCoffee = context.el('main');
    context.api.renderCoffeeContext(recoveryCoffee);
  });
  context.fetchShotsPage = async () => {
    throw new Error('revalidation unavailable');
  };
  const failedRevalidation =
    await context.api.historyStore.observeDeviceState('ready', false, true);
  check(failedRevalidation.status === 'error' &&
        !context.api.historyStore.rowsAreCurrent &&
        context.api.historyStore.pagination.status === 'deferred',
    'failed session revalidation did not leave history deferred');
  const failedRevalidationPicker = JSON.stringify(recoveryPickerNodes);
  check(failedRevalidationPicker.includes('Retry history') &&
        failedRevalidationPicker.includes('Shot history could not be refreshed.') &&
        JSON.stringify(recoveryHistory).includes('Retry') &&
        JSON.stringify(recoveryCoffee).includes('Retry history') &&
        JSON.stringify(recoveryCoffee).includes('Shot #22') &&
        !failedRevalidationPicker.includes('Retry older history'),
    'subscribers did not expose manual recovery from failed idle revalidation');
  let revalidationRetries = 0;
  context.fetchShotsPage = async before => {
    check(before === 0, 'history recovery retried an older-page cursor');
    ++revalidationRetries;
    return historyPage([{ id: 23 }, { id: 22 }], { hasMore: true, total: 103 });
  };
  const revalidationButton = recoveryPickerNodes.find(node =>
    node.tag === 'button' && node.children.includes('Retry history'));
  await revalidationButton.attrs.onclick();
  check(context.api.historyStore.pagination.status === 'ready' &&
        revalidationRetries === 1 &&
        context.api.historyState().rows.map(row => row.id).join(',') ===
          '23,22' &&
        !JSON.stringify(recoveryPickerNodes).includes(
          'Shot history could not be refreshed.'),
    'manual history retry required another device event to recover');
  unsubscribeIdleRecovery();
  context.api.setCoffeePicker(null);

  const queuedPaginationRequests = [];
  context.fetchShotsPage = (before, signal) =>
    new Promise((resolve, reject) => {
      queuedPaginationRequests.push({ before, resolve, reject, signal });
      signal.addEventListener('abort', () => {
        const err = new Error('cancelled');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });
  const pageOneBeforeReconnect =
    context.api.historyStore.refreshPreservingRows();
  const paginationBeforeReconnect = context.api.historyStore.loadMore();
  check(queuedPaginationRequests.length === 1 &&
        queuedPaginationRequests[0].before === 0,
    'pagination did not wait for the active page-one request');
  context.api.historyStore.sessionStarted();
  const [cancelledPageOne, cancelledPagination] = await Promise.all([
    pageOneBeforeReconnect, paginationBeforeReconnect,
  ]);
  check(cancelledPageOne.status === 'cancelled' &&
        cancelledPagination.status === 'cancelled' &&
        queuedPaginationRequests.length === 1 &&
        context.api.historyStore.pagination.status === 'deferred',
    'pagination continued across a history-generation change');

  const paginationBeforeValidationRequests = [];
  context.fetchShotsPage = (before, signal) => new Promise((resolve, reject) => {
    paginationBeforeValidationRequests.push({ before, resolve, signal });
    signal.addEventListener('abort', () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
  const deferredPagination = await context.api.historyStore.loadMore();
  check(deferredPagination.status === 'deferred' &&
        paginationBeforeValidationRequests.length === 0,
    'pagination started before validating a new device session');
  const validationBeforePagination =
    context.api.historyStore.observeDeviceState('ready');
  check(paginationBeforeValidationRequests.length === 1 &&
        paginationBeforeValidationRequests[0].before === 0,
    'device-state recovery did not revalidate history independently');
  paginationBeforeValidationRequests[0].resolve(historyPage(
    [{ id: 1 }], { total: 1, etag: 'validated-before-pagination' }));
  await validationBeforePagination;
  check(paginationBeforeValidationRequests.length === 1 &&
        context.api.historyState().rows.map(row => row.id).join(',') === '1',
    'pagination retained rows from an unvalidated device session');
  check(!historyListNodes().some(node =>
          node.tag === 'button' && node.children.includes('Load older')) &&
        context.api.historyStore.pagination.status === 'complete',
    'History offered pagination after all shots were loaded');

  context.fetchShotsPage = async () => historyPage(
    [{ id: 1, startUtcSec: 999 }], { etag: 'opaque-validator' });
  context.api.historyStore.sessionStarted();
  await context.api.historyStore.observeDeviceState('ready');
  check(context.api.historyState().rows.length === 1 &&
        context.api.historyState().rows[0].id === 1 &&
        context.api.historyState().rows[0].startUtcSec === 999,
    'session revalidation retained rows from the previous storage view');

  context.fetchShotsPage = async () => historyPage(
    [{ id: 250 }, { id: 249 }], { hasMore: true, total: 250 });
  await context.api.historyStore.refresh();
  const concurrentSessionRequests = [];
  context.fetchShotsPage = (_before, signal) => new Promise((resolve, reject) => {
    concurrentSessionRequests.push({ resolve, signal });
    signal.addEventListener('abort', () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
  context.api.historyStore.sessionStarted();
  const authoritativeReload =
    context.api.historyStore.observeDeviceState('ready');
  const saveRefresh = context.api.historyStore.shotSaved();
  check(concurrentSessionRequests.length === 1 &&
        !concurrentSessionRequests[0].signal.aborted,
    'a save refresh cancelled an authoritative history reload');
  concurrentSessionRequests[0].resolve(historyPage(
    [{ id: 1 }], { total: 1, etag: 'new-session' }));
  await new Promise(resolve => setImmediate(resolve));
  check(concurrentSessionRequests.length === 2,
    'a save refresh was lost while authoritative history reloaded');
  concurrentSessionRequests[1].resolve(historyPage(
    [{ id: 1 }], { total: 1, etag: 'new-session-after-save' }));
  await Promise.all([authoritativeReload, saveRefresh]);
  check(context.api.historyState().rows.map(row => row.id).join(',') === '1',
    'a save refresh merged rows from the previous storage session');

  context.fetchShotsPage = async () => historyPage(
    [{ id: 250 }, { id: 249 }], { hasMore: true, total: 250 });
  await context.api.historyStore.refresh();
  const paginationDuringReloadRequests = [];
  context.fetchShotsPage = (_before, signal) => new Promise((resolve, reject) => {
    paginationDuringReloadRequests.push({ resolve, signal });
    signal.addEventListener('abort', () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
  context.api.historyStore.sessionStarted();
  const reloadBeforePagination =
    context.api.historyStore.observeDeviceState('ready');
  const paginationDuringReload = context.api.historyStore.loadMore();
  check(paginationDuringReloadRequests.length === 1 &&
        !paginationDuringReloadRequests[0].signal.aborted,
    'pagination cancelled an authoritative history reload');
  paginationDuringReloadRequests[0].resolve(historyPage(
    [{ id: 1 }], { total: 1, etag: 'pagination-new-session' }));
  await Promise.all([reloadBeforePagination, paginationDuringReload]);
  check(paginationDuringReloadRequests.length === 1 &&
        context.api.historyState().rows.map(row => row.id).join(',') === '1',
    'pagination used a cursor from the previous storage session');

  let revalidationRequests = 0;
  context.fetchShotsPage = async () => {
    revalidationRequests++;
    return { status: 304 };
  };
  context.api.historyStore.sessionStarted();
  await context.api.historyStore.observeDeviceState('ready');
  check(revalidationRequests === 1,
    'cached history was not revalidated when a new device session began');

  let deferredBackgroundRequests = 0;
  context.fetchShotsPage = async () => {
    ++deferredBackgroundRequests;
    return { status: 304 };
  };
  context.api.historyStore.sessionStarted();
  await context.api.historyStore.observeDeviceState('ready', false, false);
  check(deferredBackgroundRequests === 0,
    'session revalidation started during a pump window');
  await context.api.historyStore.observeDeviceState('ready', false, true);
  check(deferredBackgroundRequests === 1,
    'deferred session revalidation did not run after the pump window');

  await context.api.historyStore.observeDeviceState('ready', true, false);
  check(deferredBackgroundRequests === 1,
    'saved-shot refresh started during a pump window');
  await context.api.historyStore.observeDeviceState('ready', false, true);
  check(deferredBackgroundRequests === 2,
    'deferred saved-shot refresh did not run after the pump window');

  context.api.historyStore.sessionStarted();
  await context.api.historyStore.observeDeviceState('ready', false, false);
  await context.api.historyStore.refresh();
  check(deferredBackgroundRequests === 3,
    'an explicit History refresh was blocked during a pump window');

  let recoveryRequests = 0;
  let recoveryNotifications = 0;
  const unsubscribeRecovery = context.api.historyStore.subscribe(
    () => { ++recoveryNotifications; });
  context.fetchShotsPage = async () => {
    ++recoveryRequests;
    return historyPage([{ id: 1 }], { total: 1 });
  };
  await context.api.historyStore.observeDeviceState('unavailable');
  const unavailableRefresh = await context.api.historyStore.refresh();
  check(unavailableRefresh.status === 'deferred' && recoveryRequests === 0,
    'history requested storage while it was unavailable');
  await context.api.historyStore.observeDeviceState('ready');
  unsubscribeRecovery();
  check(recoveryRequests === 1 && recoveryNotifications >= 2,
    'storage recovery did not reload history and notify its views');

  context.api.historyStore.metadataChanged({
    id: 1,
    state: 'active',
    value: { coffee: { name: 'Cached coffee' } },
    crc: 1,
    etag: 'cached-etag',
  });
  context.fetchBinary = async () => ({ status: 'ok', shot: { id: 'current' } });
  context.fetchShotMetadata = async id => ({
    id,
    state: 'active',
    value: { coffee: { name: 'Current coffee' } },
    crc: 2,
    etag: 'current-etag',
  });
  await context.api.selectShot(1);
  await new Promise(resolve => setImmediate(resolve));
  check(context.api.selected().shot.id === 'current' &&
        context.api.selected().metadata.value.coffee.name === 'Current coffee',
    'shot details combined a current record with cached row metadata');

  context.state = { storage: 'ready' };
  const damagedHistoryView = context.el('main');
  context.api.renderList(damagedHistoryView);
  const damagedHistoryText = JSON.stringify(damagedHistoryView);
  check(damagedHistoryText.includes('Record unavailable') &&
        damagedHistoryText.includes('Current coffee') &&
        damagedHistoryText.includes('Edit details'),
    'damaged extraction summary hid independently readable shot metadata');

  context.view = 'list';
  context.fetchShotsPage = async () => {
    throw new Error('history unavailable');
  };
  const failedSavedRefresh = await context.api.historyStore.shotSaved();
  const staleHistoryView = context.el('main');
  context.api.renderList(staleHistoryView);
  const staleHistoryText = JSON.stringify(staleHistoryView);
  check(failedSavedRefresh.status === 'error' &&
        staleHistoryText.includes('Shot history may be out of date.') &&
        staleHistoryText.includes('Retry'),
    'a background refresh failure left History without manual recovery');

  let retryBefore = null;
  context.fetchShotsPage = async before => {
    retryBefore = before;
    return historyPage([{ id: 1, startUtcSec: 999 }], { total: 1 });
  };
  const historyRetryButton = descendants(staleHistoryView).find(node =>
    node.tag === 'button' && node.children.includes('Retry'));
  const retriedHistoryRefresh = await historyRetryButton.attrs.onclick();
  check(retriedHistoryRefresh.status === 200 && retryBefore === 0 &&
        context.api.historyStore.error === null,
    'history retry did not repeat and clear the failed refresh');

  let finishAbandonedMetadataLoad;
  context.view = 'live';
  context.lastRecord = { shotId: 11 };
  context.fetchShotMetadata = () => new Promise(resolve => {
    finishAbandonedMetadataLoad = resolve;
  });
  const abandonedMetadataLoad = context.api.loadShotMetadata(11);
  context.api.openNextShotEditor();
  finishAbandonedMetadataLoad({
    id: 11, state: 'active', value: { coffee: { name: 'Saved' } },
    crc: 8, etag: 'meta-11',
  });
  await abandonedMetadataLoad;
  check(context.api.editor().kind === 'recipe',
    'an abandoned metadata load replaced the current editor');

  context.api.setNextRecipe({ coffee: { name: 'Existing recipe' } });
  const invalidNumericForm = { elements: {
    ...form.elements,
    'prep.doseG': element('1e999'),
  } };
  context.api.setEditor({
    kind: 'recipe', original: { coffee: { name: 'Existing recipe' } },
    rating: 0, tags: [], saving: false, error: null,
  });
  await context.api.saveMetadataEditor(invalidNumericForm);
  check(context.api.editor().error &&
        context.api.browserState().nextShotRecipe.coffee.name ===
          'Existing recipe',
    'a non-finite numeric value was serialized into shot metadata');

  const oversizedRecipeForm = { elements: {
    ...form.elements,
    'coffee.name': element('x'.repeat(context.api.maxBytes + 1)),
  } };
  context.api.setEditor({
    kind: 'recipe',
    original: { coffee: { name: 'Existing recipe' } },
    rating: 0, tags: [], saving: false, error: null,
  });
  await context.api.saveMetadataEditor(oversizedRecipeForm);
  check(context.api.editor().kind === 'recipe' &&
        context.api.editor().original.coffee.name.length > context.api.maxBytes &&
        context.api.editor().error &&
        context.api.browserState().nextShotRecipe.coffee.name ===
          'Existing recipe',
    'over-limit recipe replaced the valid template or discarded its edits');

  const overLimitForm = { elements: {
    ...form.elements,
    notes: element('x'.repeat(context.api.maxBytes + 1)),
  } };
  context.api.setEditor({
    kind: 'shot', id: 8,
    record: { id: 8, state: 'active', etag: 'etag-8' },
    original: { coffee: { name: 'Before' } },
    rating: 4, tags: [], saving: false, error: null,
  });
  await context.api.saveMetadataEditor(overLimitForm);
  check(context.api.editor().original.notes.length > context.api.maxBytes &&
        context.api.editor().error,
    'over-limit validation discarded the current editor values');

  const conflictForm = { elements: {
    ...form.elements,
    'coffee.name': element('Edited after conflict'),
  } };
  context.api.setEditor({
    kind: 'shot', id: 8,
    record: { id: 8, state: 'active', etag: 'old-etag' },
    original: { coffee: { name: 'Before' } },
    rating: 4, tags: [], saving: false, error: null,
  });
  context.fetchWithTimeout = async (_path, _options, consume) =>
    consume({ status: 412, ok: false, headers: { get: () => null } });
  context.fetchShotMetadata = async id => ({
    id, state: 'active', value: { coffee: { name: 'Current' } },
    crc: 9, etag: 'current-etag',
  });
  await context.api.saveMetadataEditor(conflictForm);
  const conflictEditor = context.api.editor();
  check(conflictEditor.original.coffee.name === 'Edited after conflict' &&
        conflictEditor.record.etag === 'old-etag' &&
        conflictEditor.conflict.record.etag === 'current-etag' &&
        !conflictEditor.saving,
    'precondition recovery did not retain both versions for review');
  check(!context.api.closeActiveMetadataOverlay() &&
        context.api.editor() === conflictEditor &&
        context.api.editor().conflict.localValue.coffee.name ===
          'Edited after conflict',
    'closing a conflict implicitly discarded the local edits');

  let overwriteOptions = null;
  context.metadataStateFromResponse = () => 'active';
  context.fetchWithTimeout = async (_path, options, consume) => {
    overwriteOptions = options;
    return consume({
      status: 200,
      ok: true,
      headers: { get: name => name === 'ETag' ? 'saved-etag' : '0' },
      json: async () => JSON.parse(options.body),
    });
  };
  context.renderMetadataOverlay = () => {};
  context.flashBanner = () => {};
  await context.api.overwriteMetadataConflict();
  check(overwriteOptions.headers['If-Match'] === 'current-etag' &&
        JSON.parse(overwriteOptions.body).coffee.name ===
          'Edited after conflict',
    'explicit overwrite did not use the refreshed ETag and retained edits');

  let identityConflictRefetches = 0;
  context.api.setEditor({
    kind: 'shot', id: 8,
    record: { id: 8, state: 'active', etag: 'obsolete-etag' },
    original: { coffee: { name: 'Original shot' } },
    rating: 4, tags: [], saving: false, error: null, conflict: null,
  });
  context.fetchShotMetadata = async () => {
    ++identityConflictRefetches;
    throw new Error('must not refetch a reused id');
  };
  context.fetchWithTimeout = async (_path, _options, consume) => consume({
    status: 412,
    ok: false,
    headers: { get: name => name === 'X-Shot-Metadata-Conflict'
      ? 'shot-identity' : null },
  });
  await context.api.saveMetadataEditor(conflictForm);
  check(context.api.editor().conflict.action === 'identity' &&
        identityConflictRefetches === 0,
    'a reused shot id was offered as an ordinary overwrite conflict');
  await context.api.overwriteMetadataConflict();
  context.api.keepSavedMetadataConflict();
  check(context.api.editor().conflict.action === 'identity',
    'generic conflict actions accepted an identity conflict without a record');

  let clearRequests = 0;
  context.api.setEditor({
    kind: 'shot', id: 8,
    record: { id: 8, state: 'active', etag: 'saved-etag' },
    original: { coffee: { name: 'Keep this' } },
    rating: 0, tags: [], saving: false, error: null, conflict: null,
  });
  context.confirm = () => false;
  context.fetchWithTimeout = async () => { ++clearRequests; };
  await context.api.clearSavedMetadata();
  check(clearRequests === 0 && context.api.editor().original.coffee.name ===
        'Keep this',
    'cancelling clear removed saved shot details');

  check(context.api.downloadShotJson(8, {}, { loading: true }) === false,
    'JSON export accepted unresolved shot metadata');
  if (checkCount !== 140) {
    throw new Error(`expected 140 assertions, ran ${checkCount}`);
  }
  console.log('OK: shot metadata browser model');
  process.exitCode = 0;
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
