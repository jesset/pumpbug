// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include <nvs.h>

#include <cassert>

#include "apps/extraction/TargetStore.h"

using Result = TargetStore::Result;

static Result apply(TargetStore& store, uint16_t cg, bool armed) {
  return store.apply(cg, armed, store.snapshot());
}

int main() {
  pump_scale::TargetSettings settings;
  assert(settings.etag() == "\"target-0-0\"");
  settings.targetCg = 4000;
  assert(settings.etag() == "\"target-4000-0\"");
  settings.armed = true;
  assert(settings.etag() == "\"target-4000-1\"");
  settings.available = true;
  assert(settings.etag() == "\"target-4000-1\"");
  testNvs.reset();
  TargetStore store;
  store.load();
  const auto empty = store.snapshot();
  assert(empty.targetCg == 0 && !empty.armed && empty.available);
  assert(apply(store, 3600, true) == Result::Applied);
  assert(testNvs.value("target", "settings") == (3600 | 0x10000));
  assert(store.apply(4000, true, empty) == Result::Conflict);
  const auto saved = store.snapshot();
  testNvs.nextWriteError = ESP_FAIL;
  assert(apply(store, 3600, true) == Result::Applied);
  assert(testNvs.nextWriteError ==
         ESP_FAIL);  // No-op did not attempt NVS write.
  testNvs.nextWriteError = ESP_OK;
  assert(apply(store, 999, true) == Result::Invalid);
  assert(apply(store, 3601, true) == Result::Invalid);
  assert(apply(store, 10000, true) == Result::Invalid);
  assert(apply(store, 0, true) == Result::Invalid);
  testNvs.nextWriteError = ESP_FAIL;
  assert(apply(store, 4000, false) == Result::Failed);
  assert(store.snapshot().sameValues(saved));
  testNvs.nextCommitError = ESP_FAIL;
  assert(apply(store, 4000, false) == Result::Failed);
  assert(store.snapshot().sameValues(saved));
  assert(testNvs.value("target", "settings") == (3600 | 0x10000));
  TargetStore reboot;
  reboot.load();
  assert(reboot.snapshot().sameValues(saved));
  // Rebooting with the same values does not invalidate the expectation.
  assert(reboot.apply(4000, true, saved) == Result::Applied);
  // Changing away and back is also acceptable: only current values matter.
  assert(apply(reboot, 3600, true) == Result::Applied);
  assert(reboot.apply(4000, true, saved) == Result::Applied);
  assert(apply(reboot, 3600, false) == Result::Applied);
  // Enablement alone differs from the saved expectation.
  assert(reboot.apply(4000, true, saved) == Result::Conflict);
  // Matching desired values cannot bypass a mismatched expectation.
  assert(reboot.apply(3600, false, saved) == Result::Conflict);
  assert(apply(reboot, 3600, false) == Result::Applied);
  assert(!reboot.snapshot().armed);
  assert(apply(reboot, 0, false) == Result::Applied);

  testNvs.reset();
  testNvs.values["target"]["targetCg"] = {TestNvsType::U16, 4250};
  testNvs.values["target"]["armed"] = {TestNvsType::U8, 1};
  TargetStore legacy;
  legacy.load();
  const auto legacySettings = legacy.snapshot();
  assert(legacySettings.targetCg == 4250 && legacySettings.armed);
  assert(apply(legacy, 4300, true) == Result::Applied);
  TargetStore migrated;
  migrated.load();
  assert(migrated.snapshot().targetCg == 4300);
  testNvs.nextReadError = ESP_FAIL;
  TargetStore failedLoad;
  failedLoad.load();
  assert(!failedLoad.snapshot().available);
  assert(apply(failedLoad, 3600, true) == Result::Failed);
  failedLoad.load();
  assert(failedLoad.snapshot().targetCg == 4300);
}
