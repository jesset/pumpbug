// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "MachineRoutes.h"

#include <WebServer.h>
#include <cJSON.h>

#include "ble/BleScaleService.h"
#include "ble/lamarzocco/LmCloudClient.h"
#include "ble/lamarzocco/LmGatt.h"
#include "ble/lamarzocco/LmMachineStore.h"
#include "net/HttpServer.h"
#include "net/JsonStream.h"
#include "net/http_request_validation.h"
#include "net/http_response_util.h"
#include "power/PowerManager.h"
#include "util/json_validate.h"

namespace {

constexpr size_t kMaxBodyJsonBytes = 512;
// The discovery scan lease: long enough to see a few advertising rounds of
// MINI_*/MICRA_*/GS3_* devices, short enough to return the radio.
constexpr uint32_t kScanLeaseMs = 10000;

bool parseMacAddress(const char* s, uint8_t out[6]) {
  if (s == nullptr) return false;
  unsigned v[6];
  if (sscanf(s, "%2X:%2X:%2X:%2X:%2X:%2X", &v[0], &v[1], &v[2], &v[3], &v[4],
             &v[5]) != 6)
    return false;
  for (int i = 0; i < 6; i++) {
    if (v[i] > 0xff) return false;
    out[i] = static_cast<uint8_t>(v[i]);
  }
  return true;
}

const char* cloudErrorName(lm::LmCloudClient::Error e) {
  using E = lm::LmCloudClient::Error;
  switch (e) {
    case E::None: return "none";
    case E::Busy: return "busy";
    case E::Offline: return "offline";
    case E::NoClock: return "no_clock";
    case E::Network: return "network";
    case E::AuthRejected: return "auth_rejected";
    case E::Parse: return "parse";
    case E::NoMachine: return "no_machine";
  }
  return "?";
}

void writeMachine(JsonStream& body, const LmMachineStore::Machine& m) {
  char addr[18];
  m.formatAddress(addr, sizeof(addr));
  const BleScaleService::MachineSnapshot link = bleScale.machineSnapshot();
  const char* linkName;
  using L = BleScaleService::MachineSnapshot::Link;
  switch (link.link) {
    case L::Subscribed: linkName = "subscribed"; break;
    case L::Backoff: linkName = "retrying"; break;
    case L::Idle: linkName = "waiting"; break;
    case L::Off: linkName = "off"; break;
    default: linkName = "off"; break;
  }
  body.open()
      .key("firmware")
      .str(PB_FIRMWARE_VERSION)
      .key("provisioned")
      .boolean(m.provisioned)
      .key("address")
      .str(m.provisioned ? addr : nullptr)
      .key("bleName")
      .str(m.bleName[0] != '\0' ? m.bleName : nullptr)
      .key("serial")
      .str(m.serial[0] != '\0' ? m.serial : nullptr)
      .key("model")
      .str(m.model[0] != '\0' ? m.model : nullptr)
      .key("tokenPresent")
      .boolean(m.hasToken)
      .key("link")
      .open()
      .key("state")
      .str(linkName)
      .key("brewing")
      .boolean(link.brewing)
      .key("notifications")
      .u(link.notifications)
      .close()
      .close();
}

}  // namespace

void registerMachineRoutes(HttpServer& http, LmMachineStore& store,
                           lm::LmCloudClient& cloud) {
  http.registerApp(
      "machine",
      {
          HttpRoute{
              "/status", HTTP_GET,
              [&store](WebServer& s) {
                s.sendHeader("Cache-Control", "no-store");
                JsonStream body(s);
                writeMachine(body, store.snapshot());
                body.finish();
              }},

          HttpRoute{
              "/scan", HTTP_POST,
              [](WebServer& s) {
                power::powerManager.notifyWebActivity();
                // Reuses the diagnostics discovery scan: every advertiser is
                // recorded; /scan filters for La Marzocco names. The scan
                // yields to an in-use scale connection (Connect wins).
                bleScale.startDiagScan(kScanLeaseMs);
                s.sendHeader("Cache-Control", "no-store");
                JsonStream body(s);
                body.open().key("scanning").boolean(true).close();
                body.finish();
              }},

          HttpRoute{
              "/scan", HTTP_GET,
              [](WebServer& s) {
                s.sendHeader("Cache-Control", "no-store");
                const BleScaleService::ScanResults r = bleScale.scanSnapshot();
                JsonStream body(s);
                body.open()
                    .key("active")
                    .boolean(r.active)
                    .key("busy")
                    .boolean(r.busy)
                    .key("machines")
                    .arrayOpen();
                bool first = true;
                for (uint8_t i = 0; i < r.count; i++) {
                  const BleScaleService::ScanEntry& e = r.entries[i];
                  if (!lm::isLaMarzoccoName(e.name)) continue;
                  if (!first) body.comma();
                  first = false;
                  char addr[18];
                  snprintf(addr, sizeof(addr), "%02X:%02X:%02X:%02X:%02X:%02X",
                           e.addr[0], e.addr[1], e.addr[2], e.addr[3], e.addr[4],
                           e.addr[5]);
                  body.open()
                      .key("address")
                      .str(addr)
                      .key("name")
                      .str(e.name)
                      .key("rssi")
                      .i(e.rssi)
                      .close();
                }
                body.arrayClose().close();
                body.finish();
              }},

          HttpRoute{
              "/select", HTTP_POST,
              [&store](WebServer& s) {
                power::powerManager.notifyWebActivity();
                s.sendHeader("Cache-Control", "no-store");
                String bodyStr;
                if (!http::requireJsonRequestBody(s, kMaxBodyJsonBytes,
                                                  bodyStr))
                  return;
                const json::ObjectValidationResult v = json::validateObject(
                    bodyStr.c_str(), bodyStr.length(), kMaxBodyJsonBytes, 4);
                if (v != json::ObjectValidationResult::Valid) {
                  http::sendJsonError(s, 400, "Invalid JSON body");
                  return;
                }
                cJSON* root = cJSON_Parse(bodyStr.c_str());
                if (root == nullptr) {
                  http::sendJsonError(s, 400, "Invalid JSON body");
                  return;
                }
                const cJSON* address =
                    cJSON_GetObjectItemCaseSensitive(root, "address");
                const cJSON* name =
                    cJSON_GetObjectItemCaseSensitive(root, "name");
                bool ok = false;
                uint8_t mac[6];
                if (cJSON_IsString(address) && cJSON_IsString(name) &&
                    cJSON_GetStringValue(address) != nullptr &&
                    parseMacAddress(cJSON_GetStringValue(address), mac)) {
                  ok = store.saveAddress(
                      mac, cJSON_GetStringValue(name) != nullptr
                               ? cJSON_GetStringValue(name)
                               : "");
                }
                cJSON_Delete(root);
                if (!ok) {
                  http::sendJsonError(s, 400,
                                      "Expected {address, name} with a valid "
                                      "MAC address");
                  return;
                }
                JsonStream body(s);
                writeMachine(body, store.snapshot());
                body.finish();
              }},

          HttpRoute{
              "/credentials", HTTP_POST,
              [&cloud](WebServer& s) {
                power::powerManager.notifyWebActivity();
                s.sendHeader("Cache-Control", "no-store");
                String bodyStr;
                if (!http::requireJsonRequestBody(s, 512, bodyStr)) return;
                const json::ObjectValidationResult v = json::validateObject(
                    bodyStr.c_str(), bodyStr.length(), 512, 3);
                if (v != json::ObjectValidationResult::Valid) {
                  http::sendJsonError(s, 400, "Invalid JSON body");
                  return;
                }
                cJSON* root = cJSON_Parse(bodyStr.c_str());
                if (root == nullptr) {
                  http::sendJsonError(s, 400, "Invalid JSON body");
                  return;
                }
                const cJSON* user =
                    cJSON_GetObjectItemCaseSensitive(root, "username");
                const cJSON* pass =
                    cJSON_GetObjectItemCaseSensitive(root, "password");
                bool accepted = false;
                lm::LmCloudClient::Error early = lm::LmCloudClient::Error::None;
                if (cJSON_IsString(user) && cJSON_IsString(pass) &&
                    cJSON_GetStringValue(user) != nullptr &&
                    cJSON_GetStringValue(pass) != nullptr) {
                  accepted = cloud.start(cJSON_GetStringValue(user),
                                         cJSON_GetStringValue(pass));
                  ESP_LOGI("machine", "credentials: start=%d",
                           static_cast<int>(accepted));
                  if (!accepted) {
                    // Distinguish "rejected now" (offline/preconditions) from
                    // a genuinely started run.
                    early = cloud.result().error;
                  }
                } else {
                  ESP_LOGW("machine", "credentials: bad body shape");
                }
                cJSON_Delete(root);
                if (!accepted) {
                  http::sendJsonError(s, 503,
                                      early ==
                                              lm::LmCloudClient::Error::Offline
                                          ? "Cloud unreachable: Wi-Fi or time "
                                            "not ready"
                                          : "Cloud run not started");
                  return;
                }
                JsonStream body(s);
                body.open().key("state").str("running").close();
                body.finish();
              }},

          HttpRoute{
              "/cloud", HTTP_GET,
              [&cloud](WebServer& s) {
                s.sendHeader("Cache-Control", "no-store");
                const lm::LmCloudClient::Result r = cloud.result();
                JsonStream body(s);
                body.open().key("state");
                using St = lm::LmCloudClient::State;
                switch (r.state) {
                  case St::Idle: body.str("idle"); break;
                  case St::Running: body.str("running"); break;
                  case St::Done: body.str("done"); break;
                  case St::Failed:
                    body.str("failed");
                    body.key("error").str(cloudErrorName(r.error));
                    break;
                }
                if (r.state == St::Done) {
                  body.key("machines").arrayOpen();
                  bool first = true;
                  for (size_t i = 0; i < r.machineCount; i++) {
                    if (!first) body.comma();
                    first = false;
                    const lm::LmThingInfo& t = r.machines[i];
                    body.open()
                        .key("serial")
                        .str(t.serial)
                        .key("name")
                        .str(t.name[0] != '\0' ? t.name : nullptr)
                        .key("model")
                        .str(t.modelName[0] != '\0' ? t.modelName : nullptr)
                        .key("tokenPresent")
                        .boolean(t.hasToken)
                        .key("shotCounterSupported")
                        .boolean(t.shotCounterSupported)
                        .close();
                  }
                  body.arrayClose();
                }
                body.close();
                body.finish();
              }},

          HttpRoute{
              "/choose", HTTP_POST,
              [&store, &cloud](WebServer& s) {
                power::powerManager.notifyWebActivity();
                s.sendHeader("Cache-Control", "no-store");
                String bodyStr;
                if (!http::requireJsonRequestBody(s, 256, bodyStr)) return;
                cJSON* root = cJSON_Parse(bodyStr.c_str());
                if (root == nullptr) {
                  http::sendJsonError(s, 400, "Invalid JSON body");
                  return;
                }
                const cJSON* serial =
                    cJSON_GetObjectItemCaseSensitive(root, "serial");
                const lm::LmCloudClient::Result r = cloud.result();
                const lm::LmThingInfo* chosen = nullptr;
                if (cJSON_IsString(serial) &&
                    cJSON_GetStringValue(serial) != nullptr &&
                    r.state == lm::LmCloudClient::State::Done) {
                  for (size_t i = 0; i < r.machineCount; i++) {
                    if (strcmp(r.machines[i].serial,
                               cJSON_GetStringValue(serial)) == 0) {
                      chosen = &r.machines[i];
                      break;
                    }
                  }
                }
                cJSON_Delete(root);
                if (chosen == nullptr) {
                  http::sendJsonError(s, 404, "Unknown serial for this run");
                  return;
                }
                if (!store.saveCloudIdentity(*chosen)) {
                  http::sendJsonError(s, 500, "Failed to persist identity");
                  return;
                }
                cloud.reset();
                JsonStream body(s);
                writeMachine(body, store.snapshot());
                body.finish();
              }},

          HttpRoute{
              "/token", HTTP_POST,
              [&store](WebServer& s) {
                power::powerManager.notifyWebActivity();
                s.sendHeader("Cache-Control", "no-store");
                String bodyStr;
                if (!http::requireJsonRequestBody(s, kMaxBodyJsonBytes,
                                                  bodyStr))
                  return;
                cJSON* root = cJSON_Parse(bodyStr.c_str());
                if (root == nullptr) {
                  http::sendJsonError(s, 400, "Invalid JSON body");
                  return;
                }
                const cJSON* token =
                    cJSON_GetObjectItemCaseSensitive(root, "token");
                const cJSON* serial =
                    cJSON_GetObjectItemCaseSensitive(root, "serial");
                bool ok = false;
                if (cJSON_IsString(token) && cJSON_IsString(serial) &&
                    cJSON_GetStringValue(token) != nullptr &&
                    cJSON_GetStringValue(serial) != nullptr &&
                    strlen(cJSON_GetStringValue(token)) > 0) {
                  lm::LmThingInfo t;
                  strncpy(t.bleToken, cJSON_GetStringValue(token),
                          sizeof(t.bleToken) - 1);
                  strncpy(t.serial, cJSON_GetStringValue(serial),
                          sizeof(t.serial) - 1);
                  t.hasToken = true;
                  ok = store.saveCloudIdentity(t);
                }
                cJSON_Delete(root);
                if (!ok) {
                  http::sendJsonError(s, 400, "Expected {token, serial}");
                  return;
                }
                JsonStream body(s);
                writeMachine(body, store.snapshot());
                body.finish();
              }},

          HttpRoute{
              "/forget", HTTP_POST,
              [&store](WebServer& s) {
                power::powerManager.notifyWebActivity();
                s.sendHeader("Cache-Control", "no-store");
                if (!store.clear()) {
                  http::sendJsonError(s, 500, "Failed to erase machine data");
                  return;
                }
                JsonStream body(s);
                writeMachine(body, store.snapshot());
                body.finish();
              }},
      });
}
