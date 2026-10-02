// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include <M5Unified.h>

#include <cassert>

#include "power/PowerEventLog.h"
#include "power/PowerSavingPolicy.h"
#include "util/power.h"

TestM5 M5;

namespace {
unsigned long nowMs = 0;
bool externalPower = false;
unsigned sleepEvents = 0;

void reset() {
  nowMs = 0;
  externalPower = false;
  sleepEvents = 0;
  M5 = {};
}

void testSleepTimerResetPreservesDimmingSchedule() {
  reset();
  power::PowerEventLog log;
  power::PowerSavingPolicy policy(log);

  nowMs = 50000;
  policy.resetSleepTimer();
  policy.update();
  assert(!policy.isScreenDimmed());
  assert(M5.Display.brightnessChanges == 0);

  nowMs = 60001;
  policy.update();
  assert(policy.isScreenDimmed());
  assert(M5.Display.brightness == 1);

  nowMs = 250000;
  policy.resetSleepTimer();
  policy.update();
  assert(policy.isScreenDimmed());
  assert(M5.Display.brightnessChanges == 1);

  nowMs = 300001;
  policy.update();
  assert(M5.Power.shutdowns == 0);
  nowMs = 550000;
  policy.update();
  assert(M5.Power.shutdowns == 0);
  nowMs = 550001;
  policy.update();
  assert(M5.Power.shutdowns == 1);
  assert(sleepEvents == 1);
}

void testDeviceActivityRestoresBrightnessAndResetsBothTimers() {
  reset();
  power::PowerEventLog log;
  power::PowerSavingPolicy policy(log);

  nowMs = 60001;
  policy.update();
  assert(policy.isScreenDimmed());

  nowMs = 100000;
  policy.resetIdleTimers();
  assert(!policy.isScreenDimmed());
  assert(M5.Display.brightness == 128);
  nowMs = 160000;
  policy.update();
  assert(!policy.isScreenDimmed());
  nowMs = 160001;
  policy.update();
  assert(policy.isScreenDimmed());
  nowMs = 400000;
  policy.update();
  assert(M5.Power.shutdowns == 0);
  nowMs = 400001;
  policy.update();
  assert(M5.Power.shutdowns == 1);
}

void testExternalPowerExtendsOnlySleep() {
  reset();
  power::PowerEventLog log;
  power::PowerSavingPolicy policy(log);
  externalPower = true;

  nowMs = 300001;
  policy.update();
  assert(M5.Power.shutdowns == 0);
  nowMs = 300002;
  policy.update();
  assert(policy.isScreenDimmed());

  externalPower = false;
  nowMs = 600001;
  policy.update();
  assert(M5.Power.shutdowns == 0);
  nowMs = 600002;
  policy.update();
  assert(M5.Power.shutdowns == 1);
}

void testSleepTimerResetDoesNotBlockExplicitShutdown() {
  reset();
  power::PowerEventLog log;
  power::PowerSavingPolicy policy(log);
  externalPower = true;
  policy.resetSleepTimer();
  assert(policy.shutdown());
  assert(M5.Power.shutdowns == 1);
}
}  // namespace

unsigned long millis() { return nowMs; }
void testM5LogInfo(const char*, ...) {}
void testM5LogWarning(const char*, ...) {}
void testM5LogError(const char*, ...) {}

namespace power {
// Event recording is stubbed below, so the log needs no mutex.
PowerEventLog::PowerEventLog() = default;
BatteryStatus getBatteryStatus() {
  return {80, 4000, externalPower, ChargingState::NotCharging};
}
void logBatteryStatus() {}
void recordSleepEvent(PowerEventLog&) { ++sleepEvents; }
bool enableWakeUpOnMotionAndShutdown() {
  M5.Power.powerOff();
  return true;
}
bool disableWakeUpOnMotion() { return true; }
}  // namespace power

int main() {
  testSleepTimerResetPreservesDimmingSchedule();
  testDeviceActivityRestoresBrightnessAndResetsBothTimers();
  testExternalPowerExtendsOnlySleep();
  testSleepTimerResetDoesNotBlockExplicitShutdown();
}
