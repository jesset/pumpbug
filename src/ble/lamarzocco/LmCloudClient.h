// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <freertos/task.h>

#include <cstdint>

#include "ble/lamarzocco/LmCloudModels.h"

// One-shot La Marzocco cloud client used during machine provisioning.
//
// Given account credentials, it performs the same handshake the official
// app / pylamarzocco use (see docs/lamarzocco.md):
//
//   1. generate a per-run installation key (P-256 + derived 32-byte secret);
//   2. POST /auth/init  — register the installation's public key;
//   3. POST /auth/signin — username+password → access token;
//   4. GET  /things     — the account's machines, incl. bleAuthToken.
//
// The run happens on its own FreeRTOS task so a slow TLS round trip never
// blocks the web server. Credentials live only for the duration of the run
// and are wiped afterwards; only the returned machine token is persisted (by
// the caller, via LmMachineStore).
//
// Callers poll state():
//   Idle      — nothing ran yet, or a finished run was consumed;
//   Running   — cloud round trips in flight;
//   Done      — `machines` holds the fetched list, awaiting selection;
//   Failed    — `error` says why (network, TLS, rejected credentials, …).
namespace lm {

class LmCloudClient {
 public:
  enum class State : uint8_t { Idle, Running, Done, Failed };
  enum class Error : uint8_t {
    None = 0,
    Busy,            // a run is already active
    Offline,         // Wi-Fi STA not connected
    NoClock,         // wall clock not set: TLS cannot validate certificates
    Network,         // connection failed or timed out
    AuthRejected,    // wrong username/password (or registration refused)
    Parse,           // unexpected response body
    NoMachine,       // account has no coffee machine
  };

  static constexpr size_t kMaxMachines = 4;

  struct Result {
    State state = State::Idle;
    Error error = Error::None;
    size_t machineCount = 0;
    lm::LmThingInfo machines[kMaxMachines];
  };

  LmCloudClient();
  ~LmCloudClient();
  LmCloudClient(const LmCloudClient&) = delete;
  LmCloudClient& operator=(const LmCloudClient&) = delete;

  // Kick off a provisioning run. Returns false (and sets state Failed) when
  // another run is active or the device is not ready to reach the cloud.
  bool start(const char* username, const char* password);

  // Non-blocking state copy for the web routes.
  Result result() const;

  // Drop a finished Done/Failed result back to Idle.
  void reset();

 private:
  void _finish(State s, Error e);
  static void _taskTrampoline(void* arg);
  void _run();

  mutable SemaphoreHandle_t _mutex;
  TaskHandle_t _task = nullptr;
  Result _result;
  char _username[96] = {};
  char _password[96] = {};
};

// True when the STA link and wall clock allow a cloud run.
bool lmCloudPreconditionsOk(bool staConnected, uint32_t utcNow);

}  // namespace lm
