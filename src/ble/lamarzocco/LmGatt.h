// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// La Marzocco machine link — the BleScaleService-side implementation lives in
// BleScaleService.{h,cpp}; this translation unit only carries the GATT
// identifiers so tests and callers can reference them without the service.
#pragma once

#include <cstddef>
#include <cstdint>

namespace lm {

// Gateway GATT service (advertised by MINI_*/MICRA_*/LINEA_*/GS3_* devices).
// The gateway exposes ONE of two services depending on its mode:
//   d30a… — operational mode (claimed by the app/cloud; token-gated)
//   d10a… — connection/pairing mode (paddle-left boot; notifications open)
constexpr const char* kServiceUuid = "d30a7847-e12b-09a8-b04b-8e0922a9abab";
constexpr const char* kPairingServiceUuid = "d10a7847-e12b-09a8-b04b-8e0922a9abab";
// Shot-counter notifications (the machine's brew events + telemetry).
constexpr const char* kShotCounterUuid = "0e0b7847-e12b-09a8-b04b-8e0922a9abab";
// Authentication characteristic — REMOVED by gateway firmware v7.4.x; kept
// here for documentation and for gateways that still have it.
constexpr const char* kAuthUuid = "0d0b7847-e12b-09a8-b04b-8e0922a9abab";
// Token read characteristic — readable only in pairing mode, and not on
// gateways that dropped token issuance (observed null on v7.4.2, Linea Mini).
constexpr const char* kTokenUuid = "0c0b7847-e12b-09a8-b04b-8e0922a9abab";

// True for gateway BLE names (LINEA_LMX0421, MINI_xxx, MICRA_xxx, GS3AV_x,
// …). Single source for discovery filtering; host-tested.
inline bool isLaMarzoccoName(const char* name) {
  if (name == nullptr || name[0] == '\0') return false;
  static const char* kPrefixes[] = {"MICRA_", "MINI_", "LINEA_", "LINEAR_",
                                    "GS3_",  "GS3AV_", "GS3MP_"};
  for (const char* p : kPrefixes) {
    for (size_t i = 0;; i++) {
      if (p[i] == '\0') return true;
      if (name[i] != p[i]) break;
    }
  }
  return false;
}

}  // namespace lm
