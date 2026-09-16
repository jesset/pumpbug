// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "TargetStore.h"

#include <nvs.h>

#include "util/scoped_lock.h"

namespace {
constexpr const char* NS = "target";
// Settings used to be stored in separate keys, now in a single NVS value for
// atomicity. Legacy keys are read only if the current settings key is
// not found.
constexpr const char* K_SETTINGS = "settings";
constexpr const char* K_LEGACY_TARGET = "targetCg";
constexpr const char* K_LEGACY_ARMED = "armed";
}  // namespace

TargetStore::TargetStore() : _mutex(xSemaphoreCreateMutex()) {
  configASSERT(_mutex);
}
TargetStore::~TargetStore() { vSemaphoreDelete(_mutex); }

void TargetStore::load() {
  ScopedLock lock(_mutex);
  if (_settings.available) return;
  nvs_handle_t handle;
  const esp_err_t opened = nvs_open(NS, NVS_READONLY, &handle);
  Settings loaded;
  if (opened == ESP_OK) {
    uint32_t packed = 0;
    esp_err_t error = nvs_get_u32(handle, K_SETTINGS, &packed);
    if (error == ESP_OK) {
      loaded.targetCg = packed & 0xffff;
      loaded.armed = (packed & 0x10000) != 0;
    } else if (error == ESP_ERR_NVS_NOT_FOUND) {
      error = nvs_get_u16(handle, K_LEGACY_TARGET, &loaded.targetCg);
      if (error == ESP_OK || error == ESP_ERR_NVS_NOT_FOUND) {
        uint8_t enabled = 0;
        error = nvs_get_u8(handle, K_LEGACY_ARMED, &enabled);
        loaded.armed = enabled != 0;
      }
    }
    nvs_close(handle);
    if (error != ESP_OK && error != ESP_ERR_NVS_NOT_FOUND) return;
  } else if (opened != ESP_ERR_NVS_NOT_FOUND) {
    return;
  }
  _settings = loaded;
  if (!Settings::valid(_settings.targetCg, _settings.armed)) {
    _settings.targetCg = 0;
    _settings.armed = false;
  }
  _settings.available = true;
}

TargetStore::Settings TargetStore::snapshot() const {
  ScopedLock lock(_mutex);
  return _settings;
}

TargetStore::Result TargetStore::apply(uint16_t targetCg, bool armed,
                                       const Settings& expected) {
  ScopedLock lock(_mutex);
  if (!_settings.available) return Result::Failed;
  if (!Settings::valid(targetCg, armed) ||
      !Settings::valid(expected.targetCg, expected.armed))
    return Result::Invalid;
  if (!_settings.sameValues(expected)) return Result::Conflict;
  if (_settings.targetCg == targetCg && _settings.armed == armed)
    return Result::Applied;
  nvs_handle_t handle;
  if (nvs_open(NS, NVS_READWRITE, &handle) != ESP_OK) return Result::Failed;
  const uint32_t value = targetCg | (armed ? 0x10000u : 0u);
  esp_err_t error = nvs_set_u32(handle, K_SETTINGS, value);
  if (error == ESP_OK) error = nvs_commit(handle);
  nvs_close(handle);
  if (error != ESP_OK) return Result::Failed;
  _settings.targetCg = targetCg;
  _settings.armed = armed;
  return Result::Applied;
}
