// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include <LittleFS.h>
#include <M5Unified.h>
#include <nvs.h>

#include <array>
#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

#include "apps/extraction/extraction_encoding.h"
#include "apps/extraction/history/ShotStore.h"
#include "apps/extraction/history/shot_metadata_codec.h"
#include "util/crc32.h"
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

std::vector<uint8_t> encodedShot(const Extraction& shot) {
  std::vector<uint8_t> data;
  assert(
      pump_scale::encodeCompact(shot, [&](const uint8_t* bytes, size_t size) {
        data.insert(data.end(), bytes, bytes + size);
        return true;
      }));
  return data;
}

void appendRawCrc(std::vector<uint8_t>& data) {
  pump_scale::Crc32 crc;
  crc.update(data.data(), data.size());
  const size_t offset = data.size();
  data.resize(offset + pump_scale::kShotExtractionCrcBytes);
  pump_scale::writeU32LE(data.data() + offset, crc.value());
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

std::vector<uint8_t> readFile(const std::string& path) {
  File file = LittleFS.open(path.c_str(), "r");
  assert(file);
  std::vector<uint8_t> data(file.size());
  assert(file.readBytes(reinterpret_cast<char*>(data.data()), data.size()) ==
         data.size());
  return data;
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
          std::vector<uint32_t>{4, 3}));
  assert(hasMore);
  assert(total == 4);
  assert(revision == 0);
  assert(LittleFS.directoryOpenCalls == 1);

  assert((page(store, 3, 2, hasMore, total) == std::vector<uint32_t>{2, 1}));
  assert(!hasMore);
  assert(total == 4);
  assert(LittleFS.directoryOpenCalls == 1);
}

void testUnreadableRecordsRemainPageMembers() {
  resetStorage();
  for (uint32_t id = 1; id <= 22; ++id) {
    LittleFS.addFile(shotPath(id), {'B', 'A', 'D'});
  }

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  const auto firstPage = page(store, 0, 20, hasMore, total);
  assert(firstPage.size() == 20);
  assert(firstPage.front() == 22);
  assert(firstPage.back() == 3);
  assert(hasMore);
  assert(total == 22);

  pump_scale::ShotMeta meta{};
  assert(!store.readMeta(firstPage.front(), meta));
  assert((page(store, firstPage.back(), 20, hasMore, total) ==
          std::vector<uint32_t>{2, 1}));
  assert(!hasMore);
  assert(total == 22);
}

void testBinaryReadDistinguishesMissingAndInvalidRecords() {
  resetStorage();
  ShotStore store;
  pump_scale::ShotBinary binary;

  assert(store.readBinary(1, binary) ==
         pump_scale::ShotBinaryReadResult::Missing);

  LittleFS.addFile(shotPath(1), {'B', 'A', 'D'});
  assert(store.readBinary(1, binary) ==
         pump_scale::ShotBinaryReadResult::Invalid);

  LittleFS.failFileOpen = true;
  assert(store.readBinary(1, binary) ==
         pump_scale::ShotBinaryReadResult::Error);
  LittleFS.failFileOpen = false;

  LittleFS.addFile(shotPath(2), encodedShot(encodableShot()));
  assert(store.readBinary(2, binary) == pump_scale::ShotBinaryReadResult::Ok);
  assert(binary.size == encodedShot(encodableShot()).size());
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
  assert((page(store, 0, 20, hasMore, total) == std::vector<uint32_t>{3, 1}));
  assert(total == 2);
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

void testSaveAppendsAndValidatesAbsentEnvelope() {
  resetStorage();
  const Extraction shot = encodableShot();
  size_t rawSize = 0;
  assert(pump_scale::encodeCompactSize(shot, rawSize));

  ShotStore store;
  assert(store.save(shot));
  const std::vector<uint8_t> stored = readFile(shotPath(1));
  assert(stored.size() == rawSize + pump_scale::kShotExtractionCrcBytes +
                              pump_scale::kShotMetadataFooterBytes);

  pump_scale::ShotMetadataFooter footer{};
  const uint8_t* encodedFooter =
      stored.data() + stored.size() - pump_scale::kShotMetadataFooterBytes;
  assert(pump_scale::decodeShotMetadataFooter(encodedFooter, stored.size(),
                                              footer) ==
         pump_scale::ShotMetadataFooterReadResult::Supported);
  assert(footer.state == pump_scale::ShotMetadataStoredState::Absent);
  assert(footer.rawLength == rawSize);
  assert(footer.payloadCapacity == 0);
  assert(pump_scale::validateShotMetadataEnvelope(footer, nullptr, 0,
                                                  encodedFooter));

  pump_scale::Crc32 extractionCrc;
  extractionCrc.update(stored.data(), rawSize);
  assert(pump_scale::readU32LE(stored.data() + rawSize) ==
         extractionCrc.value());

  pump_scale::ShotBinary canonical;
  assert(store.readBinary(1, canonical) ==
         pump_scale::ShotBinaryReadResult::Ok);
  assert(canonical.size == rawSize);
  assert(std::memcmp(canonical.data.get(), stored.data(), rawSize) == 0);
}

void testSaveRejectsCorruptReadback() {
  resetStorage();
  LittleFS.corruptNextWrittenFileOnClose = true;

  ShotStore store;
  assert(!store.save(encodableShot()));
  assert(!LittleFS.hasFile(shotPath(1)));
}

void testRawCrcAndMetadataAreValidatedIndependently() {
  resetStorage();
  std::vector<uint8_t> stored = encodedShot(encodableShot());
  const size_t rawSize = stored.size();
  appendRawCrc(stored);

  constexpr std::array<uint8_t, 7> json = {'{', '"', 'x', '"', ':', '1', '}'};
  constexpr size_t capacity = 32;
  stored.insert(stored.end(), json.begin(), json.end());
  stored.resize(rawSize + pump_scale::kShotExtractionCrcBytes + capacity, 0xA5);
  std::array<uint8_t, pump_scale::kShotMetadataFooterBytes> footer{};
  assert(pump_scale::encodeShotMetadataFooter(
      pump_scale::ShotMetadataStoredState::Active,
      static_cast<uint32_t>(rawSize), json.data(), json.size(), capacity,
      footer.data()));
  stored.insert(stored.end(), footer.begin(), footer.end());
  LittleFS.addFile(shotPath(1), stored);

  ShotStore store;
  pump_scale::ShotBinary binary;
  LittleFS.resetBytesRead();
  assert(store.readBinary(1, binary) == pump_scale::ShotBinaryReadResult::Ok);
  assert(LittleFS.bytesRead() == rawSize + pump_scale::kShotExtractionCrcBytes);

  Extraction decoded;
  LittleFS.resetBytesRead();
  assert(store.load(1, decoded));
  assert(LittleFS.bytesRead() == rawSize + pump_scale::kShotExtractionCrcBytes);

  LittleFS.xorFileByte(shotPath(1), stored.size() - 1, 1);
  assert(store.readBinary(1, binary) == pump_scale::ShotBinaryReadResult::Ok);

  LittleFS.xorFileByte(shotPath(1), 8, 1);
  assert(store.readBinary(1, binary) ==
         pump_scale::ShotBinaryReadResult::Invalid);
}

void testChecksumOnlyAndPartialChecksumRecords() {
  resetStorage();
  std::vector<uint8_t> checksumOnly = encodedShot(encodableShot());
  appendRawCrc(checksumOnly);
  LittleFS.addFile(shotPath(1), checksumOnly);

  ShotStore store;
  pump_scale::ShotBinary binary;
  assert(store.readBinary(1, binary) == pump_scale::ShotBinaryReadResult::Ok);
  LittleFS.xorFileByte(shotPath(1), 8, 1);
  assert(store.readBinary(1, binary) ==
         pump_scale::ShotBinaryReadResult::Invalid);

  std::vector<uint8_t> partialChecksum = encodedShot(encodableShot());
  partialChecksum.push_back(0);
  partialChecksum.push_back(0);
  LittleFS.addFile(shotPath(2), partialChecksum);
  assert(store.readBinary(2, binary) ==
         pump_scale::ShotBinaryReadResult::Invalid);

  std::vector<uint8_t> truncatedMetadata = encodedShot(encodableShot());
  appendRawCrc(truncatedMetadata);
  truncatedMetadata.push_back(0);
  LittleFS.addFile(shotPath(3), truncatedMetadata);
  assert(store.readBinary(3, binary) == pump_scale::ShotBinaryReadResult::Ok);
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

void testRetentionRemovesNamedRecordFromWarmCache() {
  resetStorage();
  for (uint32_t id = 1; id <= ShotStore::kMaxShots; ++id) addValidShot(id);
  LittleFS.addFile(shotPath(2), {'B', 'A', 'D'});

  ShotStore store;
  bool hasMore = false;
  size_t total = 0;
  page(store, 0, 1, hasMore, total);
  assert(total == ShotStore::kMaxShots);

  assert(store.save(encodableShot()));
  const unsigned saveOpenCalls = LittleFS.directoryOpenCalls;
  const auto ids = page(store, 0, ShotStore::kMaxShots, hasMore, total);

  assert(total == ShotStore::kMaxShots);
  assert(ids.size() == ShotStore::kMaxShots);
  assert(std::find(ids.begin(), ids.end(), 1) == ids.end());
  assert(std::find(ids.begin(), ids.end(), 2) != ids.end());
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
  testUnreadableRecordsRemainPageMembers();
  testBinaryReadDistinguishesMissingAndInvalidRecords();
  testColdMutationsRemainDiscoverable();
  testDirectoryFailureIsNotCachedAsEmpty();
  testCacheShowsNewestRecordsWhenHistoryExceedsCap();
  testEraseMaintainsUnderCapacityWarmCache();
  testEraseFromExactCapacityRebuildsCache();
  testEraseFromOverflowPromotesNewestHiddenRecord();
  testSaveMaintainsWarmMembership();
  testSaveAppendsAndValidatesAbsentEnvelope();
  testSaveRejectsCorruptReadback();
  testRawCrcAndMetadataAreValidatedIndependently();
  testChecksumOnlyAndPartialChecksumRecords();
  testSaveRotatesAFullWarmCache();
  testRetentionRemovesNamedRecordFromWarmCache();
  testFailedWriteAdvancesColdRevision();
  testFailedWriteInvalidatesWarmCacheAndRevision();
  testFailedRotationKeepsNewestHistoryReadable();
  std::puts("OK: ShotStore cache and retention contracts");
  return 0;
}
