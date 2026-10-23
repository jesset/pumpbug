// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "LmMachineStore.h"

#include <nvs.h>

#include <cstdio>
#include <cstring>

#include "util/scoped_lock.h"

namespace {
constexpr const char* NS = "lmmach";
constexpr const char* K_ADDR = "addr";
constexpr const char* K_NAME = "name";
constexpr const char* K_SERIAL = "serial";
constexpr const char* K_MODEL = "model";
constexpr const char* K_TOKEN = "token";
}  // namespace

LmMachineStore::LmMachineStore() : _mutex(xSemaphoreCreateMutex()) {
  configASSERT(_mutex);
}

LmMachineStore::~LmMachineStore() { vSemaphoreDelete(_mutex); }

void LmMachineStore::Machine::formatAddress(char* out, size_t cap) const {
  if (cap < 18) return;
  std::snprintf(out, cap, "%02X:%02X:%02X:%02X:%02X:%02X", address[0],
                address[1], address[2], address[3], address[4], address[5]);
}

void LmMachineStore::load() {
  ScopedLock lock(_mutex);
  nvs_handle_t handle;
  if (nvs_open(NS, NVS_READONLY, &handle) != ESP_OK) return;
  Machine m;
  size_t len = sizeof(m.address);
  if (nvs_get_blob(handle, K_ADDR, m.address, &len) != ESP_OK) {
    nvs_close(handle);
    return;
  }
  m.provisioned = true;
  size_t slen = sizeof(m.bleName);
  if (nvs_get_str(handle, K_NAME, m.bleName, &slen) != ESP_OK) m.bleName[0] = '\0';
  slen = sizeof(m.serial);
  if (nvs_get_str(handle, K_SERIAL, m.serial, &slen) != ESP_OK) m.serial[0] = '\0';
  slen = sizeof(m.model);
  if (nvs_get_str(handle, K_MODEL, m.model, &slen) != ESP_OK) m.model[0] = '\0';
  slen = sizeof(m.token);
  m.hasToken = nvs_get_str(handle, K_TOKEN, m.token, &slen) == ESP_OK &&
               m.token[0] != '\0';
  nvs_close(handle);
  _machine = m;
}

LmMachineStore::Machine LmMachineStore::snapshot() const {
  ScopedLock lock(_mutex);
  return _machine;
}

bool LmMachineStore::saveAddress(const uint8_t address[6], const char* bleName) {
  ScopedLock lock(_mutex);
  nvs_handle_t handle;
  if (nvs_open(NS, NVS_READWRITE, &handle) != ESP_OK) return false;
  bool ok = nvs_set_blob(handle, K_ADDR, address, 6) == ESP_OK &&
            nvs_set_str(handle, K_NAME, bleName) == ESP_OK &&
            nvs_commit(handle) == ESP_OK;
  nvs_close(handle);
  if (ok) {
    memcpy(_machine.address, address, 6);
    strncpy(_machine.bleName, bleName, sizeof(_machine.bleName) - 1);
    _machine.bleName[sizeof(_machine.bleName) - 1] = '\0';
    _machine.provisioned = true;
  }
  return ok;
}

bool LmMachineStore::saveCloudIdentity(const lm::LmThingInfo& thing) {
  ScopedLock lock(_mutex);
  nvs_handle_t handle;
  if (nvs_open(NS, NVS_READWRITE, &handle) != ESP_OK) return false;
  bool ok = nvs_set_str(handle, K_SERIAL, thing.serial) == ESP_OK &&
            nvs_set_str(handle, K_MODEL, thing.modelName) == ESP_OK;
  if (thing.hasToken) {
    ok = ok && nvs_set_str(handle, K_TOKEN, thing.bleToken) == ESP_OK;
  }
  ok = ok && nvs_commit(handle) == ESP_OK;
  nvs_close(handle);
  if (ok) {
    strncpy(_machine.serial, thing.serial, sizeof(_machine.serial) - 1);
    _machine.serial[sizeof(_machine.serial) - 1] = '\0';
    strncpy(_machine.model, thing.modelName, sizeof(_machine.model) - 1);
    _machine.model[sizeof(_machine.model) - 1] = '\0';
    if (thing.hasToken) {
      strncpy(_machine.token, thing.bleToken, sizeof(_machine.token) - 1);
      _machine.token[sizeof(_machine.token) - 1] = '\0';
      _machine.hasToken = true;
    }
  }
  return ok;
}

bool LmMachineStore::clear() {
  ScopedLock lock(_mutex);
  nvs_handle_t handle;
  if (nvs_open(NS, NVS_READWRITE, &handle) != ESP_OK) return false;
  const bool ok = nvs_erase_all(handle) == ESP_OK && nvs_commit(handle) == ESP_OK;
  nvs_close(handle);
  if (ok) _machine = Machine{};
  return ok;
}
