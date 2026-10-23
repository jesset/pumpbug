// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// Host test for the La Marzocco cloud response parsers (signin tokens and
// the /things machine list).
//
//   g++: test/test_lm_cloud_models.cpp LmCloudModels.cpp LmJson.cpp -Isrc/ble

#include <cstdio>
#include <cstring>

#include "ble/lamarzocco/LmCloudModels.h"

namespace {

int g_failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                               \
    }                                                             \
  } while (0)

void testSignin() {
  lm::LmSigninTokens t;
  CHECK(lm::parseSigninResponse(
      "{\"accessToken\":\"eyJabc.def.ghi\",\"refreshToken\":\"r1\"}", 53, t));
  CHECK(t.ok);
  CHECK(std::strcmp(t.accessToken, "eyJabc.def.ghi") == 0);
  CHECK(std::strcmp(t.refreshToken, "r1") == 0);

  CHECK(!lm::parseSigninResponse("{\"error\":\"nope\"}", 20, t));
  CHECK(!t.ok);
  CHECK(!lm::parseSigninResponse("[]", strlen("[]"), t));
}

void testThings() {
  const char doc[] =
      "[{\"serialNumber\":\"LMLM1234\",\"type\":\"CoffeeMachine\","
      "\"name\":\"Kitchen\",\"modelName\":\"Linea Mini\","
      "\"connected\":true,\"connectionDate\":1700000000000,"
      "\"coffeeStation\":null,\"imageUrl\":\"https://x/y.png\","
      "\"bleAuthToken\":\"a1b2c3d4e5\","
      "\"shotCounterSupported\":true},"
      "{\"serialNumber\":\"GR01\",\"type\":\"Grinder\","
      "\"name\":\"Pico\",\"bleAuthToken\":\"nope\"}]";
  lm::LmThingInfo things[4];
  size_t count = 0;
  CHECK(lm::parseThingsList(doc, strlen(doc), things, 4, count));
  CHECK(count == 1);  // grinder skipped
  CHECK(std::strcmp(things[0].serial, "LMLM1234") == 0);
  CHECK(std::strcmp(things[0].name, "Kitchen") == 0);
  CHECK(std::strcmp(things[0].modelName, "Linea Mini") == 0);
  CHECK(things[0].hasToken);
  CHECK(std::strcmp(things[0].bleToken, "a1b2c3d4e5") == 0);
  CHECK(things[0].shotCounterSupported);

  // A machine without a token stays selectable, flagged hasToken=false.
  const char doc2[] =
      "[{\"serialNumber\":\"GS0001\",\"modelName\":\"GS3\"}]";
  CHECK(lm::parseThingsList(doc2, strlen(doc2), things, 4, count));
  CHECK(count == 1);
  CHECK(!things[0].hasToken);

  // shotCounterSupported sent as a string ("true"), as some firmware does.
  const char doc3[] =
      "[{\"serialNumber\":\"S2\",\"shotCounterSupported\":\"true\"}]";
  CHECK(lm::parseThingsList(doc3, strlen(doc3), things, 4, count));
  CHECK(count == 1 && things[0].shotCounterSupported);

  CHECK(!lm::parseThingsList("{\"a\":1}", 7, things, 4, count));

  // Overflow caps at the provided capacity.
  const char doc4[] =
      "[{\"serialNumber\":\"A\"},{\"serialNumber\":\"B\"},"
      "{\"serialNumber\":\"C\"}]";
  CHECK(lm::parseThingsList(doc4, strlen(doc4), things, 2, count));
  CHECK(count == 2);
}

}  // namespace

int main() {
  testSignin();
  testThings();
  if (g_failures == 0) std::printf("test_lm_cloud_models OK\n");
  return g_failures == 0 ? 0 : 1;
}
