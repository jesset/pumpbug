// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdint>

// Parsers for the two La Marzocco cloud responses Pump Bug consumes during
// machine provisioning (see docs/lamarzocco.md):
//
//   * auth/signin — {"accessToken": "...", "refreshToken": "..."}
//   * GET /things — an array of flat device objects; Pump Bug keeps the
//     serialNumber, display name, model, bleAuthToken and
//     shotCounterSupported of each CoffeeMachine.
//
// Pure logic over the shared allocation-free JSON scanner; host-testable.
namespace lm {

struct LmSigninTokens {
  char accessToken[1024] = {};
  char refreshToken[1024] = {};
  bool ok = false;
};

// Extracts the top-level "bleAuthToken" string from a thing-settings (or
// things-list entry) document. Returns false when absent or malformed.
bool extractBleAuthToken(const char* doc, size_t len, char* out, size_t cap);

bool parseSigninResponse(const char* doc, size_t len, LmSigninTokens& out);

struct LmThingInfo {
  char serial[24] = {};
  char name[40] = {};
  char modelName[24] = {};  // e.g. "Linea Mini"
  char bleToken[96] = {};
  bool hasToken = false;
  bool shotCounterSupported = false;
};

// Parses a /things array into `out` (max `cap` entries). Returns false when
// the document is not an array; individual malformed entries are skipped.
// Non-machine devices (grinders) are skipped.
bool parseThingsList(const char* doc, size_t len, LmThingInfo* out, size_t cap,
                     size_t& count);

}  // namespace lm
