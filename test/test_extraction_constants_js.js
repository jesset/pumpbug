#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const fs = require('fs');
const vm = require('vm');

const [constantsPath, streamPath, streamHeaderPath] = process.argv.slice(2);
if (!constantsPath || !streamPath || !streamHeaderPath) {
  console.error(
    'usage: test_extraction_constants_js.js CONSTANTS_JS STREAM_JS ' +
    'EXTRACTION_STREAM_H');
  process.exit(2);
}

let historySessionStarts = 0;
const historyStateEvents = [];
const context = {
  DataView,
  Uint8Array,
  performance: { now: () => 0 },
  state: null,
  inflight: null,
  lastRecord: null,
  lastShotExpanded: false,
  inPumpWindow: current => !!current && current.active &&
    (current.phase === 'RUNNING' || current.phase === 'POST_PUMP'),
  updateCoffeeContextHistoryForState: () => {},
  historyStore: {
    sessionStarted: () => { ++historySessionStarts; },
    observeDeviceState: (storage, savedShot, allowBackgroundRefresh) => {
      historyStateEvents.push({ storage, savedShot, allowBackgroundRefresh });
    },
  },
  setBanner: () => {},
  parseExtractionFromDv: (_dv, off) => ({ decodedAt: off }),
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(constantsPath, 'utf8') + '\n' +
    fs.readFileSync(streamPath, 'utf8') +
    '\nglobalThis.eventKindLabel = eventKindLabel;' +
    '\nglobalThis.packetVersion = PACKET_VERSION;' +
    '\nglobalThis.packetHeaderBytes = PACKET_HEADER_BYTES;' +
    '\nglobalThis.parseStatePayload = parseStatePayload;' +
    '\nglobalThis.handleStatePacket = handleStatePacket;' +
    '\nglobalThis.handleCurrentRecordPacket = handleCurrentRecordPacket;' +
    '\nglobalThis.beginHistorySession = () => historyStore.sessionStarted();' +
    '\nglobalThis.parseFinalRecordPayload = parseFinalRecordPayload;' +
    '\nglobalThis.handleFinalRecordPacket = handleFinalRecordPacket;' +
    '\nglobalThis.setStreamStatus = setStreamStatus;' +
    '\nglobalThis.streamConnectionStatus = () => ({' +
      'current: streamStateCurrent, status: streamStatus });',
  context,
);

if (context.eventKindLabel(6, 3) !== 'PUMP_OFF') {
  throw new Error('v6 pump-off label changed');
}
if (context.eventKindLabel(7, 3) !== 'PUMP_OFF_CONFIRMED') {
  throw new Error('v7 pump-off label changed');
}
if (context.eventKindLabel(7, 99) !== 99) {
  throw new Error('unknown event kind did not retain its numeric value');
}

if (context.packetVersion !== 5 || context.packetHeaderBytes !== 14) {
  throw new Error('unexpected extraction stream packet version');
}
const streamHeader = fs.readFileSync(streamHeaderPath, 'utf8');
const firmwarePacketVersion = Number(streamHeader.match(
  /kPacketVersion\s*=\s*(\d+)/)?.[1]);
const firmwareHeaderBytes = Number(streamHeader.match(
  /kPacketHeaderBytes\s*=\s*(\d+)/)?.[1]);
if (firmwarePacketVersion !== context.packetVersion ||
    firmwareHeaderBytes !== context.packetHeaderBytes) {
  throw new Error('browser and firmware packet constants differ');
}

const stateBytes = new Uint8Array(12);
const stateView = new DataView(stateBytes.buffer);
stateBytes[0] = 0x47;  // active, weight, yield, latest shot saved
stateBytes[1] = 2;     // POST_PUMP
stateBytes[2] = 3;     // connected
stateBytes[3] = 0;     // storage ready
stateView.setUint32(4, 1234, true);
stateView.setInt16(8, -25, true);
stateView.setInt16(10, 3800, true);

const state = context.parseStatePayload(stateView, 0);
if (!state.latestShotSaved || state.currentWeightCg !== -25 ||
    state.currentYieldCg !== 3800) {
  throw new Error('STATE payload did not preserve save status');
}

context.setStreamStatus('status · disconnected; reconnecting…');
if (context.streamConnectionStatus().current) {
  throw new Error('a disconnected stream retained current device state');
}
context.beginHistorySession();
context.handleStatePacket(stateView, 0, 9);
if (!context.streamConnectionStatus().current) {
  throw new Error('a received STATE did not make device state current');
}
if (historySessionStarts !== 1 || historyStateEvents.length !== 1 ||
    historyStateEvents[0].storage !== 'ready' ||
    historyStateEvents[0].savedShot ||
    historyStateEvents[0].allowBackgroundRefresh) {
  throw new Error('the stream did not report its session and device state');
}
context.handleStatePacket(stateView, 0, 9);
if (historyStateEvents.length !== 2 || historyStateEvents[1].savedShot) {
  throw new Error('an unchanged STATE reported a saved shot');
}
context.beginHistorySession();
context.handleStatePacket(stateView, 0, 10);
if (historySessionStarts !== 2 || historyStateEvents.length !== 3 ||
    !historyStateEvents[2].savedShot) {
  throw new Error('a saved shot was not reported to the history store');
}
stateBytes[3] = 1;
context.handleStatePacket(stateView, 0, 10);
stateBytes[3] = 0;
context.handleStatePacket(stateView, 0, 10);
if (historyStateEvents.length !== 5 ||
    historyStateEvents[3].storage !== 'unavailable' ||
    historyStateEvents[4].storage !== 'ready') {
  throw new Error('storage transitions were not reported to the history store');
}

const finalBytes = new Uint8Array(8);
const finalView = new DataView(finalBytes.buffer);
finalView.setUint32(0, 42, true);
const finalRecord = context.parseFinalRecordPayload(finalView, 0);
if (finalRecord.shotId !== 42 || finalRecord.shot.decodedAt !== 4) {
  throw new Error('FINAL_RECORD did not preserve stored shot identity');
}

const displayedRecords = [];
let recipeCopies = 0;
context.inflight = { shotSeq: 7, beginMs: 1000 };
context.parseExtractionFromDv = () => ({ beginMs: 1000 });
context.recipeForCompletedShot = () => {
  ++recipeCopies;
  return { coffee: { name: 'Prepared coffee' } };
};
context.setLastShotMetadataId = (shotId, recipe) => {
  displayedRecords.push({ shotId, recipe });
};
context.scheduleRender = () => {};
context.setTimeout = () => {};
context.FRESH_SHOT_BADGE_MS = 0;

context.handleFinalRecordPacket(finalView, 0, 7);
if (recipeCopies || context.inflight === null ||
    displayedRecords[0].recipe !== null) {
  throw new Error('display snapshot copied the current recipe');
}

context.parseExtractionFromDv = () => ({ beginMs: 2000 });
context.handleFinalRecordPacket(finalView, 0, 8);
if (recipeCopies || context.inflight !== null ||
    displayedRecords[1].recipe !== null) {
  throw new Error('a different final record copied the current recipe');
}

context.inflight = {
  shotSeq: 8, beginMs: 3000, recipeAttachmentEligible: true,
};
context.parseExtractionFromDv = () => ({ beginMs: 3000 });
context.handleFinalRecordPacket(finalView, 0, 9);
if (recipeCopies !== 1 || context.inflight !== null ||
    displayedRecords[2].recipe.coffee.name !== 'Prepared coffee') {
  throw new Error('completed live shot did not copy the current recipe');
}

context.parseExtractionFromDv = () => ({ beginMs: 4000 });
context.handleFinalRecordPacket(finalView, 0, 10);
if (recipeCopies !== 1 || displayedRecords[3].recipe !== null) {
  throw new Error('snapshot without a matching live shot copied the recipe');
}

context.state = { active: true, phase: 'RUNNING' };
context.inflight = null;
context.parseExtractionFromDv = () => ({ beginMs: 5000 });
context.handleCurrentRecordPacket(finalView, 0, 10);
if (context.inflight.recipeAttachmentEligible) {
  throw new Error('a mid-shot stream snapshot enabled recipe attachment');
}
context.handleFinalRecordPacket(finalView, 0, 11);
if (recipeCopies !== 1 || displayedRecords[4].recipe !== null) {
  throw new Error('a shot joined in progress copied the current recipe');
}

context.state = { active: true, phase: 'IDLE' };
context.parseExtractionFromDv = () => ({ beginMs: 6000 });
context.handleCurrentRecordPacket(finalView, 0, 11);
if (!context.inflight.recipeAttachmentEligible) {
  throw new Error('an observed shot start was not eligible for attachment');
}
context.state = { active: true, phase: 'RUNNING' };
context.handleCurrentRecordPacket(finalView, 0, 11);
if (!context.inflight.recipeAttachmentEligible) {
  throw new Error('a phase snapshot lost recipe-attachment eligibility');
}
context.handleFinalRecordPacket(finalView, 0, 12);
if (recipeCopies !== 2 ||
    displayedRecords[5].recipe.coffee.name !== 'Prepared coffee') {
  throw new Error('a shot observed from start did not copy the current recipe');
}

console.log('OK: extraction event labels and STATE payload');
