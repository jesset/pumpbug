// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "LmCloudClient.h"

#include <HTTPClient.h>
#include <esp_wifi.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_random.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/ecp.h>
#include <mbedtls/pk.h>

#include <esp_log.h>

#include <cJSON.h>
#include <cstdio>
#include <cstring>

#include "LmCrypto.h"
#include "net/WifiManager.h"
#include "util/scoped_lock.h"
#include "util/wallclock.h"

namespace lm {

namespace {

// lion.lamarzocco.io serves an AWS-issued chain rooted at "Amazon Root CA 1"
// (verified 2026-10). PEM from https://www.amazontrust.com/repository/.
// If TLS suddenly fails after years, the root rotated — see
// docs/lamarzocco.md.
const char kAmazonRootCa1[] =
    "-----BEGIN CERTIFICATE-----\n"
    "MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF\n"
    "ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6\n"
    "b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL\n"
    "MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv\n"
    "b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj\n"
    "ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM\n"
    "9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw\n"
    "IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6\n"
    "VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L\n"
    "93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm\n"
    "jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC\n"
    "AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA\n"
    "A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI\n"
    "U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs\n"
    "N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv\n"
    "o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU\n"
    "5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy\n"
    "rqXRfboQnoZsG4q5WTP468SQvvG5\n"
    "-----END CERTIFICATE-----\n";

constexpr const char* kBase = "https://lion.lamarzocco.io/api/customer-app";
constexpr uint32_t kHttpTimeoutMs = 12000;
constexpr size_t kMaxUsername = 96;

int rngForMbedtls(void*, unsigned char* out, size_t len) {
  esp_fill_random(out, len);
  return 0;
}

void fillUuid4(char out[37]) {
  uint8_t b[16];
  esp_fill_random(b, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  static const char* hex = "0123456789abcdef";
  int o = 0;
  for (int i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out[o++] = '-';
    out[o++] = hex[b[i] >> 4];
    out[o++] = hex[b[i] & 0xf];
  }
  out[o] = '\0';
}

// Per-run installation identity (pylamarzocco InstallationKey equivalent).
struct InstallationKey {
  char installationId[37] = {};
  uint8_t secret[32] = {};
  char pubB64[256] = {};      // base64(DER SubjectPublicKeyInfo)
  uint8_t pubDer[256] = {};   // raw DER for the init proof hash
  size_t pubDerLen = 0;
};

bool deriveInstallationKey(InstallationKey& key, mbedtls_pk_context& pk) {
  fillUuid4(key.installationId);
  if (mbedtls_pk_setup(&pk, mbedtls_pk_info_from_type(MBEDTLS_PK_ECKEY)) != 0)
    return false;
  if (mbedtls_ecp_gen_key(MBEDTLS_ECP_DP_SECP256R1, mbedtls_pk_ec(pk),
                          rngForMbedtls, nullptr) != 0)
    return false;
  uint8_t buf[512];
  int n = mbedtls_pk_write_pubkey_der(&pk, buf, sizeof(buf));
  if (n < 0 || static_cast<size_t>(n) > sizeof(key.pubDer)) return false;
  key.pubDerLen = static_cast<size_t>(n);
  memcpy(key.pubDer, buf + sizeof(buf) - n, n);
  if (lm::base64Encode(key.pubDer, key.pubDerLen, key.pubB64,
                       sizeof(key.pubB64)) == 0)
    return false;

  // secret = sha256("<id>.<pubB64>.<b64(sha256(id))>")
  uint8_t idHash[32];
  lm::sha256(reinterpret_cast<const uint8_t*>(key.installationId),
             strlen(key.installationId), idHash);
  char idHashB64[45];
  if (lm::base64Encode(idHash, 32, idHashB64, sizeof(idHashB64)) == 0)
    return false;
  char base[620];
  const int w = snprintf(base, sizeof(base), "%s.%s.%s", key.installationId,
                         key.pubB64, idHashB64);
  if (w <= 0 || static_cast<size_t>(w) >= sizeof(base)) return false;
  lm::sha256(reinterpret_cast<const uint8_t*>(base), strlen(base), key.secret);
  return true;
}

// Signed headers shared by every post-registration request. The same
// timestamp/nonce/proof triple is used for signature input and headers.
struct SignedHeaders {
  char timestamp[16];
  char nonce[37];
  char signatureB64[128];
};

bool buildSignedHeaders(SignedHeaders& h, const InstallationKey& key,
                        mbedtls_pk_context& pk) {
  snprintf(h.timestamp, sizeof(h.timestamp), "%llu",
           static_cast<unsigned long long>(wallclock::utcNow()) * 1000ULL);
  fillUuid4(h.nonce);
  char proofInput[128];
  const int w = snprintf(proofInput, sizeof(proofInput), "%s.%s.%s",
                         key.installationId, h.nonce, h.timestamp);
  if (w <= 0 || static_cast<size_t>(w) >= sizeof(proofInput)) {
    ESP_LOGW("lm_cloud", "sign: proofInput overflow (%d)", w);
    return false;
  }
  char proof[45];
  if (!lm::generateRequestProof(proofInput, key.secret, proof, sizeof(proof))) {
    ESP_LOGW("lm_cloud", "sign: request proof failed");
    return false;
  }
  char signatureData[200];
  const int w2 = snprintf(signatureData, sizeof(signatureData), "%s.%s",
                          proofInput, proof);
  if (w2 <= 0 || static_cast<size_t>(w2) >= sizeof(signatureData)) {
    ESP_LOGW("lm_cloud", "sign: signatureData overflow (%d)", w2);
    return false;
  }
  uint8_t digest[32];
  lm::sha256(reinterpret_cast<const uint8_t*>(signatureData),
             strlen(signatureData), digest);
  uint8_t sig[MBEDTLS_MPI_MAX_SIZE];
  size_t sigLen = 0;
  // mbedtls takes a pre-computed digest; pylamarzocco signs SHA-256 of the
  // signature base string, so hash here first.
  int signOk =
#if MBEDTLS_VERSION_MAJOR >= 3
      mbedtls_pk_sign(&pk, MBEDTLS_MD_SHA256, digest, sizeof(digest), sig,
                      sizeof(sig), &sigLen, rngForMbedtls, nullptr);
#else
      mbedtls_pk_sign(&pk, MBEDTLS_MD_SHA256, digest, sizeof(digest), sig,
                      &sigLen, rngForMbedtls, nullptr);
#endif
  if (signOk != 0) {
    ESP_LOGW("lm_cloud", "sign: pk_sign -0x%04x (pk_info=%s type=%d)",
             -signOk, pk.pk_info == nullptr ? "NULL" : "set",
             static_cast<int>(mbedtls_pk_get_type(&pk)));
    // Fallback: bypass the pk layer and sign with the raw keypair —
    // mbedtls_ecdsa_context is a typedef of mbedtls_ecp_keypair, so the
    // context pk holds can be used directly.
    signOk = mbedtls_ecdsa_write_signature(
        mbedtls_pk_ec(pk), MBEDTLS_MD_SHA256, digest, sizeof(digest), sig,
        &sigLen, rngForMbedtls, nullptr);
    if (signOk != 0) {
      ESP_LOGW("lm_cloud", "sign: ecdsa_write_signature -0x%04x", -signOk);
    }
  }
  if (signOk != 0) {
    ESP_LOGW("lm_cloud", "sign: giving up");
    return false;
  }
  if (lm::base64Encode(sig, sigLen, h.signatureB64, sizeof(h.signatureB64)) ==
      0) {
    ESP_LOGW("lm_cloud", "sign: b64 overflow (sigLen=%u)",
             static_cast<unsigned>(sigLen));
    return false;
  }
  return true;
}

struct HttpResponse {
  bool reached = false;  // a server responded (any status)
  int code = 0;
  String body;
};

HttpResponse requestOnce(const char* method, const char* path,
                          const InstallationKey& key, const char* initProof,
                          const SignedHeaders* signed_, const char* bearer,
                          const char* body);

// The signing keypair lives at file scope, not on the cloud task's stack:
// it is created and consumed within a single run, and runs are serialized by
// the client's Running state, so one static context is safe and immune to
// deep TLS stack frames.
mbedtls_pk_context g_runPk;

HttpResponse request(const char* method, const char* path,
                     const InstallationKey& key,
                     const char* initProof /*nullable*/,
                     const SignedHeaders* signed_ /*nullable*/,
                     const char* bearer /*nullable*/, const char* body) {
  // Wi-Fi with modem power save occasionally drops a TCP/TLS connect; a
  // provisioning run is a rare user-triggered event, so retry briefly.
  HttpResponse r;
  for (int attempt = 1; attempt <= 3; attempt++) {
    r = requestOnce(method, path, key, initProof, signed_, bearer, body);
    if (r.reached || attempt == 3) break;
    ESP_LOGW("lm_cloud", "attempt %d failed; retrying", attempt);
    vTaskDelay(pdMS_TO_TICKS(attempt * 700));
  }
  return r;
}

HttpResponse requestOnce(const char* method, const char* path,
                     const InstallationKey& key,
                     const char* initProof /*nullable*/,
                     const SignedHeaders* signed_ /*nullable*/,
                     const char* bearer /*nullable*/, const char* body) {
  HttpResponse r;
  WiFiClientSecure client;
  client.setCACert(kAmazonRootCa1);
  client.setTimeout(10);
  HTTPClient http;
  const String url = String(kBase) + path;
  if (!http.begin(client, url)) {
    ESP_LOGW("lm_cloud", "begin failed: %s", url.c_str());
    return r;
  }
  http.setTimeout(kHttpTimeoutMs);
  http.addHeader("X-App-Installation-Id", key.installationId);
  // La Marzocco gates parts of the API (including BLE token issuance) by
  // client identification; this mirrors the header set Home Assistant's
  // session sends on every request.
  http.addHeader("X-Client", "HOME_ASSISTANT");
  http.addHeader("X-Client-Build", "2025.1.0");
  if (initProof != nullptr) http.addHeader("X-Request-Proof", initProof);
  if (signed_ != nullptr) {
    http.addHeader("X-Timestamp", signed_->timestamp);
    http.addHeader("X-Nonce", signed_->nonce);
    http.addHeader("X-Request-Signature", signed_->signatureB64);
  }
  if (bearer != nullptr) http.addHeader("Authorization", bearer);
  if (body != nullptr) http.addHeader("Content-Type", "application/json");
  r.code = body != nullptr ? http.POST(body) : http.GET();
  r.reached = r.code > 0;
  if (r.reached) {
    r.body = http.getString();
  } else {
    char tlsErr[96] = {0};
    client.lastError(tlsErr, sizeof(tlsErr));
    ESP_LOGW("lm_cloud",
             "%s %s -> code=%d (%s) tls=%s",
             body != nullptr ? "POST" : "GET", path, r.code,
             http.errorToString(r.code).c_str(), tlsErr);
  }
  http.end();
  return r;
}

}  // namespace

bool lmCloudPreconditionsOk(bool staConnected, uint32_t utcNow) {
  return staConnected && utcNow >= 1735689600;  // >= 2025-01-01
}

LmCloudClient::LmCloudClient() : _mutex(xSemaphoreCreateMutex()) {
  configASSERT(_mutex);
}

LmCloudClient::~LmCloudClient() {
  if (_task != nullptr) vTaskDelete(_task);
  vSemaphoreDelete(_mutex);
}

bool LmCloudClient::start(const char* username, const char* password) {
  if (username == nullptr || password == nullptr || username[0] == '\0' ||
      password[0] == '\0')
    return false;
  if (!lmCloudPreconditionsOk(WiFi.status() == WL_CONNECTED,
                              wallclock::utcNow())) {
    ScopedLock lock(_mutex);
    _result = Result{};
    _result.state = State::Failed;
    _result.error = Error::Offline;
    return false;
  }
  {
    ScopedLock lock(_mutex);
    if (_result.state == State::Running) return false;
    _result = Result{};
    _result.state = State::Running;
    strncpy(_username, username, sizeof(_username) - 1);
    _username[sizeof(_username) - 1] = '\0';
    strncpy(_password, password, sizeof(_password) - 1);
    _password[sizeof(_password) - 1] = '\0';
  }
  if (xTaskCreate(_taskTrampoline, "lm_cloud", 24576, this, 2, &_task) !=
      pdPASS) {
    ScopedLock lock(_mutex);
    _task = nullptr;
    _result = Result{};
    _result.state = State::Failed;
    _result.error = Error::Busy;
    return false;
  }
  return true;
}

LmCloudClient::Result LmCloudClient::result() const {
  ScopedLock lock(_mutex);
  return _result;
}

void LmCloudClient::reset() {
  ScopedLock lock(_mutex);
  if (_result.state == State::Running) return;
  _result = Result{};
}

void LmCloudClient::_finish(State s, Error e) {
  ScopedLock lock(_mutex);
  _result.state = s;
  _result.error = e;
  memset(_username, 0, sizeof(_username));
  memset(_password, 0, sizeof(_password));
}

void LmCloudClient::_taskTrampoline(void* arg) {
  static_cast<LmCloudClient*>(arg)->_run();
  // The task's own handle is cleared under the lock before exiting.
}

void LmCloudClient::_run() {
  ESP_LOGI("lm_cloud", "run start");
  // The provisioning run is a rare user-triggered burst of five TLS
  // handshakes. Station modem sleep (the default power policy) drops and
  // delays enough of them to fail runs; stay fully awake for the duration.
  // The restore path re-applies the manager's configured mode, so a run can
  // never leave the STA at a different power level than the design chose.
  esp_wifi_set_ps(WIFI_PS_NONE);
  mbedtls_pk_context& pk = g_runPk;
  mbedtls_pk_init(&pk);
  Error error = Error::None;
  LmThingInfo machines[kMaxMachines];
  size_t machineCount = 0;
  char accessToken[1024] = {};

  do {
    InstallationKey key;
    {
      IPAddress hostIp;
      const bool dnsOk = WiFi.hostByName("lion.lamarzocco.io", hostIp);
      ESP_LOGI("lm_cloud", "dns lion.lamarzocco.io -> %s (%s)",
               dnsOk ? hostIp.toString().c_str() : "FAIL",
               dnsOk ? "ok" : "dns error");
    }
    if (!deriveInstallationKey(key, pk)) {
      ESP_LOGW("lm_cloud", "installation key derive failed");
      error = Error::Network;
      break;
    }
    ESP_LOGI("lm_cloud", "installation %s derived", key.installationId);

    // 1. Register the installation's public key.
    uint8_t pubHash[32];
    lm::sha256(key.pubDer, key.pubDerLen, pubHash);
    char pubHashB64[45];
    lm::base64Encode(pubHash, 32, pubHashB64, sizeof(pubHashB64));
    char initBase[37 + 45 + 2];
    snprintf(initBase, sizeof(initBase), "%s.%s", key.installationId,
             pubHashB64);
    char initProof[45];
    if (!lm::generateRequestProof(initBase, key.secret, initProof,
                                  sizeof(initProof))) {
      error = Error::Network;
      break;
    }
    char initBody[340];
    snprintf(initBody, sizeof(initBody), "{\"pk\":\"%s\"}", key.pubB64);
    HttpResponse r1 = request("POST", "/auth/init", key, initProof, nullptr,
                              nullptr, initBody);
    ESP_LOGI("lm_cloud", "auth/init code=%d len=%u", r1.code,
             static_cast<unsigned>(r1.body.length()));
    if (!r1.reached) {
      error = Error::Network;
      break;
    }
    if (r1.code == 401) {
      error = Error::AuthRejected;
      break;
    }
    if (r1.code >= 400) {
      error = Error::Network;
      break;
    }

    // 2. Sign in with the account credentials.
    SignedHeaders sh;
    if (!buildSignedHeaders(sh, key, pk)) {
      error = Error::Network;
      break;
    }
    char user[kMaxUsername];
    char pass[kMaxUsername];
    {
      ScopedLock lock(_mutex);
      memcpy(user, _username, sizeof(user));
      memcpy(pass, _password, sizeof(pass));
    }
    // cJSON builds the body so passwords with quotes, backslashes, or
    // non-ASCII characters are escaped correctly.
    char* signinBody = nullptr;
    {
      cJSON* root = cJSON_CreateObject();
      cJSON_AddStringToObject(root, "username", user);
      cJSON_AddStringToObject(root, "password", pass);
      signinBody = cJSON_PrintUnformatted(root);
      cJSON_Delete(root);
    }
    memset(user, 0, sizeof(user));
    memset(pass, 0, sizeof(pass));
    if (signinBody == nullptr) {
      error = Error::Parse;
      break;
    }
    ESP_LOGI("lm_cloud", "signin body built (%u bytes)",
             static_cast<unsigned>(strlen(signinBody)));
    HttpResponse r2 = request("POST", "/auth/signin", key, nullptr, &sh,
                              nullptr, signinBody);
    cJSON_free(signinBody);
    ESP_LOGI("lm_cloud", "auth/signin code=%d len=%u", r2.code,
             static_cast<unsigned>(r2.body.length()));
    if (!r2.reached) {
      error = Error::Network;
      break;
    }
    if (r2.code == 401) {
      error = Error::AuthRejected;
      break;
    }
    if (r2.code >= 400) {
      error = Error::Network;
      break;
    }
    LmSigninTokens tokens;
    if (!parseSigninResponse(r2.body.c_str(), r2.body.length(), tokens)) {
      error = Error::Parse;
      break;
    }
    strncpy(accessToken, tokens.accessToken, sizeof(accessToken) - 1);

    // 3. List the account's machines.
    SignedHeaders sh2;
    if (!buildSignedHeaders(sh2, key, pk)) {
      error = Error::Network;
      break;
    }
    char bearer[1100];
    snprintf(bearer, sizeof(bearer), "Bearer %s", accessToken);
    HttpResponse r3 = request("GET", "/things", key, nullptr, &sh2, bearer,
                              nullptr);
    ESP_LOGI("lm_cloud", "things code=%d len=%u", r3.code,
             static_cast<unsigned>(r3.body.length()));
    if (r3.reached && r3.body.length() < 1500) {
      ESP_LOGI("lm_cloud", "things body: %s", r3.body.c_str());
    }
    if (!r3.reached || r3.code >= 400) {
      error = Error::Network;
      break;
    }
    if (!parseThingsList(r3.body.c_str(), r3.body.length(), machines,
                         kMaxMachines, machineCount)) {
      error = Error::Parse;
      break;
    }
    if (machineCount == 0) {
      error = Error::NoMachine;
      break;
    }

    // 4. The BLE token is issued by /things/{serial}/settings — /things
    // lists it as null for installations that have not fetched settings
    // (Home Assistant gets it from this same endpoint).
    for (size_t i = 0; i < machineCount; i++) {
      LmThingInfo& t = machines[i];
      char settingsPath[64];
      snprintf(settingsPath, sizeof(settingsPath), "/things/%s/settings",
               t.serial);
      SignedHeaders sh3;
      if (!buildSignedHeaders(sh3, key, pk)) break;
      HttpResponse rs = request("GET", settingsPath, key, nullptr, &sh3,
                                bearer, nullptr);
      ESP_LOGI("lm_cloud", "settings(%s) code=%d len=%u", t.serial, rs.code,
               static_cast<unsigned>(rs.body.length()));
      if (rs.reached && rs.code < 400) {
        if (rs.body.length() < 1600) {
          ESP_LOGI("lm_cloud", "settings body: %s", rs.body.c_str());
        }
        char token[96];
        if (lm::extractBleAuthToken(rs.body.c_str(), rs.body.length(), token,
                                    sizeof(token))) {
          strncpy(t.bleToken, token, sizeof(t.bleToken) - 1);
          t.bleToken[sizeof(t.bleToken) - 1] = '\0';
          t.hasToken = true;
          ESP_LOGI("lm_cloud", "settings: ble token acquired (%u chars)",
                   static_cast<unsigned>(strlen(t.bleToken)));
        }
      }
      buildSignedHeaders(sh2, key, pk);  // fresh triple for the next iteration
    }
  } while (false);

  mbedtls_pk_free(&pk);
  memset(accessToken, 0, sizeof(accessToken));
  wifiManager.reapplyStaPowerSave();
  ESP_LOGI("lm_cloud", "run end error=%u", static_cast<unsigned>(error));

  {
    ScopedLock lock(_mutex);
    if (error == Error::None) {
      _result.state = State::Done;
      _result.error = Error::None;
      _result.machineCount = machineCount;
      for (size_t i = 0; i < machineCount; i++)
        _result.machines[i] = machines[i];
    } else {
      _result.state = State::Failed;
      _result.error = error;
    }
    memset(_username, 0, sizeof(_username));
    memset(_password, 0, sizeof(_password));
    _task = nullptr;
  }
  // Delete self OUTSIDE the lock: vTaskDelete(self) skips stack unwinding,
  // so a guard destroyed by scope exit would never release its mutex and
  // would deadlock every later start()/result() (and the HTTP task serving
  // the polling route).
  vTaskDelete(nullptr);
}

}  // namespace lm
