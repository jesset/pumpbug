// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// Host test for the La Marzocco shot-counter notification codec, including
// the brewing-state tracker. Payloads below are taken verbatim from a capture
// of a Linea Micra (pylamarzocco tests/fixtures/machine/
// shot_counter_2026-10-05.txt); the Linea Mini uses the same Group1 format.
//
//   g++: test/test_lm_notification.cpp LmNotification.cpp LmJson.cpp -Isrc/ble

#include <cstdio>
#include <cstring>

#include "ble/lamarzocco/LmNotification.h"

namespace {

int g_failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                               \
    }                                                             \
  } while (0)

lm::LmBrewingData brew(const char* json) {
  lm::LmBrewingData b;
  lm::LmTelemetry t;
  lm::parseNotification(json, strlen(json), b, t);
  return b;
}

bool hasState(lm::LmBrewingTracker& tr, const char* json,
              lm::LmBrewState want, lm::LmBrewingTracker::Update* got = nullptr) {
  lm::LmBrewingTracker::Update u;
  const bool any = tr.process(brew(json), u);
  if (got != nullptr) *got = u;
  return any && u.state == want;
}

void testParseSplit() {
  lm::LmBrewingData b;
  lm::LmTelemetry t;

  const char* s1 = "{\"BrewingStartedGroup1DoseIndex\":\"ContinuousDose\"}";
  CHECK(lm::parseNotification(s1, strlen(s1), b, t));
  CHECK(b.hasStartedDose);
  CHECK(std::strcmp(b.startedDoseIndex, "ContinuousDose") == 0);
  CHECK(b.empty() == false);
  CHECK(t.empty());

  const char* s2 =
      "{\"BrewingUpdateGroup1Time\":12.727,\"BrewingUpdateGroup1Ev\":true,"
      "\"BrewingUpdateGroup1Backflush\":false}";
  CHECK(lm::parseNotification(s2, strlen(s2), b, t));
  CHECK(b.hasTimer && b.timerS > 12.72f && b.timerS < 12.74f);
  CHECK(b.hasEv && b.ev);
  CHECK(b.hasBackflush && !b.backflush);

  const char* s3 = "{\"SteamBoilerUpdateTemperature\":130}";
  CHECK(lm::parseNotification(s3, strlen(s3), b, t));
  CHECK(b.empty());
  CHECK(t.hasSteamBoilerC && t.steamBoilerC == 130.0f);

  const char* s4 = "{\"MachineMode\":\"BrewingMode\"}";
  CHECK(lm::parseNotification(s4, strlen(s4), b, t));
  CHECK(t.hasMachineMode && std::strcmp(t.machineMode, "BrewingMode") == 0);

  // Unknown/nested keys are skipped without failing the document.
  const char* s5 =
      "{\"MachineStatistics\":\"{\\\"tot_doses\\\":2123}\","
      "\"CoffeeBoiler1UpdateTemperature\":95.5}";
  CHECK(lm::parseNotification(s5, strlen(s5), b, t));
  CHECK(t.hasCoffeeBoilerC && t.coffeeBoilerC == 95.5f);
  CHECK(b.empty());

  const char* s6 = "[1,2]";
  CHECK(!lm::parseNotification(s6, strlen(s6), b, t));
  const char* s7 = "nope";
  CHECK(!lm::parseNotification(s7, strlen(s7), b, t));
}

void testTrackerShot() {
  lm::LmBrewingTracker tr;
  lm::LmBrewingTracker::Update u;

  // Captured sequence: start → timer ticks → stopped with reason.
  CHECK(hasState(tr,
                 "{\"BrewingStartedGroup1DoseIndex\":\"ContinuousDose\"}",
                 lm::LmBrewState::Brewing, &u));
  CHECK(std::strcmp(u.startedDoseIndex, "ContinuousDose") == 0);

  CHECK(hasState(tr,
                 "{\"BrewingUpdateGroup1Time\":0.108,"
                 "\"BrewingUpdateGroup1Ev\":true,"
                 "\"BrewingUpdateGroup1Backflush\":false}",
                 lm::LmBrewState::Brewing));
  CHECK(hasState(tr, "{\"BrewingUpdateGroup1Time\":5.479}",
                 lm::LmBrewState::Brewing, &u));
  CHECK(u.timerS > 5.4f && u.timerS < 5.6f);

  CHECK(hasState(tr,
                 "{\"BrewingStoppedGroup1StopType\":\"Continuous\","
                 "\"BrewingStoppedGroup1StopReason\":\"Manual\","
                 "\"BrewingStoppedGroup1DoseIndex\":\"ContinuousDose\","
                 "\"BrewingStoppedGroup1Time\":12.727}",
                 lm::LmBrewState::BrewingStopped, &u));
  CHECK(u.finalShotTimeS > 12.7f && u.finalShotTimeS < 12.8f);
  CHECK(std::strcmp(u.stopReason, "Manual") == 0);

  // After a stop the tracker is reset: telemetry produces nothing.
  CHECK(!hasState(tr, "{\"BrewingUpdateGroup1Ev\":true}",
                  lm::LmBrewState::Brewing));
  // ...and starting alone requires either a dose index or a timer.
  lm::LmBrewingTracker::Update u2;
  CHECK(!tr.process(brew("{\"BrewingUpdateGroup1Ev\":true}"), u2));
}

void testTrackerFlushAndBackflush() {
  {
    lm::LmBrewingTracker tr;
    // A short manual flush: start → one timer sample → FlushStopped.
    CHECK(hasState(tr,
                   "{\"BrewingStartedGroup1DoseIndex\":\"ContinuousDose\"}",
                   lm::LmBrewState::Brewing));
    CHECK(hasState(tr, "{\"FlushStoppedGroup1DoseIndex\":\"ContinuousDose\","
                       "\"FlushStoppedGroup1Time\":1.891}",
                   lm::LmBrewState::Flushed));
  }
  {
    lm::LmBrewingTracker tr;
    CHECK(hasState(tr, "{\"BrewingUpdateGroup1Backflush\":true}",
                   lm::LmBrewState::Backflushing));
    // A new start resets the pending backflush flag.
    CHECK(hasState(tr,
                   "{\"BrewingStartedGroup1DoseIndex\":\"DoseA\","
                   "\"BrewingUpdateGroup1Backflush\":false}",
                   lm::LmBrewState::Brewing));
  }
}

void testEvFalseStops() {
  lm::LmBrewingTracker tr;
  CHECK(hasState(tr,
                 "{\"BrewingStartedGroup1DoseIndex\":\"DoseA\"}",
                 lm::LmBrewState::Brewing));
  // ev:false alone means the group released.
  CHECK(hasState(tr, "{\"BrewingUpdateGroup1Ev\":false}",
                 lm::LmBrewState::BrewingStopped));
}

void testMergeAcrossSplits() {
  // The stop notification in the wild arrives as one document, but trackers
  // must merge partial fields across notifications in any split.
  lm::LmBrewingTracker tr;
  CHECK(hasState(tr,
                 "{\"BrewingStartedGroup1DoseIndex\":\"DoseB\"}",
                 lm::LmBrewState::Brewing));
  CHECK(hasState(tr, "{\"BrewingUpdateGroup1Time\":2.5}",
                 lm::LmBrewState::Brewing));
  CHECK(hasState(tr, "{\"BrewingStoppedGroup1Time\":3.5}",
                 lm::LmBrewState::BrewingStopped));
}


void testSessionTelemetryInterleaved() {
  // A full session with boiler telemetry between brewing updates; telemetry
  // must never disturb the brewing state machine.
  lm::LmBrewingTracker tr;
  lm::LmBrewingTracker::Update u;

  CHECK(hasState(tr,
                 "{\"BrewingStartedGroup1DoseIndex\":\"DoseB\"}",
                 lm::LmBrewState::Brewing, &u));
  CHECK(std::strcmp(u.startedDoseIndex, "DoseB") == 0);
  CHECK(hasState(tr, "{\"SteamBoilerUpdateTemperature\":128}",
                 lm::LmBrewState::Brewing));
  CHECK(hasState(tr, "{\"BrewingUpdateGroup1Time\":3.3,\"BrewingUpdateGroup1Ev\":true}",
                 lm::LmBrewState::Brewing, &u));
  CHECK(u.timerS > 3.2f && u.timerS < 3.4f);
  CHECK(hasState(tr, "{\"MachineMode\":\"BrewingMode\"}",
                 lm::LmBrewState::Brewing));
  CHECK(hasState(tr, "{\"BrewingStoppedGroup1DoseIndex\":\"DoseB\",\"BrewingStoppedGroup1Time\":9.5}",
                 lm::LmBrewState::BrewingStopped, &u));
  CHECK(u.finalShotTimeS > 9.4f && u.finalShotTimeS < 9.6f);
  // Telemetry after the stop leaves the tracker idle.
  CHECK(!hasState(tr, "{\"CoffeeBoiler1UpdateTemperature\":93.0}",
                  lm::LmBrewState::Brewing));
}

void testBackflushThenShot() {
  // Cleaning backflush, then a real shot right after: independent records.
  lm::LmBrewingTracker tr;
  CHECK(hasState(tr, "{\"BrewingUpdateGroup1Backflush\":true}",
                 lm::LmBrewState::Backflushing));
  CHECK(hasState(tr, "{\"BrewingStoppedGroup1StopReason\":\"Manual\",\"BrewingUpdateGroup1Ev\":false}",
                 lm::LmBrewState::BrewingStopped));
  CHECK(hasState(tr, "{\"BrewingStartedGroup1DoseIndex\":\"ContinuousDose\"}",
                 lm::LmBrewState::Brewing));
  CHECK(hasState(tr, "{\"BrewingUpdateGroup1Time\":1.0,\"BrewingUpdateGroup1Ev\":true}",
                 lm::LmBrewState::Brewing));
  CHECK(hasState(tr, "{\"FlushStoppedGroup1Time\":1.9}",
                 lm::LmBrewState::Flushed));
  // The real shot after the flush.
  CHECK(hasState(tr, "{\"BrewingStartedGroup1DoseIndex\":\"DoseA\"}",
                 lm::LmBrewState::Brewing));
}

void testTwoShotsInARow() {
  // Shot 1 ends; shot 2 starts from a clean slate; the dose index of shot 2
  // must not inherit shot 1's.
  lm::LmBrewingTracker tr;
  lm::LmBrewingTracker::Update u;
  CHECK(hasState(tr, "{\"BrewingStartedGroup1DoseIndex\":\"DoseA\"}",
                 lm::LmBrewState::Brewing));
  CHECK(hasState(tr, "{\"BrewingStoppedGroup1Time\":27.5,\"BrewingStoppedGroup1StopReason\":\"Programmed\"}",
                 lm::LmBrewState::BrewingStopped, &u));
  CHECK(std::strcmp(u.stopReason, "Programmed") == 0);
  CHECK(hasState(tr, "{\"BrewingStartedGroup1DoseIndex\":\"DoseC\"}",
                 lm::LmBrewState::Brewing, &u));
  CHECK(std::strcmp(u.startedDoseIndex, "DoseC") == 0);
}

}  // namespace

int main() {
  testParseSplit();
  testTrackerShot();
  testTrackerFlushAndBackflush();
  testEvFalseStops();
  testMergeAcrossSplits();
  testSessionTelemetryInterleaved();
  testBackflushThenShot();
  testTwoShotsInARow();
  if (g_failures == 0) std::printf("test_lm_notification OK\n");
  return g_failures == 0 ? 0 : 1;
}
