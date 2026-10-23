// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// Host test for the La Marzocco gateway-name matcher used by discovery.
// LINEA_LMX0421 is the typical Linea Mini name; the rest cover the name
// patterns from Home Assistant's lamarzocco manifest.
//
//   g++ -std=c++17 -Wall -Wextra -Isrc test/test_lm_gatt.cpp -o /tmp/test_lm_gatt

#include <cstdio>
#include <cstring>

#include "ble/lamarzocco/LmGatt.h"

namespace {

int g_failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                               \
    }                                                             \
  } while (0)

void testMatches() {
  CHECK(lm::isLaMarzoccoName("LINEA_LMX0421"));  // user's machine
  CHECK(lm::isLaMarzoccoName("MINI_001234"));
  CHECK(lm::isLaMarzoccoName("MICRA_MX000123"));
  CHECK(lm::isLaMarzoccoName("LINEAR_0042"));
  CHECK(lm::isLaMarzoccoName("GS3_00123"));
  CHECK(lm::isLaMarzoccoName("GS3AV_0123"));
  CHECK(lm::isLaMarzoccoName("GS3MP_0123"));
}

void testNonMatches() {
  // Prefix must be whole (a "LINEA_" device, not any LINEA* text).
  CHECK(!lm::isLaMarzoccoName("LINEARX_1"));
  CHECK(!lm::isLaMarzoccoName("ACAIAL11EE5"));    // the Acaia scale
  CHECK(!lm::isLaMarzoccoName("BRAVIA 4K GB ATV3"));
  CHECK(!lm::isLaMarzoccoName("Uniti Star"));
  CHECK(!lm::isLaMarzoccoName("MINI"));           // prefix without separator
  CHECK(!lm::isLaMarzoccoName(""));
  CHECK(!lm::isLaMarzoccoName(nullptr));
}

void testShortNameSafety() {
  // Names shorter than a prefix must not read past their NUL.
  CHECK(!lm::isLaMarzoccoName("M"));
  CHECK(!lm::isLaMarzoccoName("MI"));
  CHECK(!lm::isLaMarzoccoName("GS3"));
  CHECK(lm::isLaMarzoccoName("GS3_"));
}

}  // namespace

int main() {
  testMatches();
  testNonMatches();
  testShortNameSafety();
  if (g_failures == 0) std::printf("test_lm_gatt OK\n");
  return g_failures == 0 ? 0 : 1;
}
