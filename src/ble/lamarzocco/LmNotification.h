// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdint>

// Decoding of the La Marzocco Bluetooth "shot counter" notifications and the
// brewing-state machine behind them.
//
// The machine pushes small flat JSON objects over characteristic
// 0e0b7847-… (see docs/lamarzocco.md). One notification carries either a
// brewing update (Brewing*/FlushStopped* keys) or a telemetry value (boiler
// temperature, machine mode); the two never interact. This module splits the
// document into those two parts and runs the brewing part through the same
// merge/derive state machine pylamarzocco's _BrewingTracker implements, so
// Pump Bug and Home Assistant agree on when a shot starts, stops, or was only
// a flush.
//
// Pure logic: no Arduino, NimBLE, or cJSON dependency, host-testable.
namespace lm {

enum class LmBrewState : uint8_t {
  None,             // no brewing information in the notification
  Brewing,          // the group is running (dose started or timer ticking)
  BrewingStopped,   // a shot ended
  Flushed,          // a flush ended
  Backflushing,     // a cleaning backflush is running
};

// The brewing part of one notification. "has*" flags distinguish "absent"
// from a present-but-false value; merge() overrides only present fields.
struct LmBrewingData {
  bool hasStartedDose = false;
  char startedDoseIndex[24] = {};

  bool hasEv = false;
  bool ev = false;

  bool hasBackflush = false;
  bool backflush = false;

  bool hasTimer = false;
  float timerS = 0.0f;

  bool hasStoppedTime = false;
  float stoppedTimeS = 0.0f;
  bool hasStoppedDose = false;
  char stoppedDoseIndex[24] = {};
  bool hasStopType = false;
  char stopType[20] = {};
  bool hasStopReason = false;
  char stopReason[20] = {};

  bool hasFlushStoppedTime = false;
  float flushStoppedTimeS = 0.0f;
  bool hasFlushStoppedDose = false;
  char flushStoppedDoseIndex[24] = {};

  bool empty() const {
    return !(hasStartedDose || hasEv || hasBackflush || hasTimer ||
             hasStoppedTime || hasStoppedDose || hasStopType || hasStopReason ||
             hasFlushStoppedTime || hasFlushStoppedDose);
  }

  // Field-wise override: every field present in `later` wins.
  void merge(const LmBrewingData& later);
};

// Telemetry values that can ride along in any notification.
struct LmTelemetry {
  bool hasCoffeeBoilerC = false;
  float coffeeBoilerC = 0.0f;
  bool hasSteamBoilerC = false;
  float steamBoilerC = 0.0f;
  bool hasMachineMode = false;
  char machineMode[20] = {};  // "BrewingMode" | "StandBy" | "EcoMode" | …

  bool empty() const {
    return !hasCoffeeBoilerC && !hasSteamBoilerC && !hasMachineMode;
  }
};

// Parse one notification payload (NUL-padding already stripped by the
// transport). Returns false when the document is not a JSON object or a
// needed value is malformed; unknown keys are ignored.
bool parseNotification(const char* doc, size_t len, LmBrewingData& brewing,
                       LmTelemetry& telemetry);

// Turns the stream of brewing notifications into state updates. Port of
// pylamarzocco's _BrewingTracker:
//   * a BrewingStarted notification resets any pending state (a new shot or
//     flush began);
//   * notifications merge field-wise until a state can be derived;
//   * a derived Flushed or BrewingStopped state is emitted once, then the
//     tracker resets.
class LmBrewingTracker {
 public:
  struct Update {
    LmBrewState state = LmBrewState::None;
    float timerS = 0.0f;       // Brewing: the machine's own brew timer
    float finalShotTimeS = 0.0f;  // BrewingStopped: total shot duration
    char startedDoseIndex[24] = {};
    char stopReason[20] = {};
  };

  // Feed one notification. Returns true (and fills `out`) when a brewing
  // state can be derived from the merged data; false when the notification
  // carried no complete brewing information yet.
  bool process(const LmBrewingData& msg, Update& out);

  void reset() { _data = LmBrewingData{}; }
  const LmBrewingData& pending() const { return _data; }

 private:
  LmBrewingData _data;
};

}  // namespace lm
