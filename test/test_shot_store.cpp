// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include <LittleFS.h>
#include <M5Unified.h>
#include <nvs.h>

#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

#include "apps/extraction/history/ShotStore.h"
#include "util/storage.h"

TestLittleFS LittleFS;
TestM5 M5;

void testM5LogInfo(const char*, ...) {}
void testM5LogWarning(const char*, ...) {}
void testM5LogError(const char*, ...) {}
void testDisplayPowerSaveOn() {}
void testDisplayPowerSaveOff() {}

namespace storage {
MountState mountState() { return MountState::Ready; }
}  // namespace storage

namespace {

using pump_scale::Extraction;
using pump_scale::ShotStore;

std::string shotPath(uint32_t id) {
  char path[32];
  std::snprintf(path, sizeof(path), "/shots/%08u.bin",
                static_cast<unsigned>(id));
  return path;
}

std::vector<uint8_t> validHeader() {
  std::vector<uint8_t> header(pump_scale::kCompactHeaderBytes, 0);
  header[0] = 'E';
  header[1] = 'X';
  header[2] = 'T';
  header[3] = 'R';
  header[4] = pump_scale::kCompactVersion;
  return header;
}

void addValidShot(uint32_t id) {
  LittleFS.addFile(shotPath(id), validHeader());
}

Extraction encodableShot() {
  Extraction shot{};
  shot.version = pump_scale::kCurrentExtractionVersion;
  shot.phase = pump_scale::Phase::DONE;
  return shot;
}

void resetStorage() {
  LittleFS.reset();
  testNvs.reset();
}

std::vector<uint32_t> page(ShotStore& store, uint32_t before, size_t limit,
                           bool& hasMore, size_t& total,
                           uint32_t* revision = nullptr) {
  std::vector<uint32_t> ids;
  assert(store.page(before, limit, ids, &hasMore, &total, revision));
  return ids;
}

void testLazyBuildAndWarmPagination() {
  resetStorage();
  addValidShot(1);
  addValidShot(3);
  addValidShot(2);
  LittleFS.reverseDirectoryOrder = true;
  LittleFS.addFile("/shots/not-a-shot.bin", validHeader());
  LittleFS.addFile(shotPath(4), {'B', 'A', 'D'});

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  uint32_t revision = 99;
  assert((page(store, 0, 2, hasMore, total, &revision) ==
          std::vector<uint32_t>{3, 2}));
  assert(hasMore);
  assert(total == 3);
  assert(revision == 0);
  assert(LittleFS.directoryOpenCalls == 1);

  assert((page(store, 2, 2, hasMore, total) == std::vector<uint32_t>{1}));
  assert(!hasMore);
  assert(total == 3);
  assert(LittleFS.directoryOpenCalls == 1);
}

void testColdMutationsRemainDiscoverable() {
  resetStorage();
  addValidShot(1);

  ShotStore store;
  assert(store.save(encodableShot()));
  assert(store.erase(1));

  bool hasMore = false;
  size_t total = 0;
  assert((page(store, 0, 20, hasMore, total) == std::vector<uint32_t>{2}));
  assert(total == 1);
}

void testDirectoryFailureIsNotCachedAsEmpty() {
  resetStorage();
  addValidShot(1);
  LittleFS.failDirectoryOpen = true;

  ShotStore store;
  std::vector<uint32_t> ids;
  bool hasMore = false;
  size_t total = 0;
  assert(!store.page(0, 20, ids, &hasMore, &total, nullptr));
  LittleFS.failDirectoryOpen = false;
  assert((page(store, 0, 20, hasMore, total) == std::vector<uint32_t>{1}));
  assert(LittleFS.directoryOpenCalls == 2);
}

void testCacheShowsNewestRecordsWhenHistoryExceedsCap() {
  resetStorage();
  for (uint32_t id = 1; id <= ShotStore::kMaxShots; ++id) addValidShot(id);

  ShotStore boundedStore;
  bool hasMore = false;
  size_t total = 0;
  assert(page(boundedStore, 0, 1, hasMore, total).front() == 250);
  assert(total == ShotStore::kMaxShots);

  for (uint32_t id = 251; id <= 260; ++id) addValidShot(id);
  ShotStore ascendingStore;
  assert((page(ascendingStore, 0, 2, hasMore, total) ==
          std::vector<uint32_t>{260, 259}));
  assert(hasMore);
  assert(total == ShotStore::kMaxShots);

  LittleFS.reverseDirectoryOrder = true;
  ShotStore descendingStore;
  assert((page(descendingStore, 0, 2, hasMore, total) ==
          std::vector<uint32_t>{260, 259}));
  assert(hasMore);
  assert(total == ShotStore::kMaxShots);
}

void testEraseMaintainsUnderCapacityWarmCache() {
  resetStorage();
  addValidShot(1);
  addValidShot(2);
  LittleFS.addFile(shotPath(3), {'B', 'A', 'D'});

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  page(store, 0, 20, hasMore, total);
  const unsigned warmOpenCalls = LittleFS.directoryOpenCalls;

  assert(store.erase(2));
  assert(store.revision() == 1);
  assert((page(store, 0, 20, hasMore, total) == std::vector<uint32_t>{1}));
  assert(total == 1);
  assert(LittleFS.directoryOpenCalls == warmOpenCalls);

  assert(store.erase(3));
  assert(store.revision() == 2);
  assert((page(store, 0, 20, hasMore, total) == std::vector<uint32_t>{1}));
  assert(total == 1);
  assert(LittleFS.directoryOpenCalls == warmOpenCalls);
}

void testEraseFromExactCapacityRebuildsCache() {
  resetStorage();
  for (uint32_t id = 1; id <= ShotStore::kMaxShots; ++id) addValidShot(id);

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  page(store, 0, 1, hasMore, total);
  const unsigned warmOpenCalls = LittleFS.directoryOpenCalls;

  assert(store.erase(250));
  assert(store.revision() == 1);
  assert(
      (page(store, 0, 2, hasMore, total) == std::vector<uint32_t>{249, 248}));
  assert(total == ShotStore::kMaxShots - 1);
  assert(LittleFS.directoryOpenCalls == warmOpenCalls + 1);
}

void testEraseFromOverflowPromotesNewestHiddenRecord() {
  resetStorage();
  for (uint32_t id = 1; id <= 260; ++id) addValidShot(id);

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  assert(
      (page(store, 0, 2, hasMore, total) == std::vector<uint32_t>{260, 259}));
  assert(LittleFS.directoryOpenCalls == 1);

  assert(store.erase(260));
  assert(store.revision() == 1);
  assert(
      (page(store, 0, 2, hasMore, total) == std::vector<uint32_t>{259, 258}));
  assert(total == ShotStore::kMaxShots);
  assert(LittleFS.directoryOpenCalls == 2);
  assert((page(store, 11, 1, hasMore, total) == std::vector<uint32_t>{10}));
  assert(!hasMore);
  assert(LittleFS.directoryOpenCalls == 2);
}

void testSaveMaintainsWarmMembership() {
  resetStorage();
  addValidShot(1);

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  page(store, 0, 20, hasMore, total);
  assert(store.save(encodableShot()));
  const unsigned saveOpenCalls = LittleFS.directoryOpenCalls;

  assert((page(store, 0, 20, hasMore, total) == std::vector<uint32_t>{2, 1}));
  assert(total == 2);
  assert(LittleFS.directoryOpenCalls == saveOpenCalls);
}

void testSaveRotatesAFullWarmCache() {
  resetStorage();
  for (uint32_t id = 1; id <= ShotStore::kMaxShots; ++id) addValidShot(id);

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  page(store, 0, 1, hasMore, total);
  assert(store.save(encodableShot()));
  const unsigned saveOpenCalls = LittleFS.directoryOpenCalls;

  const auto ids = page(store, 0, 2, hasMore, total);
  assert((ids == std::vector<uint32_t>{251, 250}));
  assert(total == ShotStore::kMaxShots);
  assert(!LittleFS.hasFile(shotPath(1)));
  assert(LittleFS.directoryOpenCalls == saveOpenCalls);
}

void testRetentionRemovesValidRecordFromUnderCapacityWarmCache() {
  resetStorage();
  for (uint32_t id = 1; id <= ShotStore::kMaxShots; ++id) addValidShot(id);
  LittleFS.addFile(shotPath(2), {'B', 'A', 'D'});

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  page(store, 0, 1, hasMore, total);
  assert(total == ShotStore::kMaxShots - 1);

  assert(store.save(encodableShot()));
  const unsigned saveOpenCalls = LittleFS.directoryOpenCalls;
  const auto ids = page(store, 0, ShotStore::kMaxShots, hasMore, total);

  assert(total == ShotStore::kMaxShots - 1);
  assert(ids.size() == ShotStore::kMaxShots - 1);
  assert(std::find(ids.begin(), ids.end(), 1) == ids.end());
  assert(!LittleFS.hasFile(shotPath(1)));
  assert(LittleFS.directoryOpenCalls == saveOpenCalls);
}

void testFailedWriteAdvancesColdRevision() {
  resetStorage();
  addValidShot(1);

  ShotStore store;
  LittleFS.setFailWrites(true);
  assert(!store.save(encodableShot()));
  LittleFS.setFailWrites(false);

  assert(store.revision() == 1);
}

void testFailedWriteInvalidatesWarmCacheAndRevision() {
  resetStorage();
  addValidShot(1);

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  uint32_t revision = 0;
  page(store, 0, 20, hasMore, total, &revision);
  assert(revision == 0);

  LittleFS.setFailWrites(true);
  assert(!store.save(encodableShot()));
  LittleFS.setFailWrites(false);
  assert(store.revision() == 1);
  const unsigned failedSaveOpenCalls = LittleFS.directoryOpenCalls;

  assert((page(store, 0, 20, hasMore, total, &revision) ==
          std::vector<uint32_t>{1}));
  assert(revision == 1);
  assert(LittleFS.directoryOpenCalls == failedSaveOpenCalls + 1);
  assert(!LittleFS.hasFile(shotPath(2)));
}

void testFailedRotationKeepsNewestHistoryReadable() {
  resetStorage();
  for (uint32_t id = 1; id <= ShotStore::kMaxShots; ++id) addValidShot(id);

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  page(store, 0, 1, hasMore, total);
  LittleFS.failedRemovals.insert(shotPath(1));
  assert(store.save(encodableShot()));

  assert(
      (page(store, 0, 2, hasMore, total) == std::vector<uint32_t>{251, 250}));
  assert(hasMore);
  assert(total == ShotStore::kMaxShots);
  assert(LittleFS.hasFile(shotPath(1)));
  assert(LittleFS.hasFile(shotPath(251)));
}

}  // namespace

int main() {
  testLazyBuildAndWarmPagination();
  testColdMutationsRemainDiscoverable();
  testDirectoryFailureIsNotCachedAsEmpty();
  testCacheShowsNewestRecordsWhenHistoryExceedsCap();
  testEraseMaintainsUnderCapacityWarmCache();
  testEraseFromExactCapacityRebuildsCache();
  testEraseFromOverflowPromotesNewestHiddenRecord();
  testSaveMaintainsWarmMembership();
  testSaveRotatesAFullWarmCache();
  testRetentionRemovesValidRecordFromUnderCapacityWarmCache();
  testFailedWriteAdvancesColdRevision();
  testFailedWriteInvalidatesWarmCacheAndRevision();
  testFailedRotationKeepsNewestHistoryReadable();
  std::puts("OK: ShotStore cache and retention contracts");
  return 0;
}
