// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <cstdint>

#include "ble/lamarzocco/LmCloudModels.h"

// NVS-backed La Marzocco machine provisioning data: the machine's Bluetooth
// address and advertised name, plus the identity/token pair fetched from the
// cloud during setup. The mutex serializes edits and persistence.
//
// The stored token is the machine's bleAuthToken — a long-lived credential
// the cloud issues per machine. Account credentials are never stored; they
// exist only transiently during a provisioning run (see LmCloudClient).
class LmMachineStore {
 public:
  struct Machine {
    bool provisioned = false;
    uint8_t address[6] = {};
    char bleName[20] = {};   // e.g. "MINI_001234"
    char serial[24] = {};   // cloud serialNumber
    char model[24] = {};    // e.g. "Linea Mini"
    char token[96] = {};    // bleAuthToken
    bool hasToken = false;

    void formatAddress(char* out, size_t cap) const;
  };

  LmMachineStore();
  ~LmMachineStore();
  LmMachineStore(const LmMachineStore&) = delete;
  LmMachineStore& operator=(const LmMachineStore&) = delete;

  void load();
  Machine snapshot() const;

  // Persist the Bluetooth identity of the chosen machine.
  bool saveAddress(const uint8_t address[6], const char* bleName);

  // Persist the cloud identity (serial/model/token). Keeps the address when
  // already set; the two halves are gathered by separate setup steps.
  bool saveCloudIdentity(const lm::LmThingInfo& thing);

  bool clear();

 private:
  SemaphoreHandle_t _mutex;
  Machine _machine;
};
