#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const fs = require('fs');
const vm = require('vm');

const [sourcePath, historyPath, codecHeaderPath, constantsPath] = process.argv.slice(2);
if (!sourcePath || !historyPath || !codecHeaderPath || !constantsPath) {
  console.error(
    'usage: test_shot_metadata_ui.js UI_METADATA_JS UI_HISTORY_JS CODEC_HEADER CONSTANTS_JS');
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
    get id() { return this.attrs.id; },
    append(...more) {
      this.children.push(...more);
      this.childNodes = this.children;
    },
    prepend(...more) {
      this.children.unshift(...more);
    },
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    focus() {},
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
  fs.readFileSync(constantsPath, 'utf8') + '\n' +
  fs.readFileSync(historyPath, 'utf8') + '\n' +
  fs.readFileSync(sourcePath, 'utf8') + '\n' +
  'globalThis.api = { maxBytes: SHOT_METADATA_MAX_BYTES, fetchWithTimeout,' +
    'metadataRecordFromRow, metadataValue, shotSummaryLines, appendShotSummary, shotSummaryFromRecord, appendShotMetadataDetails,' +
    'coffeeIdentity, recipeFromMetadata, nextShotCoffee,' +
    'fieldValue, editorSectionCompatible, renderEditorCoffee, renderEditorPreparation, inputField,' +
    'readEditorValue, metadataNumericInputError, openMetadataEditor, editorExtractionYield,' +
    'snapshotNextShotRecipe, initializeRecentShotMetadata,' +
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
    'chooseCoffee, confirmCoffeeChoice, readCoffeeFields, saveMetadataEditor, clearSavedMetadata,' +
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

const fullCoffee = { coffee: { name: 'Halo Beriti', roaster: 'Royal Mile',
  origin: 'Ethiopia', roastDate: '2026-09-17', roast: 'light',
  process: 'washed', variety: 'Heirloom' } };
const detailCoffeeNodes = descendants(context.api.renderEditorCoffee(fullCoffee, () => {}, true));
check(['Ethiopia', '2026-09-17', 'light', 'washed', 'Heirloom'].every(value =>
  detailCoffeeNodes.some(node => node.tag === 'dd' && node.children.includes(value))),
'saved-shot coffee summary omitted a populated detail');
check(!detailCoffeeNodes.some(node => node.tag === 'input') &&
  detailCoffeeNodes.some(node => node.tag === 'button' && node.children.includes('Edit coffee')),
'saved-shot coffee details are not read-only with a separate edit action');
check(!descendants(context.api.renderEditorCoffee(fullCoffee, () => {}, false))
  .some(node => node.tag === 'dl'), 'next-shot coffee summary is not compact');
const grindInput = descendants(context.api.inputField('Grind', { name: 'prep.grind' }))
  .find(node => node.tag === 'input');
check(grindInput.attrs.type === 'text' && !grindInput.attrs.inputmode,
  'grind input restricts access to the text keyboard');

const prepSummary = descendants(context.api.renderEditorPreparation({ prep: {
  grinder: 'Lagom O1', grind: '1.6', doseG: 16, targetYieldG: 40,
  tempC: 93, pressure: '6 bar', water: 'Filtered',
} }, () => {}));
check(['Lagom O1', '1.6', '16 g', '40 g', '93 °C', '6 bar', 'Filtered']
  .every(value => prepSummary.some(node => node.tag === 'dd' && node.children.includes(value))),
  'preparation summary omitted a recorded field or unit');
check(!prepSummary.some(node => node.tag === 'input') &&
  prepSummary.some(node => node.tag === 'button' && node.children.includes('Edit preparation')),
  'saved-shot preparation is not read-only with an edit action');
check(descendants(context.api.renderEditorPreparation({}, () => {}))
  .some(node => node.tag === 'button' && node.children.includes('Add preparation')),
  'empty preparation lacks an add action');

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

const errorPanel = context.renderEditorFormError('Test error');
check(errorPanel.attrs.tabindex === '-1' && !errorPanel.attrs.role &&
  errorPanel.textContent === 'Test error',
  'focused error presentation also used a live announcement');

for (const hadFocus of [false, true]) {
  const oldDocument = context.document;
  const oldPicker = context.renderCoffeePicker;
  const oldEditor = context.renderMetadataEditor;
  const active = { getAttribute: () => 'old-control', focus() {} };
  let focusCount = 0;
  let mounted = false;
  let previous = null;
  const error = { textContent: 'Request failed', focus: () => { ++focusCount; } };
  const overlay = {
    firstElementChild: {}, dataset: { modalKeyboard: 'true' },
    contains: () => hadFocus,
    replaceChildren() { mounted = false; }, append() { mounted = true; },
    querySelector: selector => selector === '.editor-error'
      ? mounted ? error : previous : null,
    querySelectorAll: () => [active],
  };
  context.document = {
    activeElement: active, getElementById: () => overlay,
    querySelectorAll: () => [],
  };
  context.renderCoffeePicker = () => null;
  context.renderMetadataEditor = () => ({});
  context.api.renderMetadataOverlay();
  check(focusCount === 1,
    'a new error did not receive focus after focus ' +
      (hadFocus ? 'stayed in the overlay' : 'left the disabled form'));
  previous = error;
  context.api.renderMetadataOverlay();
  check(focusCount === 1, 'an unchanged error stole focus on another render');
  context.document = oldDocument;
  context.renderCoffeePicker = oldPicker;
  context.renderMetadataEditor = oldEditor;
}

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
const editAction = context.api.shotMetadataListAction(row);
editAction.attrs.onclick({ stopPropagation() {} });
check(context.api.editor().record.etag === 'etag-7',
  'editing a history row discarded its available metadata version');
check(context.api.coffeeIdentity({ name: ' Halo Beriti ', roaster: ' Example ' }) ===
      context.api.coffeeIdentity({ name: 'halo beriti', roaster: 'example' }),
  'coffee identity is not trim- and case-insensitive');
// Fixtures use the same complete data shape returned by the History endpoint.
function summary(value, measurements = {}) {
  return { id: 7, ...measurements, userMetadataState: 'active', userMetadata: value };
}
check(context.api.shotSummaryLines(summary({
  coffee: { name: 'Halo Beriti', roastDate: '2026-08-12' },
  prep: { pressure: '9 bar' },
})).includes('Roasted 2026-08-12'),
  'shot summaries omit the coffee roast date');
check(context.api.shotSummaryLines(summary({ prep: { pressure: 'Blooming profile' } }))
  .includes('Blooming profile'),
  'shot summaries omit the pressure or profile');
check(context.api.shotSummaryLines(summary({ prep: { water: 'Lotus Light & Bright' } }))
  .includes('Lotus Light & Bright'),
  'shot summaries omit the water');
check(context.api.shotSummaryLines(summary({ rating: 3, tags: [1, 2] }))
  .join('\n') === '★★★',
  'non-string tags added an empty shot-summary field');

const extractionMetadata = { tdsPct: 8.6, prep: { doseG: 18, targetYieldG: 36 } };
const extractionSummary = context.el('div');
context.api.appendShotSummary(extractionSummary,
  summary(extractionMetadata, { yieldCg: 3900 }));
check(descendants(extractionSummary).some(node =>
  node.children.includes('8.6% TDS · Extraction yield: 18.6%')),
  'shot summary did not show extraction calculated from measured yield');
check(context.api.shotSummaryLines(summary({ tdsPct: 0, prep: { doseG: 18 } },
  { yieldCg: 3900 })).includes('0% TDS · Extraction yield: 0.0%'),
  'zero TDS was treated as missing');
for (const [name, value, measurements] of [
  ['missing yield', extractionMetadata, {}],
  ['zero yield', extractionMetadata, { yieldCg: 0 }],
  ['infinite yield', extractionMetadata, { yieldCg: Infinity }],
  ['missing dose', { tdsPct: 8.6 }, { yieldCg: 3900 }],
  ['zero dose', { tdsPct: 8.6, prep: { doseG: 0 } }, { yieldCg: 3900 }],
  ['missing TDS', { prep: { doseG: 18 } }, { yieldCg: 3900 }],
  ['negative TDS', { tdsPct: -1, prep: { doseG: 18 } }, { yieldCg: 3900 }],
  ['TDS over 100', { tdsPct: 101, prep: { doseG: 18 } }, { yieldCg: 3900 }],
]) {
  check(!context.api.shotSummaryLines(summary(value, measurements))
    .join(' ').includes('Extraction yield'),
    'shot summary calculated extraction for ' + name);
}
for (const coffee of [undefined, { name: 'Coffee', roastDate: '2026-08-12' }]) {
  const lines = context.api.shotSummaryLines(summary({
    coffee, prep: { doseG: 18 }, tdsPct: 8.6,
  }, { yieldCg: 3900 }), { showCoffeeName: false });
  check(lines.includes('18 g') &&
    lines.includes('8.6% TDS · Extraction yield: 18.6%') &&
    !lines.includes('Coffee') &&
    (!coffee || lines.includes('Roasted 2026-08-12')),
    'hiding the coffee name removed preparation, results, or the shot roast date');
}
for (const [tdsPct, expected] of [
  [86, '186.3% — check TDS, dose, and beverage weight.'],
  [8.6, '18.6%'],
]) {
  const lines = context.api.shotSummaryLines(summary({
    tdsPct, prep: { doseG: 18 },
  }, { yieldCg: 3900 }));
  check(lines.includes(tdsPct + '% TDS · Extraction yield: ' + expected),
    'extraction feedback was incorrect for TDS ' + tdsPct);
}
check(context.api.shotSummaryLines(summary({
  tdsPct: 50, prep: { doseG: 18 },
}, { yieldCg: 3600 })).includes('50% TDS · Extraction yield: 100.0%'),
  'extraction feedback incorrectly flagged the 100% boundary');
const summaryRecord = { id: 7, state: 'active', value: extractionMetadata, etag: 'shot-7' };
context.lastRecord = { shotId: 7, yieldCg: 9000 };
const detailSummary = context.el('div');
context.api.appendShotMetadataDetails(detailSummary,
  context.api.shotSummaryFromRecord(7, { yieldCg: 3900 }, summaryRecord));
check(JSON.stringify(detailSummary).includes('Extraction yield: 18.6%') &&
  !JSON.stringify(detailSummary).includes('43.0%'),
  'detail summary used another displayed shot with the same ID');
const damagedSummary = context.el('div');
context.api.appendShotMetadataDetails(damagedSummary,
  context.api.shotSummaryFromRecord(7, null, summaryRecord));
check(JSON.stringify(damagedSummary).includes('8.6% TDS') &&
  !JSON.stringify(damagedSummary).includes('Extraction yield'),
  'damaged detail borrowed measurements from another view');
context.lastRecord = null;
const pendingSummary = context.el('div');
context.api.appendShotMetadataDetails(pendingSummary,
  context.api.shotSummaryFromRecord(7, { yieldCg: 3900 }, { id: 7, loading: true }));
check(JSON.stringify(pendingSummary).includes('Loading shot details…'),
  'adapting a live record lost its metadata loading state');

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
function coffeeChoiceForm(fields = {}) {
  return { elements: {
    'coffee.name': element(context.api.coffeePickerState().recipe.coffee.name),
    ...fields,
  } };
}

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
  'prep.targetYieldG': element('36.5'),
  'prep.pressure': element('9 bar'),
  'prep.water': element('Lotus Light & Bright'),
  tdsPct: element('8.6'),
  tags: element('dial-in'),
  notes: element('Try finer'),
} };
const resultOnlyForm = { elements: {
  tdsPct: element('8.6'), tags: element('dial-in'), notes: element('Updated result'),
} };
const resultOnlyEdit = context.api.readEditorValue(resultOnlyForm, original);
check(JSON.stringify(resultOnlyEdit.prep) === JSON.stringify(original.prep) &&
      JSON.stringify(resultOnlyEdit.coffee) === JSON.stringify(original.coffee) &&
      resultOnlyEdit.notes === 'Updated result',
  'saving result-only edits changed read-only coffee or preparation');
const edited = context.api.readEditorValue(form, original);
check(edited.prep.targetYieldG === 36.5, 'target yield was not collected');
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
const shotARecipe = context.api.snapshotNextShotRecipe();
check(shotARecipe.prep.grind === '18.5',
  'the completed shot did not receive the current recipe');

context.api.setNextRecipe({ prep: { grind: '19' } });
context.api.setNextRecipe({ prep: { grind: '20' } });
const shotBRecipe = context.api.snapshotNextShotRecipe();
check(shotARecipe.prep.grind === '18.5' && shotBRecipe.prep.grind === '20',
  'recipe copies were not independent at shot completion');

context.api.setNextRecipe({});
check(context.api.snapshotNextShotRecipe() === null,
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
context.api.setNextRecipe({ coffee: {
  name: 'Halo Beriti', roaster: 'Example', roastDate: '2026-09-17',
} });
for (const phase of ['RUNNING', 'IDLE']) {
  context.state = { storage: 'ready', active: phase === 'RUNNING', phase };
  const app = { children: [], append(...items) { this.children.push(...items); } };
  context.api.renderCoffeeContext(app);
  check(descendants(app).some(node => node.attrs &&
    node.attrs.class === 'coffee-roast-date' &&
    node.children.includes('Roasted 2026-09-17')),
  'the selected roast date is missing from the ' + phase + ' coffee card');
}
context.state = { storage: 'ready', active: true, phase: 'RUNNING' };
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
  'prep.targetYieldG': element(''),
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
  'prep.targetYieldG': element('37'),
} });
check(JSON.parse(storedBrowserState).nextShotRecipe.prep.targetYieldG === 37,
  'offline recipe target was not saved in browser storage');
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
    '/slow', { signal: caller.signal }, response => context.readResponseBody(response, 'json'));
  await bodyStarted;
  caller.abort();
  let bodyWasCancelled = false;
  try {
    await bodyRead;
  } catch (err) {
    bodyWasCancelled = err.kind === 'cancelled';
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
  await context.api.loadShotMetadata({ id: 999 });
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
  context.api.setCoffeePicker({ onChoose: null });
  context.api.chooseCoffee({ name: 'Halo Beriti' });
  context.api.confirmCoffeeChoice(coffeeChoiceForm());
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
  const beforeSelection = JSON.stringify(context.api.editor().original);
  context.api.chooseCoffee({ name: 'Prior coffee', roaster: 'Prior roaster' });
  check(JSON.stringify(context.api.editor().original) === beforeSelection,
    'selecting a coffee committed it before the details confirmation');
  context.api.confirmCoffeeChoice(coffeeChoiceForm());
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
  'prep.targetYieldG': element(''),
    'prep.pressure': element(''),
    'prep.water': element(''),
    notes: element('Saved shot note'),
  } };
  context.api.openEditorCoffeePicker(savedShotForm);
  context.api.chooseCoffee({ name: 'Prior coffee', roaster: 'Prior roaster' });
  context.api.confirmCoffeeChoice(coffeeChoiceForm());
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

  // Detail edits are drafts: cancel preserves the parent, confirm preserves
  // preparation and unknown coffee properties without changing history.
  const draftForm = { elements: { ...savedShotForm.elements } };
  for (const key of Object.keys(draftForm.elements)) {
    if (key.startsWith('coffee.')) delete draftForm.elements[key];
  }
  const beforeCoffee = JSON.stringify(context.api.editor().original.coffee);
  context.api.openEditorCoffeePicker(draftForm);
  check(context.api.coffeePickerState().stage === 'details',
    'editing the selected coffee did not open its details directly');
  const detailNodes = descendants(context.api.renderCoffeePicker());
  check(detailNodes.some(node => node.attrs && node.attrs.name === 'coffee.roastDate') &&
        detailNodes.some(node => node.attrs && node.attrs.name === 'coffee.variety'),
    'the shared coffee editor omitted roast date or variety');
  context.api.coffeePickerState().recipe.coffee.roastDate = '2026-09-17';
  context.api.closeActiveMetadataOverlay();
  check(JSON.stringify(context.api.editor().original.coffee) === beforeCoffee &&
        context.api.editor().original.prep.grind === '20',
    'cancelling coffee details changed the parent coffee or preparation');
  context.api.openEditorCoffeePicker(draftForm);
  context.api.confirmCoffeeChoice(coffeeChoiceForm({
    'coffee.roastDate': element('2026-09-17'),
    'coffee.variety': element('Heirloom'),
  }));
  check(context.api.editor().original.coffee.roastDate === '2026-09-17' &&
        context.api.editor().original.coffee.variety === 'Heirloom' &&
        context.api.editor().original.coffee.futureCoffeeField.retained &&
        context.api.editor().original.prep.grind === '20',
    'editing coffee details replaced preparation or lost unknown fields');
  check(context.api.historyStore.rows.find(row => row.id === 11)
        .userMetadata.coffee.roastDate === '2026-08-12',
    'editing a coffee changed its historical source');

  context.api.historyStore.sessionStarted();
  context.api.setCoffeePicker({ onChoose: null });
  context.api.chooseCoffee({ name: 'Prior coffee', roaster: 'Prior roaster' });
  context.api.confirmCoffeeChoice(coffeeChoiceForm());
  check(context.api.browserState().nextShotRecipeSourceId === null &&
        context.api.browserState().nextShotRecipe.coffee.origin === 'Ethiopia',
    'cached history attributed a recipe to an unvalidated shot identity');

  context.lastRecord = null;
  context.selectedShotId = null;
  context.selectedShot = null;
  context.api.openMetadataEditor(context.api.historyStore.rows.find(row => row.id === 11));
  check(context.api.editor().yieldCg === 3900,
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
    replaceChildren() {}, querySelector: () => null,
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
  const abandonedMetadataLoad = context.api.loadShotMetadata({ id: 11 });
  context.api.openNextShotEditor();
  finishAbandonedMetadataLoad({
    id: 11, state: 'active', value: { coffee: { name: 'Saved' } },
    crc: 8, etag: 'meta-11',
  });
  await abandonedMetadataLoad;
  check(context.api.editor().kind === 'recipe',
    'an abandoned metadata load replaced the current editor');

  function validationForm(elements) {
    let formError = null;
    const fields = [];
    const result = {
      elements: {}, focused: null,
      querySelector(selector) {
        return selector === '.editor-error' ? formError
          : this.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        return selector === '.field-error'
          ? fields.flatMap(field => field.children.filter(node =>
            node.attrs && node.attrs.class.includes('field-error'))) : [];
      },
      prepend(node) {
        formError = node;
        node.remove = () => { formError = null; };
        node.focus = () => { result.focused = node; };
      },
    };
    for (const [name, source] of Object.entries(elements)) {
      const field = { children: [], scrollIntoView(options) {
        this.scrollBlock = options.block;
      }, append(node) {
        this.children.push(node);
        node.remove = () => {
          this.children = this.children.filter(child => child !== node);
        };
      } };
      fields.push(field);
      const actionRow = source.withAction
        ? { ...field, children: [field, { tag: 'button' }] } : null;
      if (actionRow) fields.push(actionRow);
      const input = { ...source, name, actionRow, attrs: { ...source.attrs },
        section: { open: false },
        getAttribute(key) { return this.attrs[key] || null; },
        setAttribute(key, value) { this.attrs[key] = value; },
        removeAttribute(key) { delete this.attrs[key]; },
        closest(selector) {
          return selector === '.field' ? field
            : selector === '.field-with-action' ? actionRow : this.section;
        },
        focus: () => { result.focused = input; },
      };
      result.elements[name] = input;
    }
    return result;
  }
  const renderBeforeSubmitValidation = context.renderMetadataOverlay;
  context.renderMetadataOverlay = () => {
    throw new Error('form validation rebuilt the overlay');
  };
  context.api.setNextRecipe({ coffee: { name: 'Existing recipe' } });
  for (const [name, raw] of [
    ['prep.doseG', '0'], ['prep.tempC', '1e999'],
    ['prep.targetYieldG', '36.1'], ['tdsPct', '101'],
  ]) {
    const invalidNumericForm = validationForm({
      ...form.elements, [name]: element(raw),
    });
    const input = invalidNumericForm.elements[name];
    const section = input.section;
    context.api.setEditor({
      kind: 'recipe', original: { coffee: { name: 'Existing recipe' } },
      rating: 0, tags: [], saving: false, error: null,
    });
    for (let attempt = 1; attempt <= 2; ++attempt) {
      invalidNumericForm.focused = null;
      section.open = false;
      await context.api.saveMetadataEditor(invalidNumericForm);
      const fieldError = invalidNumericForm.querySelector('.field-error');
      check(context.api.editor().error === null && fieldError &&
            !invalidNumericForm.querySelector('.editor-error') &&
            invalidNumericForm.focused === input && section.open &&
            input.attrs['aria-describedby'] === fieldError.id &&
            input.attrs['aria-invalid'] === 'true' &&
            input.closest('.field').scrollBlock === 'center' &&
            context.api.browserState().nextShotRecipe.coffee.name ===
              'Existing recipe',
        name + ' validation did not focus its field or preserve the recipe, attempt ' + attempt);
    }
  }

  const movingErrorForm = validationForm({
    ...form.elements,
    'prep.doseG': { ...element('0'), attrs: { 'aria-describedby': 'dose-help' } },
    tdsPct: element('101'),
  });
  context.api.setEditor({
    kind: 'shot', id: 8, original: { coffee: { name: 'Coffee' } },
    rating: 0, tags: [], saving: false, error: null,
  });
  await context.api.saveMetadataEditor(movingErrorForm);
  const doseInput = movingErrorForm.elements['prep.doseG'];
  const tdsInput = movingErrorForm.elements.tdsPct;
  const doseError = movingErrorForm.querySelector('.field-error');
  context.clearEditorFieldErrors(movingErrorForm, tdsInput);
  check(movingErrorForm.querySelector('.field-error') === doseError &&
        doseInput.attrs['aria-describedby'] === 'dose-help ' + doseError.id,
    'editing an unrelated field cleared the dose error or its existing description');
  doseInput.value = '18';
  await context.api.saveMetadataEditor(movingErrorForm);
  const tdsError = movingErrorForm.querySelector('.field-error');
  check(movingErrorForm.focused === tdsInput && tdsError.id !== doseError.id &&
        doseInput.attrs['aria-describedby'] === 'dose-help' &&
        !doseInput.attrs['aria-invalid'] &&
        tdsInput.attrs['aria-describedby'] === tdsError.id,
    'moving validation from dose to TDS left a stale description or invalid marker');
  context.clearEditorFieldErrors(movingErrorForm, tdsInput);
  check(!movingErrorForm.querySelector('.field-error') &&
        !tdsInput.attrs['aria-describedby'] && !tdsInput.attrs['aria-invalid'] &&
        doseInput.attrs['aria-describedby'] === 'dose-help',
    'clearing the field error left its accessibility state or removed unrelated help');
  const doseField = context.api.inputField('Dose', { name: 'prep.doseG' });
  check(doseField.tag === 'div' && doseField.children[0].tag === 'label' &&
        doseField.children[0].children[0].children[0] === 'Dose',
    'field markup did not leave space for an explanation outside its label');

  const oversizedRecipeForm = validationForm({
    ...form.elements,
    'coffee.name': element('x'.repeat(context.api.maxBytes + 1)),
  });
  context.api.setEditor({
    kind: 'recipe',
    original: { coffee: { name: 'Existing recipe' } },
    rating: 0, tags: [], saving: false, error: null,
  });
  for (let attempt = 1; attempt <= 2; ++attempt) {
    oversizedRecipeForm.focused = null;
    await context.api.saveMetadataEditor(oversizedRecipeForm);
    check(context.api.editor().kind === 'recipe' &&
          context.api.editor().original.coffee.name.length > context.api.maxBytes &&
          oversizedRecipeForm.focused ===
            oversizedRecipeForm.querySelector('.editor-error') &&
          context.api.browserState().nextShotRecipe.coffee.name ===
            'Existing recipe',
      'over-limit recipe lost its edits or error focus, attempt ' + attempt);
  }
  context.renderMetadataOverlay = renderBeforeSubmitValidation;

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
  const documentBeforeSubmitValidation = context.document;
  let validationFocus = null;
  const mountedError = { focus: () => { validationFocus = mountedError; } };
  context.document = {
    getElementById: id => id === 'editor-error' ? mountedError : null,
  };
  context.renderMetadataOverlay = () => { validationFocus = 'first input'; };
  for (let attempt = 1; attempt <= 2; ++attempt) {
    await context.api.saveMetadataEditor(overLimitForm);
    check(context.api.editor().original.notes.length > context.api.maxBytes &&
          context.api.editor().error && validationFocus === mountedError,
      'over-limit shot lost its edits or error focus, attempt ' + attempt);
  }
  context.document = documentBeforeSubmitValidation;
  context.renderMetadataOverlay = renderBeforeSubmitValidation;

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
  check(descendants(context.api.renderEditorCoffee({}, () => {}, true))
    .some(node => node.tag === 'button' && node.children.includes('Choose coffee')),
    'a shot without coffee lacks a direct choose action');
  context.api.setEditor({ kind: 'shot', original: {}, rating: 0, tags: [] });
  context.api.openEditorCoffeePicker({ elements: {
    tags: element(''), notes: element(''), tdsPct: element(''),
  } });
  check(context.api.coffeePickerState().stage === 'select',
    'a shot without coffee opened an empty details form instead of selection');
  context.api.closeActiveMetadataOverlay();

  context.api.setCoffeePicker({ onChoose: null });
  context.api.chooseCoffee({ name: 'Prior coffee', roaster: 'Prior roaster' });
  const reconnectPicker = context.api.coffeePickerState();
  reconnectPicker.sourceId = 12;
  reconnectPicker.sourceCoffeeIdentity = context.api.coffeeIdentity(reconnectPicker.recipe.coffee);
  context.api.metadataStreamSessionStarted();
  check(reconnectPicker.sourceId === null && reconnectPicker.sourceCoffeeIdentity === null,
    'reconnect retained the coffee picker source identity');
  context.api.confirmCoffeeChoice(coffeeChoiceForm());
  check(context.api.browserState().nextShotRecipeSourceId === null,
    'confirming coffee after reconnect restored stale shot attribution');

  for (const prep of [{ doseG: '16', grind: 3 }, 'unsupported']) {
    const nodes = descendants(context.api.renderEditorPreparation({ prep }, () => {}));
    check(nodes.some(node => node.attrs.class === 'field-warning') &&
          !nodes.some(node => node.children.includes('No preparation recorded.')),
      'incompatible preparation was reported as absent');
  }

  const invalidPicker = { stage: 'details', recipe: { coffee: { name: 42 } } };
  context.api.setCoffeePicker(invalidPicker);
  context.api.confirmCoffeeChoice({ elements: { 'coffee.name': {
    disabled: true, focus: () => { throw new Error('focused disabled coffee name'); },
  } } });
  check(invalidPicker.error.message ===
        "This coffee's name cannot be edited here. Choose another coffee.",
    'an incompatible coffee name offered an unavailable editing action');

  const blankNamePicker = { stage: 'details', recipe: { coffee: { name: 'Coffee' } } };
  context.api.setCoffeePicker(blankNamePicker);
  const nameForm = validationForm({
    'coffee.name': { ...element(''), withAction: true },
  });
  const nameInput = nameForm.elements['coffee.name'];
  const renderBeforeValidation = context.renderMetadataOverlay;
  context.renderMetadataOverlay = () => { throw new Error('validation rebuilt the overlay'); };
  context.api.confirmCoffeeChoice(nameForm);
  const inlineError = nameForm.querySelector('.field-error');
  check(nameForm.focused === nameInput &&
        blankNamePicker.error.field === 'coffee.name' &&
        blankNamePicker.error.message === 'Enter a coffee name.' &&
        inlineError.textContent === 'Enter a coffee name.' &&
        nameInput.attrs['aria-describedby'] === inlineError.id &&
        !nameForm.querySelector('.editor-error'),
    'empty coffee name did not show an inline error and focus its field');
  check(nameInput.actionRow.children[2] === inlineError &&
        !nameInput.closest('.field').children.includes(inlineError) &&
        nameInput.actionRow.scrollBlock === 'center',
    'coffee-name error did not follow the input and button or scroll with their row');
  const elBeforeCoffeeRender = context.el;
  const appendBeforeCoffeeRender = context.appendEditorFieldError;
  const restoredFieldErrors = [];
  context.el = (tag, ...args) => {
    const node = elBeforeCoffeeRender(tag, ...args);
    if (tag === 'form') {
      Object.defineProperty(node, 'elements', { configurable: true,
        get() {
          return Object.fromEntries(descendants(node).filter(child =>
            child.attrs && child.attrs.name).map(child => [child.attrs.name, child]));
        },
      });
    }
    return node;
  };
  context.appendEditorFieldError = (input, message) => {
    restoredFieldErrors.push({ input, message });
  };
  const coffeeEditorForm = descendants(context.api.renderCoffeePicker())
    .find(node => node.tag === 'form');
  check(restoredFieldErrors.length === 1 &&
        restoredFieldErrors[0].input.attrs.name === 'coffee.name' &&
        restoredFieldErrors[0].input.attrs.value === '' &&
        restoredFieldErrors[0].message === 'Enter a coffee name.' &&
        blankNamePicker.error.field === 'coffee.name',
    'rebuilding coffee details lost the submitted draft or its field validation');
  context.el = elBeforeCoffeeRender;
  context.appendEditorFieldError = appendBeforeCoffeeRender;
  Object.defineProperty(coffeeEditorForm, 'elements', { value: nameForm.elements });
  coffeeEditorForm.querySelector = selector => nameForm.querySelector(selector);
  coffeeEditorForm.querySelectorAll = selector => nameForm.querySelectorAll(selector);
  coffeeEditorForm.listeners.input({ target: { name: 'coffee.roaster' } });
  check(blankNamePicker.error.field === 'coffee.name' &&
        nameForm.querySelector('.field-error') === inlineError &&
        nameInput.attrs['aria-invalid'] === 'true',
    'editing another coffee field cleared the name validation');
  nameInput.value = 'Coffee';
  coffeeEditorForm.listeners.input({ target: nameInput });
  check(blankNamePicker.error === null && !nameForm.querySelector('.field-error') &&
        !nameInput.attrs['aria-describedby'] && !nameInput.attrs['aria-invalid'],
    'editing the coffee name left its error or accessibility link');
  nameForm.focused = null;
  nameInput.disabled = true;
  blankNamePicker.recipe.coffee.name = 42;
  context.api.confirmCoffeeChoice(nameForm);
  const formError = nameForm.querySelector('.editor-error');
  check(nameForm.focused === formError &&
        formError.textContent.includes('Choose another coffee.') &&
        !nameForm.querySelector('.field-error'),
    'an uneditable coffee name did not show and focus a form error');
  context.renderMetadataOverlay = renderBeforeValidation;

  const largeCoffee = { name: 'Large coffee', origin: 'x'.repeat(context.api.maxBytes) };
  await context.api.openCoffeePicker(null, largeCoffee);
  context.api.confirmCoffeeChoice(coffeeChoiceForm());
  const largePicker = context.api.coffeePickerState();
  check(!!largePicker.error, 'standalone coffee selection accepted oversized metadata');
  const coffeeForm = descendants(context.api.renderCoffeePicker()).find(node => node.tag === 'form');
  coffeeForm.elements = { 'coffee.origin': element('Short origin') };
  let removedError = false;
  coffeeForm.querySelector = () => ({ remove: () => { removedError = true; } });
  coffeeForm.listeners.input();
  check(largePicker.error === null && removedError,
    'editing coffee left an obsolete validation error visible');

  let nestedDraft = null;
  await context.api.openCoffeePicker(recipe => { nestedDraft = recipe; }, largeCoffee);
  context.api.confirmCoffeeChoice(coffeeChoiceForm());
  check(nestedDraft && nestedDraft.coffee.origin === largeCoffee.origin &&
        context.api.coffeePickerState() === null,
    'nested coffee editing bypassed the parent draft workflow with a partial size check');

  await context.api.openCoffeePicker(() => {}, { name: 'Coffee' });
  const loadingDetails = context.api.coffeePickerState();
  loadingDetails.loadingHistory = true;
  const detailTree = descendants(context.api.renderCoffeePicker());
  detailTree.find(node => node.tag === 'form').elements = {};
  let pickerRenders = 0;
  const priorRender = context.renderMetadataOverlay;
  context.renderMetadataOverlay = () => { ++pickerRenders; };
  detailTree.find(node => node.tag === 'button' && node.children.includes('Choose another'))
    .attrs.onclick();
  context.renderMetadataOverlay = priorRender;
  check(loadingDetails.stage === 'select' && pickerRenders === 1,
    'choosing another coffee waited for an in-flight history request to render');
  context.api.setCoffeePicker(null);
  let confirmedCoffee = null;
  await context.api.openCoffeePicker(recipe => { confirmedCoffee = recipe.coffee; },
    { name: 'Coffee', roaster: 'Royal', origin: 'Ethiopia', futureField: 'preserved' });
  const rawDraftForm = descendants(context.api.renderCoffeePicker()).find(node => node.tag === 'form');
  rawDraftForm.elements = {
    'coffee.name': element(' Coffee '),
    'coffee.roaster': element('Royal '),
    'coffee.origin': element('   '),
  };
  rawDraftForm.listeners.input();
  const rebuiltCoffeeInputs = descendants(context.api.renderCoffeePicker());
  const rebuiltRoaster = rebuiltCoffeeInputs.find(node => node.attrs.name === 'coffee.roaster');
  check(rebuiltRoaster.attrs.value === 'Royal ' &&
        rebuiltCoffeeInputs.find(node => node.attrs.name === 'coffee.origin').attrs.value === '   ',
    'rebuilding coffee details trimmed unfinished input');
  const rebuiltCoffeeForm = { elements: {
    'coffee.name': element(' Coffee '),
    'coffee.roaster': element(rebuiltRoaster.attrs.value + 'Mile '),
    'coffee.origin': element('   '),
  } };
  context.api.confirmCoffeeChoice(rebuiltCoffeeForm);
  check(confirmedCoffee.name === 'Coffee' && confirmedCoffee.roaster === 'Royal Mile' &&
        !('origin' in confirmedCoffee) && confirmedCoffee.futureField === 'preserved',
    'coffee confirmation failed to trim fields, remove blanks, or preserve unknown values');
  // Exercise view callers, not just the shared summary renderer.
  context.fetchShotsPage = async () => historyPage([summary(extractionMetadata, {
    startUtcSec: 100, beginMs: 0, durationMs: 30000, totalPumpOnMs: 25000,
    yieldCg: 3900,
  })], { total: 1 });
  await context.api.historyStore.refresh();
  context.state = { storage: 'ready' };
  context.fmtMMSS = ms => String(ms);
  context.fmtG = cg => String(cg / 100);
  context.fmtSec = ms => String(ms / 1000);
  const historySummaryView = context.el('main');
  context.api.renderList(historySummaryView);
  check(JSON.stringify(historySummaryView).includes('Extraction yield: 18.6%'),
    'History caller discarded measurements before rendering the summary');

  const views = {
    el: context.el, localStorage: { getItem: () => null },
    state: null, inPumpWindow: () => false,
    lastRecord: { shotId: 7, yieldCg: 9000 },
    selectedShotId: 7, selectedShot: { yieldCg: 3900 },
    selectedShotMetadata: summaryRecord, selectedShotError: null,
    freshFinalizedAt: 0, fmtDate: () => '',
    record: summaryRecord,
  };
  vm.createContext(views);
  vm.runInContext([
    constantsPath, historyPath, sourcePath,
    require('path').join(require('path').dirname(sourcePath), 'ui-live.js'),
  ].map(path => fs.readFileSync(path, 'utf8')).join('\n'), views);
  // Chart internals are outside this test; keep the actual view composition.
  views.renderShotRecord = app => {
    const card = views.el('section');
    app.append(card);
    return card;
  };
  views.techFold = () => views.el('div');
  vm.runInContext('lastShotMetadata = record;', views);
  const selectedView = views.el('main');
  views.renderDetail(selectedView);
  check(JSON.stringify(selectedView).includes('Extraction yield: 18.6%'),
    'History detail caller did not use its displayed measurements');
  const liveView = views.el('main');
  views.renderLastShot(liveView);
  check(JSON.stringify(liveView).includes('Extraction yield: 43.0%'),
    'Last Shot caller did not use its displayed measurements');
  views.selectedShotError = 'invalid';
  const invalidView = views.el('main');
  views.renderDetail(invalidView);
  check(JSON.stringify(invalidView).includes('8.6% TDS') &&
    !JSON.stringify(invalidView).includes('Extraction yield'),
    'damaged detail caller supplied measurements for extraction');
  views.renderMetadataOverlay = () => {};
  const editDetails = root => descendants(root).find(node =>
    node.tag === 'button' && node.children.includes('Edit shot details'));
  views.view = 'detail';
  views.performance = performance;
  views.scheduleRender = () => {};
  let detailMetadataReads = 0;
  views.fetchShotMetadata = async () => {
    ++detailMetadataReads;
    return { ...summaryRecord, etag: 'refreshed-shot-7' };
  };
  await editDetails(selectedView).attrs.onclick();
  const detailEditor = vm.runInContext('metadataEditor', views);
  check(detailEditor.yieldCg === 3900 && detailEditor.record.etag === 'refreshed-shot-7',
    'shared History detail opened the editor with another shot or metadata version');
  const extractionForm = views.el('form');
  extractionForm.elements = { tdsPct: element('8.6'), 'prep.doseG': element('18') };
  const ey = views.editorExtractionYield(extractionForm, detailEditor);
  check(ey.textContent === 'Extraction yield: 18.6%',
    'editor extraction did not use its measurement snapshot');
  extractionForm.elements.tdsPct.value = '86';
  extractionForm.listeners.input();
  check(ey.textContent ===
    'Extraction yield: 186.3% — check TDS, dose, and beverage weight.' &&
    extractionForm.elements.tdsPct.value === '86',
    'editor failed to flag impossible extraction or changed the entered TDS');
  extractionForm.elements.tdsPct.value = '';
  extractionForm.listeners.input();
  check(ey.textContent === '', 'blank editor TDS produced an extraction percentage');
  extractionForm.elements.tdsPct.value = '0';
  extractionForm.listeners.input();
  check(ey.textContent === 'Extraction yield: 0.0%', 'zero editor TDS was hidden');
  extractionForm.elements.tdsPct.value = '9';
  extractionForm.elements['prep.doseG'].value = '20';
  views.lastRecord = { shotId: 7, yieldCg: 10000 };
  views.selectedShot = { yieldCg: 10000 };
  extractionForm.listeners.input();
  check(ey.textContent === 'Extraction yield: 17.6%' &&
    extractionForm.elements.tdsPct.value === '9' && extractionForm.elements['prep.doseG'].value === '20',
    'changing displayed records replaced editor measurements or draft inputs');
  views.closeMetadataEditor();
  views.view = 'live';
  await editDetails(liveView).attrs.onclick();
  check(vm.runInContext('metadataEditor.yieldCg', views) === 9000,
    'shared Last Shot detail did not open its own measurement snapshot');
  views.closeMetadataEditor();
  views.view = 'detail';
  await editDetails(invalidView).attrs.onclick();
  const invalidEditor = vm.runInContext('metadataEditor', views);
  check(invalidEditor.yieldCg === undefined &&
    views.editorExtractionYield(extractionForm, invalidEditor).textContent === '',
    'damaged shot editor borrowed measurements from another view');
  check(detailMetadataReads === 3,
    'detail and Last Shot edit actions did not refresh metadata before opening');
  if (checkCount !== 226) {
    throw new Error(`expected 226 assertions, ran ${checkCount}`);
  }
  console.log('OK: shot metadata browser model');
  process.exitCode = 0;
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
