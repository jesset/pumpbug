// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "ble/lamarzocco/BrewSignalMux.h"

namespace pump_scale {

MachineState MachineLinkDeriver::derive(uint32_t nowMs, bool subscribed,
                                       uint32_t lastEventMs, bool brewing,
                                       uint32_t lastStopMs,
                                       uint32_t freshHorizonMs) {
  MachineState m;
  m.eventsFresh = subscribed && lastEventMs != 0 &&
                  static_cast<int32_t>(nowMs - lastEventMs) <
                      static_cast<int32_t>(freshHorizonMs);
  m.brewing = brewing;
  if (lastStopMs != 0 && (!hasStopSeen || lastStopMs != lastStopSeenMs)) {
    m.stopEdge = true;
    m.stopMs = lastStopMs;
    hasStopSeen = true;
    lastStopSeenMs = lastStopMs;
  }
  return m;
}

PumpSignalObservation BrewSignalMux::tick(const PumpSignalObservation& vibration,
                                          const MachineState& machine,
                                          uint32_t nowMs) {
  (void)nowMs;  // reserved for horizon arithmetic driven by the caller
  // Decay candidates from the vibration path must not leak into
  // machine-authored observations; a stale decay flag would let the recorder
  // back-date a stop the machine never reported.
  if (!machine.eventsFresh) {
    _authoritative = false;
    _machineBrewing = false;
    return vibration;
  }

  _authoritative = true;

  if (machine.stopEdge) {
    // A stop event is definitive: report pump off with the event time as
    // the accepted decay onset so the recorder's pump-off lands there.
    _machineBrewing = false;
    PumpSignalObservation out;
    out.state = PumpSignalState::Off;
    out.acceptedDecayOnsetMs = machine.stopMs;
    out.hasAcceptedDecayOnset = true;
    return out;
  }

  // Steady state: the machine's brewing level is authoritative.
  _machineBrewing = machine.brewing;
  PumpSignalObservation out;
  out.state = _machineBrewing ? PumpSignalState::On : PumpSignalState::Off;
  return out;
}

}  // namespace pump_scale
