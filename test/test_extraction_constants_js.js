#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const fs = require('fs');
const vm = require('vm');

const [constantsPath, streamPath] = process.argv.slice(2);
if (!constantsPath || !streamPath) {
  console.error(
    'usage: test_extraction_constants_js.js CONSTANTS_JS STREAM_JS');
  process.exit(2);
}

const context = {
  DataView,
  Uint8Array,
  parseExtractionFromDv: (_dv, off) => ({ decodedAt: off }),
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(constantsPath, 'utf8') + '\n' +
    fs.readFileSync(streamPath, 'utf8') +
    '\nglobalThis.eventKindLabel = eventKindLabel;' +
    '\nglobalThis.packetVersion = PACKET_VERSION;' +
    '\nglobalThis.parseStatePayload = parseStatePayload;' +
    '\nglobalThis.parseFinalRecordPayload = parseFinalRecordPayload;',
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

if (context.packetVersion !== 5) {
  throw new Error('unexpected extraction stream packet version');
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

const finalBytes = new Uint8Array(8);
const finalView = new DataView(finalBytes.buffer);
finalView.setUint32(0, 42, true);
const finalRecord = context.parseFinalRecordPayload(finalView, 0);
if (finalRecord.shotId !== 42 || finalRecord.shot.decodedAt !== 4) {
  throw new Error('FINAL_RECORD did not preserve stored shot identity');
}

console.log('OK: extraction event labels and STATE payload');
