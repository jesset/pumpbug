// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "TargetRoutes.h"

#include <cJSON.h>

#include <cmath>
#include <limits>
#include <memory>

#include "TargetStore.h"
#include "net/HttpServer.h"
#include "net/JsonStream.h"
#include "net/http_request_validation.h"
#include "net/http_response_util.h"
#include "util/json_validate.h"

namespace pump_scale {
namespace {
constexpr size_t kMaxTargetJsonBytes = 256;
}  // namespace

void registerTargetRoutes(HttpServer& http, TargetStore& store) {
  http.registerApp(
      "extraction",
      {{"/target", HTTP_GET,
        [&store](WebServer& s) {
          s.sendHeader("Cache-Control", "no-store");
          const auto target = store.snapshot();
          if (!target.available) {
            http::sendJsonError(s, 503, "Target settings unavailable");
            return;
          }
          s.sendHeader("ETag", target.etag().c_str());
          JsonStream body(s);
          body.open()
              .key("targetCg")
              .u(target.targetCg)
              .key("armed")
              .boolean(target.armed)
              .close();
          body.finish();
        }},
       {"/target", HTTP_POST, [&store](WebServer& s) {
          s.sendHeader("Cache-Control", "no-store");
          String body;
          if (!http::requireJsonRequestBody(s, kMaxTargetJsonBytes, body))
            return;
          String ifMatch;
          if (!http::requireIfMatch(s, ifMatch)) return;
          if (json::validateObject(body.c_str(), body.length(),
                                   kMaxTargetJsonBytes,
                                   2) != json::ObjectValidationResult::Valid) {
            http::sendJsonError(s, 400, "Invalid target JSON");
            return;
          }
          std::unique_ptr<cJSON, decltype(&cJSON_Delete)> document(
              cJSON_Parse(body.c_str()), cJSON_Delete);
          const cJSON* target =
              cJSON_GetObjectItemCaseSensitive(document.get(), "targetCg");
          const cJSON* armed =
              cJSON_GetObjectItemCaseSensitive(document.get(), "armed");
          if (!cJSON_IsNumber(target) || !cJSON_IsBool(armed) ||
              cJSON_GetArraySize(document.get()) != 2 ||
              !std::isfinite(target->valuedouble) || target->valuedouble < 0 ||
              target->valuedouble > std::numeric_limits<uint16_t>::max() ||
              target->valuedouble !=
                  static_cast<uint16_t>(target->valuedouble)) {
            http::sendJsonError(s, 400, "Invalid target settings");
            return;
          }
          const auto targetCg = static_cast<uint16_t>(target->valuedouble);
          const bool enabled = cJSON_IsTrue(armed);
          if (!TargetSettings::valid(targetCg, enabled)) {
            http::sendJsonError(s, 400, "Invalid target settings");
            return;
          }
          const auto expected = store.snapshot();
          if (!expected.available) {
            http::sendJsonError(s, 503, "Target settings unavailable");
            return;
          }
          if (ifMatch != expected.etag().c_str()) {
            http::sendJsonError(s, 412, "The device target changed");
            return;
          }
          // The store repeats the value comparison under its write lock, so a
          // device edit after this snapshot also fails the precondition.
          switch (store.apply(targetCg, enabled, expected)) {
            case TargetStore::Result::Applied:
              // SSE remains the sole source of displayed device settings.
              s.send(204, "application/json", "");
              break;
            case TargetStore::Result::Conflict:
              http::sendJsonError(s, 412, "The device target changed");
              break;
            case TargetStore::Result::Invalid:
              http::sendJsonError(s, 400, "Invalid target settings");
              break;
            case TargetStore::Result::Failed:
              http::sendJsonError(s, 500,
                                  "The device could not save its target");
              break;
          }
        }}});
}

}  // namespace pump_scale
