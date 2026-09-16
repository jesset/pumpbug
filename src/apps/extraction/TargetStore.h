// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include "apps/extraction/TargetSettings.h"

// NVS-backed settings. The mutex serializes edits, value comparisons and
// persistence.
class TargetStore {
 public:
  using Settings = pump_scale::TargetSettings;
  enum class Result { Applied, Conflict, Invalid, Failed };

  TargetStore();
  ~TargetStore();
  TargetStore(const TargetStore&) = delete;
  TargetStore& operator=(const TargetStore&) = delete;
  void load();
  Settings snapshot() const;
  pump_scale::TargetCoeffs coeffs() const { return snapshot().coeffs(); }

  // Compares expected values under the same lock used to commit the change.
  // No-op applications succeed without writing NVS.
  Result apply(uint16_t targetCg, bool armed, const Settings& expected);

 private:
  SemaphoreHandle_t _mutex;
  Settings _settings;
};
