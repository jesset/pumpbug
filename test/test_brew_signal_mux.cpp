// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// Host test for pump_scale::BrewSignalMux: machine-authoritative brewing
// signal with vibration fallback, stop backfill through the decay-onset
// channel, and clean handoff between the two sources.
//
//   g++ -std=c++17 -Wall -Wextra -Isrc test/test_brew_signal_mux.cpp src/ble/lamarzocco/BrewSignalMux.cpp -o /tmp/test_brew_signal_mux

#include <cstdio>

#include "ble/lamarzocco/BrewSignalMux.h"

namespace {

int g_failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                               \
    }                                                             \
  } while (0)

using pump_scale::BrewSignalMux;

BrewSignalMux::MachineState fresh(bool brewing) {
  BrewSignalMux::MachineState m;
  m.eventsFresh = true;
  m.brewing = brewing;
  return m;
}

PumpSignalObservation vib(PumpSignalState s) {
  PumpSignalObservation o;
  o.state = s;
  return o;
}

void testFallsBackWhenStale() {
  BrewSignalMux mux;
  // Not fresh: vibration passes through untouched, including decay hints.
  PumpSignalObservation v = vib(PumpSignalState::On);
  v.hasAcceptedDecayOnset = true;
  v.acceptedDecayOnsetMs = 1234;
  BrewSignalMux::MachineState stale;
  const PumpSignalObservation out = mux.tick(v, stale, 10'000);
  CHECK(!mux.machineAuthoritative());
  CHECK(out.state == PumpSignalState::On);
  CHECK(out.hasAcceptedDecayOnset);
  CHECK(out.acceptedDecayOnsetMs == 1234);
}

void testMachineAuthoritative() {
  BrewSignalMux mux;
  // Vibration says off, machine says brewing: machine wins.
  PumpSignalObservation out = mux.tick(vib(PumpSignalState::Off), fresh(true),
                                       10'000);
  CHECK(mux.machineAuthoritative());
  CHECK(out.state == PumpSignalState::On);
  CHECK(!out.hasAcceptedDecayOnset);  // no vibration decay leakage

  // Steady brewing continues even if vibration claims off.
  out = mux.tick(vib(PumpSignalState::Off), fresh(true), 10'100);
  CHECK(out.state == PumpSignalState::On);

  // Steady idle while machine idle.
  out = mux.tick(vib(PumpSignalState::On), fresh(false), 10'200);
  CHECK(out.state == PumpSignalState::Off);
}

void testStopBackfill() {
  BrewSignalMux mux;
  mux.tick(vib(PumpSignalState::Off), fresh(true), 20'000);
  BrewSignalMux::MachineState m = fresh(false);
  m.stopEdge = true;
  m.stopMs = 20'345;
  const PumpSignalObservation out = mux.tick(vib(PumpSignalState::On), m,
                                             20'400);
  CHECK(out.state == PumpSignalState::Off);
  CHECK(out.hasAcceptedDecayOnset);
  CHECK(out.acceptedDecayOnsetMs == 20'345);
  // The decay hint does not repeat on the next tick.
  const PumpSignalObservation out2 = mux.tick(vib(PumpSignalState::Off),
                                              fresh(false), 20'500);
  CHECK(!out2.hasAcceptedDecayOnset);
}

void testHandoffOnStale() {
  BrewSignalMux mux;
  mux.tick(vib(PumpSignalState::Off), fresh(true), 30'000);
  // Link drops mid-shot: the mux must fall back to vibration immediately,
  // and not hold a stale machine-brewing level.
  const PumpSignalObservation out = mux.tick(vib(PumpSignalState::On),
                                             BrewSignalMux::MachineState{},
                                             30'100);
  CHECK(!mux.machineAuthoritative());
  CHECK(out.state == PumpSignalState::On);
}

void testStaleVibrationDecayDoesNotLeak() {
  BrewSignalMux mux;
  // Vibration carries a decay candidate; the machine is authoritative and
  // brewing — the candidate must be dropped, not forwarded.
  PumpSignalObservation v = vib(PumpSignalState::Off);
  v.hasAcceptedDecayOnset = true;
  v.acceptedDecayOnsetMs = 999;
  const PumpSignalObservation out = mux.tick(v, fresh(true), 40'000);
  CHECK(out.state == PumpSignalState::On);
  CHECK(!out.hasAcceptedDecayOnset);
}

}  // namespace


// ---- MachineLinkDeriver -----------------------------------------------------

void testDeriverFreshness() {
  pump_scale::MachineLinkDeriver d;
  // Subscribed, event 5 s ago: fresh.
  auto m = d.derive(100'000, true, 95'000, false, 0);
  CHECK(m.eventsFresh);
  // Exactly at the horizon: stale (strict less-than).
  m = d.derive(120'000, true, 100'000, false, 0);
  CHECK(!m.eventsFresh);
  // Not subscribed: never fresh, even with a recent event.
  m = d.derive(100'000, false, 99'999, true, 0);
  CHECK(!m.eventsFresh);
  // No event ever: never fresh.
  m = d.derive(100'000, true, 0, true, 0);
  CHECK(!m.eventsFresh);
  // Idle telemetry keeps the link fresh across ~15 s gaps.
  m = d.derive(100'000, true, 88'000, false, 0);
  CHECK(m.eventsFresh);
}

void testDeriverStopEdgeOnce() {
  pump_scale::MachineLinkDeriver d;
  auto m = d.derive(100'000, true, 100'000, false, 77'000);
  CHECK(m.stopEdge);
  CHECK(m.stopMs == 77'000);
  // Same timestamp on later ticks: no repeat edge.
  m = d.derive(100'100, true, 100'000, false, 77'000);
  CHECK(!m.stopEdge);
  m = d.derive(100'200, true, 100'000, false, 77'000);
  CHECK(!m.stopEdge);
  // A NEW stop (resubscribe + next shot) edges again.
  m = d.derive(200'000, true, 200'000, false, 199'000);
  CHECK(m.stopEdge);
  CHECK(m.stopMs == 199'000);
}

void testDeriverRealShotTimeline() {
  // A realistic sequence: idle telemetry, shot start, ticks, stop, then idle
  // telemetry continues. The mux + deriver combined must hand the recorder
  // ON during brewing and OFF with backfill at the stop.
  pump_scale::MachineLinkDeriver d;
  BrewSignalMux mux;

  // t=50k: idle telemetry (subscribed, recent event, not brewing).
  auto ms = d.derive(50'000, true, 50'000, false, 0);
  auto out = mux.tick(vib(PumpSignalState::Off), ms, 50'000);
  CHECK(out.state == PumpSignalState::Off);

  // t=60k: shot starts. (Vibration may not have caught it yet.)
  ms = d.derive(60'000, true, 60'000, true, 0);
  out = mux.tick(vib(PumpSignalState::Off), ms, 60'000);
  CHECK(out.state == PumpSignalState::On);

  // t=65k: mid-shot, vibration disagrees (window flap): machine wins.
  ms = d.derive(65'000, true, 65'000, true, 0);
  out = mux.tick(vib(PumpSignalState::Off), ms, 65'000);
  CHECK(out.state == PumpSignalState::On);

  // t=72.345s: stop event timestamped; observed at t=72.4s.
  ms = d.derive(72'400, true, 72'400, false, 72'345);
  out = mux.tick(vib(PumpSignalState::On), ms, 72'400);
  CHECK(out.state == PumpSignalState::Off);
  CHECK(out.hasAcceptedDecayOnset);
  CHECK(out.acceptedDecayOnsetMs == 72'345);

  // t=80k: idle telemetry resumes; stays off, no repeated decay hint.
  ms = d.derive(80'000, true, 80'000, false, 72'345);
  out = mux.tick(vib(PumpSignalState::Off), ms, 80'000);
  CHECK(out.state == PumpSignalState::Off);
  CHECK(!out.hasAcceptedDecayOnset);
}

void testDeriverLinkDropMidShot() {
  pump_scale::MachineLinkDeriver d;
  BrewSignalMux mux;
  // Brewing under machine authority...
  auto ms = d.derive(10'000, true, 10'000, true, 0);
  mux.tick(vib(PumpSignalState::On), ms, 10'000);
  // ...then the link goes silent past the horizon while vibration still
  // sees the pump: fallback must be immediate at the level stream.
  ms = d.derive(31'000, true, 10'000, true, 0);
  const auto out = mux.tick(vib(PumpSignalState::On), ms, 31'000);
  CHECK(!mux.machineAuthoritative());
  CHECK(out.state == PumpSignalState::On);
  CHECK(!out.hasAcceptedDecayOnset);
}

int main() {
  testFallsBackWhenStale();
  testMachineAuthoritative();
  testStopBackfill();
  testHandoffOnStale();
  testStaleVibrationDecayDoesNotLeak();
  testDeriverFreshness();
  testDeriverStopEdgeOnce();
  testDeriverRealShotTimeline();
  testDeriverLinkDropMidShot();
  if (g_failures == 0) std::printf("test_brew_signal_mux OK\n");
  return g_failures == 0 ? 0 : 1;
}
