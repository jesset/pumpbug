// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

function renderConnectionStatus() {
  let label = 'Connected';
  let kind = 'connected';
  let detail;
  if (protocolMismatch) {
    label = 'Incompatible';
    kind = 'bad';
    detail = protocolMismatch;
  } else if (!streamStateCurrent || !state) {
    label = streamStatus.label;
    kind = streamStatus.kind;
    detail = streamStatus.detail;
  } else {
    const activity = !state.active ? 'Extraction screen is not open'
      : state.phase === 'RUNNING' ? 'Recording'
      : state.phase === 'POST_PUMP' ? 'Finishing recording' : 'Device ready';
    detail = activity + ' · Scale ' + state.scale;
    if (state.active && state.scale !== 'connected') {
      label = 'Scale ' + state.scale;
      kind = 'warn';
    } else if (state.active && state.phase === 'RUNNING') {
      label = 'Recording';
    } else if (state.active && state.phase === 'POST_PUMP') {
      label = 'Finishing';
    } else if (!state.active) {
      label = 'Device idle';
      kind = 'idle';
    }
  }
  const connection = document.getElementById('connection');
  connection.dataset.kind = kind;
  const text = document.getElementById('connection-label');
  if (text.textContent !== label) text.textContent = label;
  const description = document.getElementById('connection-detail');
  if (description.textContent !== detail) description.textContent = detail;
}

function renderBanner() {
  renderConnectionStatus();
  // A recent one-off action message takes precedence over the status banner.
  if (bannerFlashActive()) return;
  if (protocolMismatch) {
    setBanner(protocolMismatch, 'bad');
  } else if (!streamStateCurrent &&
      (streamStatus.kind === 'bad' || streamStatus.kind === 'warn')) {
    setBanner(streamStatus.detail, 'status ' + streamStatus.kind, streamStatus.action);
  } else {
    setBanner(null, 'idle');
  }
}

function renderTabs(app) {
  const tabs = el('div', { class: 'tabs' },
    el('button', {
      class: view === 'live' ? 'active' : '',
      'data-view-focus-key': 'live-tab',
      'aria-pressed': view === 'live' ? 'true' : 'false',
      onclick: () => switchView('live', { fromTab: true }),
    }, uiIcon('live'), 'Live'),
    el('button', {
      class: view === 'live' ? '' : 'active',
      'data-view-focus-key': 'history-tab',
      'aria-pressed': view === 'live' ? 'false' : 'true',
      onclick: () => switchView('list', { fromTab: true }),
    }, uiIcon('history'), 'History'),
  );
  app.append(tabs);
}

function targetText(e) {
  return e.target.targetCg > 0 ? fmtG(e.target.targetCg) + ' g' : 'none';
}

// Finished-shot summary rows. The Live view keeps only an unusual end cause;
// History includes target, the cut-alert outcome, and time under pump.
function recordRows(e, variant) {
  const rows = el('dl', { class: 'rows' });
  if (variant === 'detail') {
    rows.append(row('target', targetText(e)));
    rows.append(row('cut alert', fmtCutAlert(e)));
  }
  if (e.endCause in END_CAUSE_LABEL) {
    rows.append(row('ended', END_CAUSE_LABEL[e.endCause]));
  }
  if (variant === 'detail') {
    rows.append(row('pump time', fmtSec(e.totalPumpOnMs) + ' s'));
  }
  return rows;
}

// Diagnostics, folded away by default: raw enums, counts, the internal raw
// weights, and the graduation evidence. Off the product view but one click
// away for debugging.
function techFold(e) {
  let pumpOff = null;
  for (const event of e.events || []) {
    if (event.kind === 3 && event.tMs === e.lastPumpOffConfirmedMs) {
      pumpOff = event;
    }
  }
  const hasDecayEstimate = pumpOff && pumpOff.signalDecayOnsetMs != null;
  const pumpTransition = e.version < 7
    ? 'not recorded (EXTR v6)'
    : hasDecayEstimate ? 'signal decay → confirmed' : 'confirmation only';
  const tech = el('dl', { class: 'rows' },
    row('phase', PHASE[e.phase] ?? e.phase),
    row('endCause', END_CAUSE[e.endCause] ?? e.endCause),
    row('yield', fmtG(e.yieldCg) + ' g'),
    row('startRaw', (e.startRawCg != null && e.startRawCg !== NO_WEIGHT_CG)
      ? fmtG(e.startRawCg) + ' g' : '—'),
    row('settledRaw', fmtG(e.settledRawCg) + ' g'),
    row('samples', `${e.sampleCount} (observed ${e.observedSampleCount})`),
    row('events', String(e.eventCount)),
    row('event trace', (e.flags & 0x01) !== 0 ? 'incomplete' : 'complete'),
    row('EXTR version', String(e.version)),
    row('pump transition', pumpTransition),
    ...(hasDecayEstimate
      ? [row('confirmation delay',
          fmtSec(pumpOff.signalDecayLeadMs) + ' s')]
      : []),
    row('pourMs', String(e.pourMs)),
    row('decisionGain', fmtG(e.decisionGainCg) + ' g'),
    row('startUtcSec', fmtDate(e.startUtcSec) ||
      (e.startUtcSec ? String(e.startUtcSec) : 'unknown')),
  );
  return el('details', { class: 'tech' },
    el('summary', {}, 'Technical'), tech);
}

// The pour curve, mounted under `parent`. No-op until the first sample.
// For an in-flight shot (endMs == 0) the time axis runs to the live elapsed;
// for a finished one it runs to the recorded end.
function renderCurve(chart, parent, e) {
  if (e.sampleCount <= 0) return;
  const lastTms = e.samples.length ? e.samples[e.samples.length - 1].tMs : e.beginMs;
  const lastEventTms = e.events.length ? e.events[e.events.length - 1].tMs : e.beginMs;
  const stateTms = (state && state.elapsedMs != null) ? e.beginMs + state.elapsedMs : 0;
  const endTms = e.endMs;
  const nowMs = endTms > 0
    ? Math.max(endTms, lastTms, lastEventTms)
    : Math.max(stateTms, lastTms, lastEventTms);
  chart.mount(parent);
  chart.update(e, nowMs);
}

// Reserve space for the in-flight chart and its labels throughout the pump
// window, including while waiting for samples or the scale.
function renderLiveChartSlot(card) {
  const slot = el('div', { class: 'chartslot' });
  if (inflight && inflight.sampleCount > 0) {
    renderCurve(LiveChart, slot, inflight);
  } else {
    slot.append(el('p', { class: 'empty' },
      state.scale === 'connected' ? 'waiting for samples…'
                                  : 'waiting for scale…'));
  }
  card.append(slot);
}

// The pouring timer ticks locally between rate-limited STATE packets: each
// STATE anchors elapsedMs to its receipt time, and a light interval patches
// just the timer text so the tenths run smoothly without full re-renders.
// Extrapolation stops once packets go stale (TIMER_EXTRAPOLATE_MAX_MS), so a
// paused replay or a dropped stream shows the device's last reported time
// rather than a timer that keeps counting.
let liveTimerEl = null;
let liveTimerTicker = 0;
function liveElapsedNowMs() {
  const base = state.elapsedMs || 0;
  if (state.rxAtMs == null) return base;
  const age = performance.now() - state.rxAtMs;
  return age < TIMER_EXTRAPOLATE_MAX_MS ? base + age : base;
}
function ensureLiveTimerTicker() {
  if (liveTimerTicker) return;
  liveTimerTicker = setInterval(() => {
    if (view === 'live' && state.pouring && liveTimerEl) {
      liveTimerEl.textContent = fmtTimer(liveElapsedNowMs());
    } else {
      clearInterval(liveTimerTicker);
      liveTimerTicker = 0;
    }
  }, 100);
}

// The Now card shows live measurements rather than a stored result. It displays
// raw scale weight while idle or pumping without a pour, and self-tared yield
// during a pour. pumpDecayCandidate adds a temporary cue that pump-signal decay
// may have begun before pump-off is confirmed.
function renderNowCard(app) {
  const pumping = inPumpWindow(state);
  const pouring = state.pouring;
  const pumpStopping = state.active && state.phase === 'RUNNING' &&
    state.pumpDecayCandidate;

  const card = el('section', {
    class: 'card now' + (pumping ? '' : ' idle') + (pumpStopping ? ' decay' : ''),
  });
  const heading = el('h2', {},
    el('span', { class: 'livedot' + (state.active ? ' on' : '') }), 'Now');
  if (pumping && state.phase === 'RUNNING') {
    heading.append(el('span', { class: 'now-pump-status' },
      pumpStopping ? 'Pump stopping' : 'Pump running'));
  }
  let weight;
  let mode;
  if (pouring && state.currentYieldCg != null) {
    weight = bigWeight(state.currentYieldCg, state.currentWeightCg);
    mode = 'yield';
  } else if (state.currentWeightCg != null) {
    weight = bigWeight(state.currentWeightCg, null);
    mode = 'scale';
  } else {
    weight = bigWeight(NO_WEIGHT_CG, null);
    mode = state.active ? 'scale ' + state.scale : 'device idle';
  }
  const label = el('div', { class: 'mode' }, mode);
  if (!pumping) {
    liveTimerEl = null;
    card.append(el('div', {}, heading, label), weight);
    app.append(card);
    return;
  }
  const timer = el('div', { class: 'big timer' + (pouring ? '' : ' dim') },
    pouring ? fmtTimer(liveElapsedNowMs()) : '0:00.0');
  card.append(heading, el('div', { class: 'now-measurements' },
    el('div', {}, label, weight),
    el('div', {}, el('div', { class: 'mode' }, 'Time'), timer)));
  if (inflight && inflight.target) {
    card.append(el('div', { class: 'record-target' },
      'This shot: ' + targetText(inflight) + ' · alert ' +
      (inflight.target.armed ? 'enabled' : 'disabled')));
  }
  if (pouring) {
    liveTimerEl = timer;
    ensureLiveTimerTicker();
  } else {
    liveTimerEl = null;
  }

  renderLiveChartSlot(card);
  app.append(card);
}

// The Last Shot card: the device's Last Shot record (FINAL_RECORD — the last
// graduated pull or a loaded stored shot), so a flush or grinder dose can
// never appear here. Collapses to a tap-to-expand header while the pump
// window is live so the pour owns the screen.
function renderLastShot(app) {
  if (!lastRecord) return;
  if (inPumpWindow(state) && !lastShotExpanded) {
    app.append(el('section', {
      class: 'card record collapsed',
      onclick: () => { lastShotExpanded = true; scheduleRender(); },
    }, '▸ last shot · ' + fmtG(lastRecord.yieldCg) + ' g · '
       + fmtMMSS(finishedElapsedMs(lastRecord) ?? 0)));
    return;
  }
  const fresh = freshFinalizedAt > 0 &&
      Date.now() - freshFinalizedAt < FRESH_SHOT_BADGE_MS &&
      lastRecord.beginMs === freshBeginMs;
  const summary = shotSummaryFromRecord(lastRecord.shotId, lastRecord, lastShotMetadata);
  const data = shotSummaryData(summary);
  const card = el('section', { class: 'card record last-shot' + (fresh ? ' fresh' : '') });
  const head = el('h2', {}, 'Last shot');
  if (fresh) head.append(el('span', { class: 'chip' }, 'new'));
  card.append(head, shotDate(summary));
  const identity = shotCoffeeIdentity(summary.id, data);
  if (identity) {
    identity.className += ' last-shot-coffee';
    if (data.coffee.roastDate) identity.append(el('div', { class: 'coffee-roast-date' },
      'Roasted ' + data.coffee.roastDate));
    card.append(identity);
  }
  card.append(shotMetrics(summary));
  appendPreparationDetails(card, data.prep);
  renderCurve(RecordChart, card, summary);
  const rows = recordRows(summary, 'live');
  if (rows.childNodes.length) card.append(rows);
  appendShotResult(card, data);
  // Recipe details may never load, so keep the recorded device alert visible.
  if (summary.target?.targetCg !== Math.round((data.prep.targetYieldG ?? 0) * 100) ||
      !summary.target?.armed) {
    card.append(el('div', { class: 'last-shot-alert' },
      'Device alert: ' + (summary.target?.armed ? targetText(summary) : 'disabled')));
  }
  if (summary.id) {
    appendShotMetadataStatus(card, data.record);
    const actions = shotMetadataActions(summary, { openInHistory: true });
    if (actions.childNodes.length) card.append(actions);
  }
  app.append(card);
}

function renderLive(app) {
  renderNowCard(app);
  renderCoffeeContext(app);
  renderLastShot(app);
}
