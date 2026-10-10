#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const [metadataPath, constantsPath, livePath] = process.argv.slice(2);
if (!metadataPath || !constantsPath || !livePath) {
  console.error('usage: test_recipe_target.js UI_METADATA_JS CONSTANTS_JS UI_LIVE_JS');
  process.exit(2);
}

process.exitCode = 1; // An unresolved request must not silently pass this test.

const messages = [];
const requests = [];
let reconnects = 0;
let respond;
const context = {
  console, URLSearchParams, TextEncoder,
  scheduleRender() {},
  flashBanner(message) { messages.push(message); },
  forceReconnect() { ++reconnects; context.api.invalidateDeviceTarget(); },
  fetchWithTimeout(url, options, decode) {
    requests.push({ url, options });
    return new Promise((resolve, reject) => {
      respond = status => status instanceof Error ? reject(status)
        : resolve(decode({ status }));
    });
  },
  el(tag, attrs = {}, ...children) {
    children = children.filter(child => child != null);
    return { tag, attrs, children, append(...items) { children.push(...items); } };
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(constantsPath, 'utf8') + '\n' +
  fs.readFileSync(metadataPath, 'utf8') + `
  globalThis.api = { receiveDeviceTarget, invalidateDeviceTarget,
    applyRecipeTarget, recipeTargetCg, renderDeviceTarget,
    metadataNumericInputError, recipeFromMetadata, metadataPreparationParts,
    setRecipe: value => { nextShotRecipe = value; },
    current: () => deviceTargetCurrent, device: () => deviceTarget,
    pending: () => targetApplyPending };
`, context);
const api = context.api;
function packet(cg, armed, available = true, etag = '"opaque-validator"') {
  const dv = new DataView(new ArrayBuffer(4 + etag.length));
  dv.setUint16(0, cg, true);
  dv.setUint8(2, armed ? 1 : 0);
  dv.setUint8(3, available ? 1 : 0);
  for (let i = 0; i < etag.length; ++i) dv.setUint8(4 + i, etag.charCodeAt(i));
  api.receiveDeviceTarget(dv, 0);
}
function recipe(targetYieldG) {
  return { coffee: { name: 'Coffee' }, prep: { targetYieldG } };
}
function nodes(root) {
  return typeof root === 'string' ? [root]
    : [root, ...(root.children || []).flatMap(nodes)];
}
function rendered() {
  const parent = context.el('div');
  api.renderDeviceTarget(parent);
  return nodes(parent);
}

(async () => {
  api.setRecipe(recipe(36));
  assert.equal(api.recipeTargetCg(), 3600);
  await api.applyRecipeTarget();
  assert.equal(requests.length, 0, 'offline recipe must not write device');
  assert(!rendered().some(n => n.tag === 'button'), 'no action before device state arrives');
  assert(rendered().includes('Connect to sync the recipe target.'));
  assert(!rendered().some(n => typeof n === 'string' && n.includes('Last known')));
  for (const value of ['9.5', '100', '36.1', 'NaN']) {
    assert(api.metadataNumericInputError({ elements: {
      'prep.targetYieldG': { value },
    } }));
  }
  for (const value of ['', '10', '36.5', '99.5']) {
    assert.equal(api.metadataNumericInputError({ elements: {
      'prep.targetYieldG': { value },
    } }), null);
  }
  assert.equal(api.recipeFromMetadata(recipe(36)).prep.targetYieldG, 36);
  assert(api.metadataPreparationParts(recipe(36).prep).includes('36 g target'));
  packet(0, false, false);
  assert.equal(api.current(), false, 'unavailable firmware settings must not enable writes');
  assert.equal(api.device(), null);
  packet(4000, false);
  assert.equal(api.device().targetCg, 4000);
  assert.equal(api.device().armed, false);
  assert.equal(requests.length, 0, 'SSE must not apply recipe');
  assert(!Object.hasOwn(rendered().find(n => n.tag === 'button').attrs, 'disabled'),
    'an enabled Apply button must omit the HTML boolean disabled attribute');
  const pending = api.applyRecipeTarget();
  assert(api.pending());
  const applying = rendered().find(n => n.tag === 'button');
  assert.equal(applying.attrs['aria-disabled'], 'true');
  assert.equal(applying.attrs['aria-busy'], 'true');
  assert(!Object.hasOwn(applying.attrs, 'disabled'),
    'the pending Apply button must remain keyboard focusable');
  assert(applying.children.includes('Applying…'));
  await applying.attrs.onclick();
  assert.equal(requests.length, 1, 'duplicate application while pending');
  assert.deepEqual(JSON.parse(requests[0].options.body), { targetCg: 3600, armed: true });
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.equal(requests[0].options.headers['If-Match'], '"opaque-validator"');
  api.setRecipe(recipe(45));
  packet(4200, true);
  respond(204);
  await pending;
  assert.equal(api.device().targetCg, 4200, 'response overwrote newer SSE state');
  assert.equal(api.recipeTargetCg(), 4500, 'response changed edited recipe');
  assert(rendered().includes('Device alert currently set to '));
  assert(rendered().some(n => n.tag === 'span' &&
    n.attrs.class === 'device-target-warning' && n.children.includes('42 g')));
  assert(messages.at(-1).includes('Applied 36 g'));
  api.setRecipe(recipe(36));
  packet(3600, false);
  assert(rendered().includes('Device alert is currently '));
  assert(rendered().some(n => n.tag === 'span' &&
    n.attrs.class === 'device-target-warning' && n.children.includes('disabled')));
  assert(rendered().some(n => n.tag === 'button' && n.children.includes('Enable alert')));
  assert(!Object.hasOwn(rendered().find(n => n.tag === 'button').attrs, 'disabled'),
    'an enabled Enable alert button must omit the disabled attribute');
  packet(3600, true);
  assert.equal(rendered().length, 1, 'matching enabled target needs no status or action');
  api.invalidateDeviceTarget();
  assert.equal(api.current(), false);
  assert.equal(rendered().length, 1, 'a last-known enabled match needs no offline guidance');
  api.setRecipe(recipe(38));
  assert(rendered().includes('Last known device alert: 36\u00a0g'));
  assert(rendered().includes('Connect to sync the recipe target.'));
  assert(!rendered().some(n => n.tag === 'button'), 'no action for stale differing settings');
  api.setRecipe(recipe(36));
  assert.equal(rendered().length, 1, 'restoring the matching recipe hides offline guidance');
  packet(3600, false);
  api.invalidateDeviceTarget();
  assert(rendered().includes('Last known device alert: disabled'));
  assert(rendered().includes('Connect to sync the recipe target.'));
  assert(!rendered().some(n => n.tag === 'button'), 'a disabled match needs guidance but no offline action');
  await api.applyRecipeTarget();
  assert.equal(requests.length, 1);
  packet(4000, true);
  assert(rendered().some(n => n.tag === 'button' && n.children.includes('Apply recipe target')),
    'reconnection restores the applicable action');
  const conflict = api.applyRecipeTarget();
  respond(412);
  await conflict;
  assert.equal(reconnects, 0, 'a rejected apply must preserve the extraction stream');
  assert.equal(api.current(), true);
  assert.equal(requests.length, 2, 'conflict must not retry automatically');
  const retry = rendered().find(n => n.tag === 'button');
  assert.equal(retry.attrs['data-live-focus-key'], applying.attrs['data-live-focus-key']);
  assert(!retry.attrs['aria-disabled'] && !retry.attrs['aria-busy'],
    'a failed target request must leave the same action usable again');
  packet(4000, true);
  const uncertain = api.applyRecipeTarget();
  respond(new Error('timeout'));
  await uncertain;
  assert.equal(reconnects, 0, 'an unconfirmed apply must preserve the extraction stream');
  assert.equal(api.current(), true);
  assert(messages.at(-1).includes('could not be confirmed'));
  assert.equal(api.recipeTargetCg(), 3600);
  packet(4000, false);
  assert.equal(api.current(), true);
  api.setRecipe(recipe(37.1));
  await api.applyRecipeTarget();
  assert.equal(requests.length, 3, 'invalid stored target must not be applied');
  // Render the production live card: its target must come from the shot,
  // even when SSE has already changed the next-shot setting.
  Object.assign(context, {
    state: { active: true, phase: 'RUNNING', scale: 'connected' },
    inflight: { target: { targetCg: 3600, armed: true }, sampleCount: 0 },
    NO_WEIGHT_CG: -32768,
    inPumpWindow: s => s && s.active && s.phase === 'RUNNING',
    fmtG: cg => String(cg / 100),
    bigWeight: () => context.el('div'),
  });
  vm.runInContext(fs.readFileSync(livePath, 'utf8'), context);
  const live = context.el('div');
  context.renderNowCard(live);
  assert(nodes(live).includes('This shot: 36 g · alert enabled'));
  assert.equal(api.device().targetCg, 4000);
  process.exitCode = 0;
  assert.throws(() => packet(4000, true, true, 'unquoted'), /ETag/);
  assert.throws(() => packet(4000, true, true, '"bad\\nvalue"'), /ETag/);
  console.log('OK: recipe target application and device status');
})().catch(error => { console.error(error); process.exitCode = 1; });
