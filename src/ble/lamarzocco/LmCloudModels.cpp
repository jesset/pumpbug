// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "LmCloudModels.h"

#include <cstring>

#include "LmJson.h"

namespace lm {

namespace {

bool keyIs(const lm::json::Member& m, const char* k) {
  return m.keyLen == strlen(k) && memcmp(m.key, k, m.keyLen) == 0;
}

}  // namespace

bool parseSigninResponse(const char* doc, size_t len, LmSigninTokens& out) {
  out = LmSigninTokens{};
  lm::json::Cursor c(doc, len, /*object=*/true);
  while (c.next()) {
    const lm::json::Member& m = c.member();
    if (m.kind != lm::json::Kind::String) continue;
    if (keyIs(m, "accessToken")) {
      out.ok = out.ok ||
               lm::json::unescapeInto(m.value, m.valueLen, out.accessToken,
                                      sizeof(out.accessToken));
    } else if (keyIs(m, "refreshToken")) {
      lm::json::unescapeInto(m.value, m.valueLen, out.refreshToken,
                             sizeof(out.refreshToken));
    }
  }
  if (c.failed()) out.ok = false;
  out.ok = out.ok && out.accessToken[0] != '\0';
  return out.ok;
}

bool parseThingsList(const char* doc, size_t len, LmThingInfo* out, size_t cap,
                     size_t& count) {
  count = 0;
  lm::json::Cursor arr(doc, len, /*object=*/false);
  if (arr.failed()) return false;
  bool ok = true;
  while (arr.next() && count < cap) {
    const lm::json::Member& m = arr.member();
    if (m.kind != lm::json::Kind::Object) continue;
    lm::json::Cursor obj(m.value, m.valueLen, /*object=*/true);
    LmThingInfo t;
    bool isMachine = false;  // default keep: older payloads omit "type"
    bool isGrinder = false;
    bool valid = true;
    while (obj.next()) {
      const lm::json::Member& f = obj.member();
      if (keyIs(f, "serialNumber") && f.kind == lm::json::Kind::String) {
        valid = valid && lm::json::unescapeInto(f.value, f.valueLen, t.serial,
                                                sizeof(t.serial));
      } else if (keyIs(f, "name") && f.kind == lm::json::Kind::String) {
        lm::json::unescapeInto(f.value, f.valueLen, t.name, sizeof(t.name));
      } else if (keyIs(f, "modelName") && f.kind == lm::json::Kind::String) {
        lm::json::unescapeInto(f.value, f.valueLen, t.modelName,
                               sizeof(t.modelName));
      } else if (keyIs(f, "bleAuthToken") &&
                 f.kind == lm::json::Kind::String) {
        t.hasToken = lm::json::unescapeInto(f.value, f.valueLen, t.bleToken,
                                            sizeof(t.bleToken));
      } else if (keyIs(f, "shotCounterSupported")) {
        bool b = false;
        if (lm::json::parseBool(f.value, f.valueLen, b)) {
          t.shotCounterSupported = b;
        } else if (f.kind == lm::json::Kind::String) {
          t.shotCounterSupported =
              f.valueLen == 4 && memcmp(f.value, "true", 4) == 0;
        }
      } else if (keyIs(f, "type") && f.kind == lm::json::Kind::String) {
        // "CoffeeMachine" vs "Grinder"; anything else keeps the default.
        isGrinder = f.valueLen == 7 && memcmp(f.value, "Grinder", 7) == 0;
        isMachine = f.valueLen == 13 &&
                    memcmp(f.value, "CoffeeMachine", 13) == 0;
      }
      // connected / connectionDate / imageUrl / coffeeStation (object) etc.
      // are skipped by the cursor.
    }
    if (obj.failed()) valid = false;
    if (!valid || isGrinder || t.serial[0] == '\0') continue;
    (void)isMachine;
    out[count++] = t;
  }
  if (arr.failed()) ok = false;
  return ok;
}


bool extractBleAuthToken(const char* doc, size_t len, char* out, size_t cap) {
  lm::json::Cursor c(doc, len, /*object=*/true);
  while (c.next()) {
    const lm::json::Member& m = c.member();
    if (m.kind == lm::json::Kind::String && m.keyLen == 12 &&
        memcmp(m.key, "bleAuthToken", 12) == 0) {
      return lm::json::unescapeInto(m.value, m.valueLen, out, cap);
    }
  }
  return false;
}

}  // namespace lm
