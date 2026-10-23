// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstdint>

#include "ble/lamarzocco/LmNotification.h"
#include "vibration/PumpSignalObservation.h"

// BrewSignalMux: turns two pump-state sources into the single
// PumpSignalObservation the ExtractionRecorder consumes.
//
//   * Machine events (La Marzocco shot counter over Bluetooth) are
//     authoritative while fresh: the machine knows exactly when the group
//     engaged, so its Brewing / stopped states beat the accelerometer's
//     0.3–0.5 s detection window. On gateway firmware that removed
//     authentication (v7.4.x era), events arrive without any token.
//   * Vibration is the fallback: whenever the machine link has no fresh
//     data (not provisioned, disconnected, or silent past the trust
//     horizon), the vibration observation passes through unchanged.
//
// The output is a coherent pump LEVEL stream plus, on machine-confirmed
// stops, a backfilled decay onset — the recorder's existing
// acceptedDecayOnsetMs channel — so pump-off lands at the event's time,
// not at the next tick.
//
// Pure logic, host-testable.
namespace pump_scale {

// Machine-link inputs, one per tick, in the host's millis() domain.
// Machine-link inputs, one per tick, in the host's millis() domain.
struct MachineState {
  bool eventsFresh = false;  // link subscribed AND last event within horizon
  bool brewing = false;      // machine currently reports a shot running
  // True when a stop (BrewingStopped / Flushed) was observed since the
  // previous tick; stopMs is that event's host-time stamp.
  bool stopEdge = false;
  uint32_t stopMs = 0;
  // True when a brewing start was observed since the previous tick;
  // startMs is the event's host-time stamp (currently informational: the
  // recorder samples levels at tick time).
  bool startEdge = false;
  uint32_t startMs = 0;
};

class BrewSignalMux {
 public:
  using MachineState = ::pump_scale::MachineState;

  // Feed one tick. `vibration` is the observation from VibrationSensor.
  // Returns the observation to hand to ExtractionRecorder::update().
  PumpSignalObservation tick(const PumpSignalObservation& vibration,
                             const MachineState& machine, uint32_t nowMs);

  // True while the machine source is authoritative (for diagnostics).
  bool machineAuthoritative() const { return _authoritative; }

 private:
  bool _authoritative = false;
  bool _machineBrewing = false;
};

// Derives the per-tick MachineState from raw link-snapshot fields. Pure, so
// the freshness horizon and stop-edge semantics live in host tests.
//
//   `freshHorizonMs` bounds how long after the last notification the machine
//   stays authoritative; idle telemetry (~15 s apart on observed gateways)
//   rides inside it, a silent link falls back to vibration past it.
//
//   Stop edges are timestamp-compared, not level-compared, so a resubscribe
//   replaying a new stop exactly once still produces exactly one edge.
struct MachineLinkDeriver {
  uint32_t lastStopSeenMs = 0;
  bool hasStopSeen = false;

  // Not const: emitting a stop edge records the stop timestamp as seen, so
  // repeated observations of the same stop do not re-edge.
  MachineState derive(uint32_t nowMs, bool subscribed, uint32_t lastEventMs,
                      bool brewing, uint32_t lastStopMs,
                      uint32_t freshHorizonMs = 20000);
};


}  // namespace pump_scale
