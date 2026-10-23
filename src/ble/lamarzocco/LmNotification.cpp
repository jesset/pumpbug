// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "LmNotification.h"

#include <cstring>

#include "LmJson.h"

namespace lm {

namespace {

bool keyIs(const lm::json::Member& m, const char* k) {
  return m.keyLen == strlen(k) && memcmp(m.key, k, m.keyLen) == 0;
}

bool copyStrCheck(char* dst, size_t cap, const lm::json::Member& m) {
  return lm::json::unescapeInto(m.value, m.valueLen, dst, cap);
}

bool numToFloat(const lm::json::Member& m, float& out) {
  double d = 0.0;
  if (!lm::json::parseNumber(m.value, m.valueLen, d)) return false;
  out = static_cast<float>(d);
  return true;
}

}  // namespace

void LmBrewingData::merge(const LmBrewingData& later) {
  if (later.hasStartedDose) {
    hasStartedDose = true;
    strncpy(startedDoseIndex, later.startedDoseIndex, sizeof(startedDoseIndex) - 1);
    startedDoseIndex[sizeof(startedDoseIndex) - 1] = '\0';
  }
  if (later.hasEv) { hasEv = true; ev = later.ev; }
  if (later.hasBackflush) { hasBackflush = true; backflush = later.backflush; }
  if (later.hasTimer) { hasTimer = true; timerS = later.timerS; }
  if (later.hasStoppedTime) {
    hasStoppedTime = true;
    stoppedTimeS = later.stoppedTimeS;
  }
  if (later.hasStoppedDose) {
    hasStoppedDose = true;
    strncpy(stoppedDoseIndex, later.stoppedDoseIndex, sizeof(stoppedDoseIndex) - 1);
    stoppedDoseIndex[sizeof(stoppedDoseIndex) - 1] = '\0';
  }
  if (later.hasStopType) {
    hasStopType = true;
    strncpy(stopType, later.stopType, sizeof(stopType) - 1);
    stopType[sizeof(stopType) - 1] = '\0';
  }
  if (later.hasStopReason) {
    hasStopReason = true;
    strncpy(stopReason, later.stopReason, sizeof(stopReason) - 1);
    stopReason[sizeof(stopReason) - 1] = '\0';
  }
  if (later.hasFlushStoppedTime) {
    hasFlushStoppedTime = true;
    flushStoppedTimeS = later.flushStoppedTimeS;
  }
  if (later.hasFlushStoppedDose) {
    hasFlushStoppedDose = true;
    strncpy(flushStoppedDoseIndex, later.flushStoppedDoseIndex,
            sizeof(flushStoppedDoseIndex) - 1);
    flushStoppedDoseIndex[sizeof(flushStoppedDoseIndex) - 1] = '\0';
  }
}

bool parseNotification(const char* doc, size_t len, LmBrewingData& brewing,
                       LmTelemetry& telemetry) {
  brewing = LmBrewingData{};
  telemetry = LmTelemetry{};
  lm::json::Cursor c(doc, len, /*object=*/true);
  bool any = false;
  bool ok = true;
  while (c.next()) {
    const lm::json::Member& m = c.member();
    any = true;
    if (m.kind == lm::json::Kind::Null) continue;
    if (keyIs(m, "BrewingStartedGroup1DoseIndex") &&
        m.kind == lm::json::Kind::String) {
      brewing.hasStartedDose = copyStrCheck(brewing.startedDoseIndex,
                                            sizeof(brewing.startedDoseIndex), m);
    } else if (keyIs(m, "BrewingUpdateGroup1Time") &&
               m.kind == lm::json::Kind::Number) {
      brewing.hasTimer = numToFloat(m, brewing.timerS);
    } else if (keyIs(m, "BrewingUpdateGroup1Ev") &&
               m.kind == lm::json::Kind::Bool) {
      brewing.hasEv = lm::json::parseBool(m.value, m.valueLen, brewing.ev);
    } else if (keyIs(m, "BrewingUpdateGroup1Backflush") &&
               m.kind == lm::json::Kind::Bool) {
      brewing.hasBackflush =
          lm::json::parseBool(m.value, m.valueLen, brewing.backflush);
    } else if (keyIs(m, "BrewingStoppedGroup1Time") &&
               m.kind == lm::json::Kind::Number) {
      brewing.hasStoppedTime =
          numToFloat(m, brewing.stoppedTimeS);
    } else if (keyIs(m, "BrewingStoppedGroup1DoseIndex") &&
               m.kind == lm::json::Kind::String) {
      brewing.hasStoppedDose = copyStrCheck(brewing.stoppedDoseIndex,
                                            sizeof(brewing.stoppedDoseIndex), m);
    } else if (keyIs(m, "BrewingStoppedGroup1StopType") &&
               m.kind == lm::json::Kind::String) {
      brewing.hasStopType = copyStrCheck(brewing.stopType,
                                         sizeof(brewing.stopType), m);
    } else if (keyIs(m, "BrewingStoppedGroup1StopReason") &&
               m.kind == lm::json::Kind::String) {
      brewing.hasStopReason = copyStrCheck(brewing.stopReason,
                                           sizeof(brewing.stopReason), m);
    } else if (keyIs(m, "FlushStoppedGroup1Time") &&
               m.kind == lm::json::Kind::Number) {
      brewing.hasFlushStoppedTime =
          numToFloat(m, brewing.flushStoppedTimeS);
    } else if (keyIs(m, "FlushStoppedGroup1DoseIndex") &&
               m.kind == lm::json::Kind::String) {
      brewing.hasFlushStoppedDose =
          copyStrCheck(brewing.flushStoppedDoseIndex,
                       sizeof(brewing.flushStoppedDoseIndex), m);
    } else if (keyIs(m, "CoffeeBoiler1UpdateTemperature") &&
               m.kind == lm::json::Kind::Number) {
      telemetry.hasCoffeeBoilerC =
          numToFloat(m, telemetry.coffeeBoilerC);
    } else if (keyIs(m, "SteamBoilerUpdateTemperature") &&
               m.kind == lm::json::Kind::Number) {
      telemetry.hasSteamBoilerC =
          numToFloat(m, telemetry.steamBoilerC);
    } else if (keyIs(m, "MachineMode") &&
               m.kind == lm::json::Kind::String) {
      telemetry.hasMachineMode = copyStrCheck(telemetry.machineMode,
                                              sizeof(telemetry.machineMode), m);
    }
    // Unknown keys (MachineStatistics, HeatingCoeff, Group2/3 on multi-group
    // machines) are skipped by the cursor.
  }
  ok = !c.failed() && any;
  return ok;
}

bool LmBrewingTracker::process(const LmBrewingData& msg, Update& out) {
  if (msg.hasStartedDose) {
    // A new shot or flush started; anything pending belongs to it.
    reset();
  }
  _data.merge(msg);

  out = Update{};
  if (_data.hasStoppedTime || _data.hasStoppedDose || _data.hasStopType ||
      _data.hasStopReason || (_data.hasEv && !_data.ev)) {
    out.state = LmBrewState::BrewingStopped;
    out.finalShotTimeS = _data.stoppedTimeS;
    strncpy(out.stopReason, _data.stopReason, sizeof(out.stopReason) - 1);
    out.stopReason[sizeof(out.stopReason) - 1] = '\0';
  } else if (_data.hasFlushStoppedTime || _data.hasFlushStoppedDose) {
    out.state = LmBrewState::Flushed;
    out.finalShotTimeS = _data.flushStoppedTimeS;
  } else if (_data.hasBackflush && _data.backflush) {
    out.state = LmBrewState::Backflushing;
  } else if (_data.hasStartedDose ||
             (_data.hasEv && _data.ev && _data.hasTimer)) {
    out.state = LmBrewState::Brewing;
    out.timerS = _data.timerS;
    strncpy(out.startedDoseIndex, _data.startedDoseIndex,
            sizeof(out.startedDoseIndex) - 1);
    out.startedDoseIndex[sizeof(out.startedDoseIndex) - 1] = '\0';
  } else {
    return false;
  }

  if (out.state == LmBrewState::Flushed ||
      out.state == LmBrewState::BrewingStopped) {
    reset();
  }
  return true;
}

}  // namespace lm
