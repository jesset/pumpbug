// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include <LittleFS.h>
#include <M5Unified.h>
#include <WebServer.h>
#include <nvs.h>

#include <cassert>
#include <cstdio>
#include <string>

#include "apps/extraction/history/ShotHistoryRoutes.h"
#include "util/storage.h"

TestLittleFS LittleFS;
TestM5 M5;

void testM5LogInfo(const char*, ...) {}
void testM5LogWarning(const char*, ...) {}
void testM5LogError(const char*, ...) {}

namespace storage {
MountState testMountState = MountState::Ready;
MountState mountState() { return testMountState; }
}  // namespace storage

namespace {
using pump_scale::ShotStore;

void resetStorage() {
  LittleFS.reset();
  testNvs.reset();
  storage::testMountState = storage::MountState::Ready;
}

uint32_t saveShot(ShotStore& store) {
  pump_scale::Extraction shot{};
  shot.version = pump_scale::kCurrentExtractionVersion;
  shot.phase = pump_scale::Phase::DONE;
  const uint32_t id = store.save(shot);
  assert(id != 0);
  return id;
}

WebServer request(uint32_t id) {
  WebServer server;
  server.arguments["id"] = std::to_string(id);
  return server;
}

WebServer metadataPut(uint32_t id, const std::string& etag, const char* body) {
  WebServer server = request(id);
  server.arguments["plain"] = body;
  server.requestHeaders["Content-Type"] = "application/json";
  server.requestHeaders["If-Match"] = etag;
  return server;
}

void testNonceFailurePreservesHistoryAndRecovery() {
  resetStorage();
  ShotStore store;
  const uint32_t id = saveShot(store);
  testNvs.nextOpenError = ESP_FAIL;
  WebServer recovery = request(id);
  recovery.arguments["recovery"] = "1";
  pump_scale::handleShotHistory(recovery, store);
  assert(recovery.status == 200 && !recovery.body.empty());
  assert(recovery.responseHeaders.count("ETag") == 0);
  assert(testNvs.nextOpenError == ESP_FAIL);

  WebServer detail = request(id);
  pump_scale::handleShotHistory(detail, store);
  assert(detail.status == 200);
  assert(store.shotStoreNonce() == store.bootNonce());
  const std::string etag = detail.responseHeaders.at("ETag");
  testNvs.setU32("shots", "store_nonce", 0x87654321);
  WebServer conditional = request(id);
  conditional.requestHeaders["If-None-Match"] = etag;
  pump_scale::handleShotHistory(conditional, store);
  assert(conditional.status == 304);

  WebServer metadata = request(id);
  pump_scale::handleShotMetadataGet(metadata, store);
  assert(metadata.status == 200);
  WebServer put =
      metadataPut(id, metadata.responseHeaders.at("ETag"), "{\"rating\":3}");
  pump_scale::handleShotMetadataPut(put, store);
  assert(put.status == 200 && put.body == "{\"rating\":3}");
  WebServer list;
  list.arguments["meta"] = "1";
  pump_scale::handleShotHistory(list, store);
  assert(list.status == 200);
  const std::string metadataEtag = put.responseHeaders.at("ETag");
  assert(list.body.find(metadataEtag.substr(1, metadataEtag.size() - 2)) !=
         std::string::npos);
}

void testConditionalDetailAfterRecordRemoval() {
  for (const std::string cause : {"erase", "retention", "format"}) {
    resetStorage();
    ShotStore store;
    const uint32_t id = saveShot(store);
    WebServer detail = request(id);
    pump_scale::handleShotHistory(detail, store);
    assert(detail.status == 200);
    const std::string etag = detail.responseHeaders.at("ETag");
    WebServer conditional = request(id);
    conditional.requestHeaders["If-None-Match"] = etag;
    pump_scale::handleShotHistory(conditional, store);
    assert(conditional.status == 304);

    const auto expectMissing = [&](ShotStore& current) {
      WebServer removed = request(id);
      removed.requestHeaders["If-None-Match"] = etag;
      pump_scale::handleShotHistory(removed, current);
      assert(removed.status == 404);
      assert(removed.responseHeaders.count("ETag") == 0);
    };
    if (cause == "format") {
      LittleFS.reset();
      ShotStore afterRestart;
      assert(afterRestart.shotStoreNonce() == store.shotStoreNonce());
      expectMissing(afterRestart);
    } else {
      if (cause == "erase")
        assert(store.erase(id));
      else {
        for (size_t i = 0; i < ShotStore::kMaxShots; ++i) saveShot(store);
      }
      expectMissing(store);
    }
  }
}

void testConditionalDetailChecksAccessAndValidatesCacheMisses() {
  resetStorage();
  ShotStore store;
  const uint32_t id = saveShot(store);
  WebServer detail = request(id);
  pump_scale::handleShotHistory(detail, store);
  assert(detail.status == 200);
  const std::string etag = detail.responseHeaders.at("ETag");
  const auto fetch = [&](const std::string& validator) {
    WebServer server = request(id);
    if (!validator.empty()) server.requestHeaders["If-None-Match"] = validator;
    pump_scale::handleShotHistory(server, store);
    return server;
  };
  LittleFS.resetBytesRead();
  WebServer hit = fetch(etag);
  assert(hit.status == 304 && hit.body.empty());
  assert(hit.responseHeaders.at("ETag") == etag);
  assert(LittleFS.bytesRead() == 0);
  WebServer miss = fetch("\"different\"");
  assert(miss.status == 200 && miss.body == detail.body);
  assert(LittleFS.bytesRead() > 0);

  storage::testMountState = storage::MountState::Unavailable;
  assert(fetch(etag).status == 503);
  storage::testMountState = storage::MountState::Ready;
  LittleFS.failFileOpen = true;
  assert(fetch(etag).status == 500);
  assert(fetch("\"different\"").status == 500);
  LittleFS.failFileOpen = false;
  char path[32];
  std::snprintf(path, sizeof(path), "/shots/%08u.bin",
                static_cast<unsigned>(id));
  LittleFS.xorFileByte(path, 0, 0xff);
  LittleFS.resetBytesRead();
  assert(fetch(etag).status == 304);
  assert(LittleFS.bytesRead() == 0);
  assert(fetch("\"different\"").status == 422);
  assert(fetch("").status == 422);
}

void testDetailEtagSurvivesMetadataWritesAndRestart() {
  resetStorage();
  ShotStore store;
  const uint32_t id = saveShot(store);
  WebServer detail = request(id);
  pump_scale::handleShotHistory(detail, store);
  assert(detail.status == 200);
  const std::string etag = detail.responseHeaders.at("ETag");
  const auto expectHit = [&](ShotStore& current) {
    LittleFS.resetBytesRead();
    WebServer server = request(id);
    server.requestHeaders["If-None-Match"] = etag;
    pump_scale::handleShotHistory(server, current);
    assert(server.status == 304);
    assert(server.responseHeaders.at("ETag") == etag);
    assert(LittleFS.bytesRead() == 0);
  };
  WebServer metadata = request(id);
  pump_scale::handleShotMetadataGet(metadata, store);
  assert(metadata.status == 200);
  WebServer put =
      metadataPut(id, metadata.responseHeaders.at("ETag"), "{\"rating\":3}");
  pump_scale::handleShotMetadataPut(put, store);
  assert(put.status == 200);
  expectHit(store);
  saveShot(store);
  expectHit(store);
  ShotStore afterRestart;
  expectHit(afterRestart);
}

void testMetadataValidatorsSurviveRestartAndRejectErase() {
  resetStorage();
  testNvs.setU32("shots", "store_nonce", 0x87654321);
  ShotStore store;
  const uint32_t id = saveShot(store);
  WebServer metadata = request(id);
  pump_scale::handleShotMetadataGet(metadata, store);
  assert(metadata.status == 200);
  const std::string original = metadata.responseHeaders.at("ETag");
  WebServer detail = request(id);
  pump_scale::handleShotHistory(detail, store);
  assert(detail.status == 200);
  const std::string detailEtag = detail.responseHeaders.at("ETag");
  ShotStore afterWake;
  WebServer unchanged = request(id);
  unchanged.requestHeaders["If-None-Match"] = original;
  pump_scale::handleShotMetadataGet(unchanged, afterWake);
  assert(unchanged.status == 304);
  WebServer put = metadataPut(id, original, "{\"notes\":\"Kept after sleep\"}");
  pump_scale::handleShotMetadataPut(put, afterWake);
  assert(put.status == 200);
  WebServer stale = metadataPut(id, original, "{\"rating\":5}");
  pump_scale::handleShotMetadataPut(stale, afterWake);
  assert(stale.status == 412);
  assert(stale.responseHeaders.at("X-Shot-Metadata-Conflict") == "metadata");

  resetStorage();
  ShotStore afterErase;
  assert(saveShot(afterErase) == id);
  WebServer reusedId = request(id);
  reusedId.requestHeaders["If-None-Match"] = detailEtag;
  LittleFS.resetBytesRead();
  pump_scale::handleShotHistory(reusedId, afterErase);
  assert(reusedId.status == 200);
  assert(reusedId.responseHeaders.at("ETag") != detailEtag);
  assert(LittleFS.bytesRead() > 0);
  WebServer oldPut =
      metadataPut(id, put.responseHeaders.at("ETag"), "{\"rating\":5}");
  pump_scale::handleShotMetadataPut(oldPut, afterErase);
  assert(oldPut.status == 412);
  assert(oldPut.responseHeaders.at("X-Shot-Metadata-Conflict") ==
         "shot-identity");
  WebServer oldDelete = request(id);
  oldDelete.requestHeaders["If-Match"] = put.responseHeaders.at("ETag");
  pump_scale::handleShotMetadataDelete(oldDelete, afterErase);
  assert(oldDelete.status == 412);
  assert(oldDelete.responseHeaders.at("X-Shot-Metadata-Conflict") ==
         "shot-identity");
  WebServer fresh = request(id);
  pump_scale::handleShotMetadataGet(fresh, afterErase);
  assert(fresh.status == 200);
  assert(fresh.responseHeaders.at("X-Shot-Metadata-State") == "absent");
}
}  // namespace

int main() {
  testNonceFailurePreservesHistoryAndRecovery();
  testConditionalDetailAfterRecordRemoval();
  testConditionalDetailChecksAccessAndValidatesCacheMisses();
  testDetailEtagSurvivesMetadataWritesAndRestart();
  testMetadataValidatorsSurviveRestartAndRejectErase();
  std::puts("OK: shot history HTTP identity and cache contracts");
}
