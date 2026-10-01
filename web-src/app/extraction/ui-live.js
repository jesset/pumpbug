// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

function renderBanner() {
  // A recent one-off action message takes precedence over the status banner.
  if (bannerFlashActive()) return;
  if (protocolMismatch) {
    setBanner(protocolMismatch, 'bad');
    return;
  }
  if (!streamStateCurrent) {
    setBanner(streamStatus.text, streamStatus.cls);
    return;
  }
  if (!state) { setBanner('status · connecting…', 'status idle'); return; }
  if (state.active) {
    setBanner(`status · device live · phase ${state.phase} · scale ${state.scale}`,
              'status ' + (state.phase === 'IDLE' ? 'idle' : 'live'));
  } else {
    setBanner('status · device idle (extraction screen not foreground)',
              'status idle');
  }
}

function renderTabs(app) {
  const tabs = el('div', { class: 'tabs' },
    el('button', {
      class: view === 'live' ? 'active' : '',
      'aria-pressed': view === 'live' ? 'true' : 'false',
      onclick: () => switchView('live'),
    }, 'Live'),
    el('button', {
      class: view === 'live' ? '' : 'active',
      'aria-pressed': view === 'live' ? 'false' : 'true',
      onclick: () => switchView('list'),
    }, 'History'),
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

// One finished, graduated shot as a record card. The caller adds any material
// that follows the measurement summary, such as metadata or diagnostics.
function renderShotRecord(app, e, opts) {
  if (opts.variant !== 'live' && opts.variant !== 'detail') {
    throw new Error('unknown shot-record variant');
  }
  const detail = opts.variant === 'detail';
  const card = el('section',
    { class: 'card record' + (opts.fresh ? ' fresh' : '') });
  const head = el('h2', {}, opts.title);
  if (opts.fresh) head.append(el('span', { class: 'chip' }, 'new'));
  card.append(head);
  card.append(bigWeight(e.yieldCg, rawFinalCg(e)));
  if (!detail) {
    card.append(el('div', { class: 'record-target' },
      'target ' + targetText(e)));
  }
  card.append(el('div', { class: 'big' }, fmtMMSS(finishedElapsedMs(e) ?? 0)));
  renderCurve(RecordChart, card, e);
  const rows = recordRows(e, opts.variant);
  if (rows.childNodes.length) card.append(rows);
  app.append(card);
  return card;
}

function renderCompletedShot(app, summary, options) {
  const card = renderShotRecord(app, summary, options);
  if (summary.id) appendShotMetadataDetails(card, summary, options);
  return card;
}

// Fixed-height slot for the in-flight curve. Exists for the whole pump
// window so the layout never jumps mid-activity: before samples arrive (or
// when the scale is gone) it holds a placeholder of the same size.
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
    class: 'card now' + (pumpStopping ? ' decay' : ''),
  });
  card.append(el('h2', {},
    el('span', { class: 'livedot' + (state.active ? ' on' : '') }), 'Now'));

  let mode;
  if (pouring && state.currentYieldCg != null) {
    card.append(bigWeight(state.currentYieldCg, state.currentWeightCg));
    mode = pumpStopping ? 'yield · pump stopping' : 'yield';
  } else if (state.currentWeightCg != null) {
    card.append(bigWeight(state.currentWeightCg, null));
    mode = pumpStopping ? 'scale · pump stopping'
      : pumping ? 'scale · pump running' : 'scale';
  } else {
    card.append(bigWeight(NO_WEIGHT_CG, null));
    mode = state.active ? 'scale ' + state.scale : 'device idle';
  }
  card.append(el('div', { class: 'mode' }, mode));
  if (pumping && inflight && inflight.target) {
    card.append(el('div', { class: 'record-target' },
      'This shot: ' + targetText(inflight) + ' · alert ' +
      (inflight.target.armed ? 'enabled' : 'disabled')));
  }
  const timer = el('div', { class: 'big timer' + (pouring ? '' : ' dim') },
    pouring ? fmtTimer(liveElapsedNowMs()) : '0:00.0');
  card.append(timer);
  if (pouring) {
    liveTimerEl = timer;
    ensureLiveTimerTicker();
  } else {
    liveTimerEl = null;
  }

  if (pumping) renderLiveChartSlot(card);
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
  renderCompletedShot(app,
    shotSummaryFromRecord(lastRecord.shotId, lastRecord, lastShotMetadata), {
    variant: 'live',
    title: 'Last shot · ' + (fmtDate(lastRecord.startUtcSec) || 'time unknown'),
    fresh,
    openInHistory: true,
    shortExtractionLabel: true,
  });
}

function renderLive(app) {
  renderCoffeeContext(app);
  renderNowCard(app);
  renderLastShot(app);
}
