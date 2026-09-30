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

Extraction encodableShot();

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

std::vector<uint8_t> storedShotWithMetadata(
    pump_scale::ShotMetadataStoredState state, const std::vector<uint8_t>& json,
    size_t capacity) {
  std::vector<uint8_t> stored = encodedShot(encodableShot());
  const size_t rawLength = stored.size();
  appendRawCrc(stored);
  stored.insert(stored.end(), json.begin(), json.end());
  stored.resize(rawLength + pump_scale::kShotExtractionCrcBytes + capacity,
                0xA5);
  std::array<uint8_t, pump_scale::kShotMetadataFooterBytes> footer{};
  assert(pump_scale::encodeShotMetadataFooter(
      state, static_cast<uint32_t>(rawLength), json.data(), json.size(),
      capacity, footer.data()));
  stored.insert(stored.end(), footer.begin(), footer.end());
  return stored;
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

  pump_scale::ShotSummary summary{};
  assert(!store.readSummary(firstPage.front(), summary));
  assert(!summary.available);
  assert((page(store, firstPage.back(), 20, hasMore, total) ==
          std::vector<uint32_t>{2, 1}));
  assert(!hasMore);
  assert(total == 22);
}

void testBinaryReadDistinguishesMissingAndInvalidRecords() {
  resetStorage();
  ShotStore store;
  pump_scale::EncodedExtraction binary;

  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::Missing);

  LittleFS.addFile(shotPath(1), {'B', 'A', 'D'});
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::InvalidRecord);

  LittleFS.failFileOpen = true;
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::Error);
  LittleFS.failFileOpen = false;

  LittleFS.addFile(shotPath(2), encodedShot(encodableShot()));
  assert(store.readEncodedExtraction(2, binary) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(binary.size == encodedShot(encodableShot()).size());
}

void testStoredFileRecoveryReturnsExactPhysicalBytes() {
  resetStorage();
  std::vector<uint8_t> stored = encodedShot(encodableShot());
  appendRawCrc(stored);
  stored.insert(stored.end(), {'d', 'a', 'm', 'a', 'g', 'e', 'd'});
  LittleFS.addFile(shotPath(1), stored);

  ShotStore store;
  storage::FileSnapshot recovered;
  assert(store.readStoredFile(1, recovered) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(recovered.size() == stored.size());
  assert(std::equal(stored.begin(), stored.end(), recovered.data()));

  std::vector<uint8_t> oversized(pump_scale::kMaxRecoverableShotFileBytes + 1,
                                 0xA5);
  LittleFS.addFile(shotPath(2), oversized);
  assert(store.readStoredFile(2, recovered) ==
         pump_scale::ShotStoreReadResult::Error);
  assert(recovered.size() == 0);
  assert(!recovered.data());

  assert(store.readStoredFile(3, recovered) ==
         pump_scale::ShotStoreReadResult::Missing);
  assert(recovered.size() == 0);
  assert(!recovered.data());
}

void testColdMutationsRemainDiscoverable() {
  resetStorage();
  addValidShot(1);

  ShotStore store;
  assert(store.save(encodableShot()) == 2);
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

  pump_scale::EncodedExtraction canonical;
  assert(store.readEncodedExtraction(1, canonical) ==
         pump_scale::ShotStoreReadResult::Ok);
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
  pump_scale::EncodedExtraction binary;
  LittleFS.resetBytesRead();
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(LittleFS.bytesRead() == rawSize + pump_scale::kShotExtractionCrcBytes);

  Extraction decoded;
  LittleFS.resetBytesRead();
  assert(store.load(1, decoded));
  assert(LittleFS.bytesRead() == rawSize + pump_scale::kShotExtractionCrcBytes);

  LittleFS.xorFileByte(shotPath(1), stored.size() - 1, 1);
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::Ok);

  LittleFS.xorFileByte(shotPath(1), 8, 1);
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::InvalidRecord);
}

void testChecksumOnlyAndPartialChecksumRecords() {
  resetStorage();
  std::vector<uint8_t> checksumOnly = encodedShot(encodableShot());
  appendRawCrc(checksumOnly);
  LittleFS.addFile(shotPath(1), checksumOnly);

  ShotStore store;
  pump_scale::EncodedExtraction binary;
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::Ok);
  LittleFS.xorFileByte(shotPath(1), 8, 1);
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::InvalidRecord);

  std::vector<uint8_t> partialChecksum = encodedShot(encodableShot());
  partialChecksum.push_back(0);
  partialChecksum.push_back(0);
  LittleFS.addFile(shotPath(2), partialChecksum);
  assert(store.readEncodedExtraction(2, binary) ==
         pump_scale::ShotStoreReadResult::InvalidRecord);

  std::vector<uint8_t> truncatedMetadata = encodedShot(encodableShot());
  appendRawCrc(truncatedMetadata);
  truncatedMetadata.push_back(0);
  LittleFS.addFile(shotPath(3), truncatedMetadata);
  assert(store.readEncodedExtraction(3, binary) ==
         pump_scale::ShotStoreReadResult::Ok);
}

void testMetadataReadStates() {
  resetStorage();
  const std::vector<uint8_t> bare = encodedShot(encodableShot());
  LittleFS.addFile(shotPath(1), bare);

  std::vector<uint8_t> checksumOnly = encodedShot(encodableShot());
  appendRawCrc(checksumOnly);
  LittleFS.addFile(shotPath(2), checksumOnly);

  const std::vector<uint8_t> json = {'{', '"', 'x', '"', ':', '1', '}'};
  LittleFS.addFile(shotPath(3),
                   storedShotWithMetadata(
                       pump_scale::ShotMetadataStoredState::Active, json, 32));
  LittleFS.addFile(shotPath(4),
                   storedShotWithMetadata(
                       pump_scale::ShotMetadataStoredState::Cleared, {}, 32));

  std::vector<uint8_t> corrupt = storedShotWithMetadata(
      pump_scale::ShotMetadataStoredState::Active, json, 32);
  corrupt.back() ^= 1;
  LittleFS.addFile(shotPath(5), corrupt);

  std::vector<uint8_t> unsupported = storedShotWithMetadata(
      pump_scale::ShotMetadataStoredState::Active, json, 32);
  unsupported[unsupported.size() - pump_scale::kShotMetadataFooterBytes + 4] =
      2;
  LittleFS.addFile(shotPath(6), unsupported);
  LittleFS.addFile(shotPath(7), {'B', 'A', 'D'});
  LittleFS.addFile(shotPath(8), storedShotWithMetadata(
                                    pump_scale::ShotMetadataStoredState::Active,
                                    {'[', ']'}, 2));

  ShotStore store;
  pump_scale::ShotUserMetadata metadata;
  LittleFS.resetBytesRead();
  assert(store.readUserMetadata(1, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.available);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Absent);
  assert(metadata.crc32 == 0);
  assert(LittleFS.bytesRead() ==
         bare.size() + pump_scale::kShotMetadataFooterBytes);
  assert(store.readUserMetadata(2, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Absent);
  assert(metadata.crc32 == 0);
  assert(store.readUserMetadata(3, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Active);
  assert(metadata.json == std::string(json.begin(), json.end()));
  assert(metadata.crc32 != 0);
  assert(store.readUserMetadata(4, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Cleared);
  assert(metadata.json.empty());
  assert(store.readUserMetadata(5, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.available);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Corrupt);
  assert(store.readUserMetadata(6, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.available);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Unsupported);
  assert(store.readUserMetadata(7, metadata) ==
         pump_scale::ShotStoreReadResult::InvalidRecord);
  assert(store.readUserMetadata(8, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Active);
  assert(metadata.json == "[]");
  assert(store.readUserMetadata(9, metadata) ==
         pump_scale::ShotStoreReadResult::Missing);
}

void testMetadataListingDoesNotScanExtractionPayload() {
  resetStorage();
  const std::vector<uint8_t> json = {'{', '"', 'x', '"', ':', '1', '}'};
  std::vector<uint8_t> stored = storedShotWithMetadata(
      pump_scale::ShotMetadataStoredState::Active, json, 32);
  stored[60] ^= 1;  // Damage EXTR outside the compact summary header.
  LittleFS.addFile(shotPath(1), stored);

  ShotStore store;
  LittleFS.resetBytesRead();
  pump_scale::ShotHistoryEntry entry;
  assert(store.readHistoryEntry(1, entry));
  assert(entry.summary.available);
  assert(entry.userMetadata.available);
  assert(entry.userMetadata.state == pump_scale::ShotUserMetadataState::Active);
  assert(entry.userMetadata.json == std::string(json.begin(), json.end()));
  assert(LittleFS.bytesRead() == pump_scale::kCompactHeaderBytes +
                                     pump_scale::kShotMetadataFooterBytes +
                                     json.size());

  pump_scale::ShotUserMetadata metadata;
  LittleFS.resetBytesRead();
  assert(store.readUserMetadata(1, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Active);
  assert(metadata.json == std::string(json.begin(), json.end()));
  assert(LittleFS.bytesRead() ==
         pump_scale::kShotMetadataFooterBytes + json.size());

  assert(!store.readHistoryEntry(2, entry));

  LittleFS.addFile(shotPath(2), encodedShot(encodableShot()));
  assert(store.readHistoryEntry(2, entry));
  assert(entry.summary.available);
  assert(!entry.userMetadata.available);

  std::vector<uint8_t> damagedFooter = storedShotWithMetadata(
      pump_scale::ShotMetadataStoredState::Active, json, 32);
  damagedFooter.back() ^= 1;
  LittleFS.addFile(shotPath(3), damagedFooter);
  assert(store.readHistoryEntry(3, entry));
  assert(entry.summary.available);
  assert(!entry.userMetadata.available);
  assert(store.readUserMetadata(3, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Corrupt);

  pump_scale::EncodedExtraction binary;
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::InvalidRecord);
}

void testMetadataUpdatesRetainExtractionAndCapacity() {
  resetStorage();
  const std::vector<uint8_t> raw = encodedShot(encodableShot());
  LittleFS.addFile(shotPath(1), raw);

  ShotStore store;
  pump_scale::ShotUserMetadata metadata;
  assert(store.readUserMetadata(1, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);

  const std::string first = R"({"coffee":"Ethiopia","notes":"first version"})";
  assert(store.writeUserMetadata(1,
                                 reinterpret_cast<const uint8_t*>(first.data()),
                                 first.size(), metadata, metadata) ==
         pump_scale::ShotUserMetadataWriteResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Active);
  assert(metadata.json == first);
  assert(store.revision() == 1);

  const std::vector<uint8_t> afterFirst = readFile(shotPath(1));
  assert(std::equal(raw.begin(), raw.end(), afterFirst.begin()));
  const size_t expectedSize = raw.size() + pump_scale::kShotExtractionCrcBytes +
                              first.size() +
                              pump_scale::kShotMetadataFooterBytes;
  assert(afterFirst.size() == expectedSize);

  pump_scale::EncodedExtraction binary;
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(binary.size == raw.size());
  assert(std::memcmp(binary.data.get(), raw.data(), raw.size()) == 0);

  const auto stale = pump_scale::ShotUserMetadata{};
  pump_scale::ShotUserMetadata ignored;
  assert(store.writeUserMetadata(1,
                                 reinterpret_cast<const uint8_t*>(first.data()),
                                 first.size(), stale, ignored) ==
         pump_scale::ShotUserMetadataWriteResult::Conflict);
  assert(store.revision() == 1);

  const std::string shorter = R"({"coffee":"Kenya"})";
  const auto firstMetadata = metadata;
  assert(store.writeUserMetadata(
             1, reinterpret_cast<const uint8_t*>(shorter.data()),
             shorter.size(), firstMetadata,
             metadata) == pump_scale::ShotUserMetadataWriteResult::Ok);
  assert(metadata.json == shorter);
  const std::vector<uint8_t> afterShorter = readFile(shotPath(1));
  assert(afterShorter.size() == afterFirst.size());
  const size_t payloadOffset = raw.size() + pump_scale::kShotExtractionCrcBytes;
  assert(std::equal(afterFirst.begin() + payloadOffset + shorter.size(),
                    afterFirst.end() - pump_scale::kShotMetadataFooterBytes,
                    afterShorter.begin() + payloadOffset + shorter.size()));

  const auto shorterMetadata = metadata;
  assert(store.clearUserMetadata(1, shorterMetadata, metadata) ==
         pump_scale::ShotUserMetadataWriteResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Cleared);
  assert(metadata.json.empty());
  assert(readFile(shotPath(1)).size() == expectedSize);
  assert(store.revision() == 3);

  const std::vector<uint8_t> afterClear = readFile(shotPath(1));
  const auto clearedMetadata = metadata;
  assert(store.clearUserMetadata(1, clearedMetadata, metadata) ==
         pump_scale::ShotUserMetadataWriteResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Cleared);
  assert(metadata.crc32 == clearedMetadata.crc32);
  assert(readFile(shotPath(1)) == afterClear);
  assert(store.revision() == 3);
}

void testMetadataInitializationIsFirstWriterWins() {
  resetStorage();
  ShotStore store;
  const uint32_t id = store.save(encodableShot());
  assert(id != 0);

  pump_scale::ShotUserMetadata saved;
  assert(store.readUserMetadata(id, saved) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(saved.state == pump_scale::ShotUserMetadataState::Absent);
  assert(saved.crc32 != 0);

  const std::string first = R"({"coffee":{"name":"First"}})";
  assert(store.initializeUserMetadata(
             id, reinterpret_cast<const uint8_t*>(first.data()), first.size(),
             saved) == pump_scale::ShotUserMetadataWriteResult::Ok);
  assert(saved.state == pump_scale::ShotUserMetadataState::Active);
  assert(saved.json == first);

  const std::string second = R"({"coffee":{"name":"Second"}})";
  assert(store.initializeUserMetadata(
             id, reinterpret_cast<const uint8_t*>(second.data()), second.size(),
             saved) == pump_scale::ShotUserMetadataWriteResult::Conflict);

  assert(store.readUserMetadata(id, saved) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(saved.state == pump_scale::ShotUserMetadataState::Active);
  assert(saved.json == first);
  assert(store.revision() == 2);
}

void testMetadataRepairUsesTheParsedExtractionBoundary() {
  resetStorage();
  const std::vector<uint8_t> json = {'{', '}'};
  std::vector<uint8_t> stored = storedShotWithMetadata(
      pump_scale::ShotMetadataStoredState::Active, json, 32);
  const size_t rawLength = encodedShot(encodableShot()).size();
  const size_t footerOffset =
      stored.size() - pump_scale::kShotMetadataFooterBytes;
  pump_scale::writeU32LE(stored.data() + footerOffset + 6, 1);
  const std::vector<uint8_t> raw(stored.begin(), stored.begin() + rawLength);
  LittleFS.addFile(shotPath(1), stored);

  ShotStore store;
  pump_scale::ShotUserMetadata metadata;
  assert(store.readUserMetadata(1, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Corrupt);

  const std::string replacement = R"({"repaired":true})";
  assert(store.writeUserMetadata(
             1, reinterpret_cast<const uint8_t*>(replacement.data()),
             replacement.size(), metadata,
             metadata) == pump_scale::ShotUserMetadataWriteResult::Ok);
  assert(metadata.json == replacement);
  const std::vector<uint8_t> repaired = readFile(shotPath(1));
  assert(std::equal(raw.begin(), raw.end(), repaired.begin()));
}

void testHealthyMetadataUpdateDoesNotDependOnExtractionIntegrity() {
  resetStorage();
  const std::vector<uint8_t> initial = {'{', '}'};
  std::vector<uint8_t> stored = storedShotWithMetadata(
      pump_scale::ShotMetadataStoredState::Active, initial, initial.size());
  const size_t rawLength = encodedShot(encodableShot()).size();
  stored[8] ^= 1;
  const std::vector<uint8_t> damagedExtraction(stored.begin(),
                                               stored.begin() + rawLength);
  LittleFS.addFile(shotPath(1), stored);

  ShotStore store;
  pump_scale::ShotUserMetadata metadata;
  assert(store.readUserMetadata(1, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Active);

  const std::string replacement = R"({"updated":true})";
  assert(store.writeUserMetadata(
             1, reinterpret_cast<const uint8_t*>(replacement.data()),
             replacement.size(), metadata,
             metadata) == pump_scale::ShotUserMetadataWriteResult::Ok);
  assert(metadata.json == replacement);

  const std::vector<uint8_t> updated = readFile(shotPath(1));
  assert(std::equal(damagedExtraction.begin(), damagedExtraction.end(),
                    updated.begin()));
  pump_scale::EncodedExtraction binary;
  assert(store.readEncodedExtraction(1, binary) ==
         pump_scale::ShotStoreReadResult::InvalidRecord);
}

void testMetadataGrowthLimitAndWriteFailure() {
  resetStorage();
  const std::vector<uint8_t> initial = {'{', '}'};
  LittleFS.addFile(shotPath(1), storedShotWithMetadata(
                                    pump_scale::ShotMetadataStoredState::Active,
                                    initial, initial.size()));

  ShotStore store;
  pump_scale::ShotUserMetadata metadata;
  assert(store.readUserMetadata(1, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);

  std::string maximum = R"({"x":")";
  maximum.append(pump_scale::kMaxShotMetadataJsonBytes - maximum.size() - 2,
                 'x');
  maximum += R"("})";
  assert(maximum.size() == pump_scale::kMaxShotMetadataJsonBytes);
  assert(store.writeUserMetadata(
             1, reinterpret_cast<const uint8_t*>(maximum.data()),
             maximum.size(), metadata,
             metadata) == pump_scale::ShotUserMetadataWriteResult::Ok);
  const size_t rawLength = encodedShot(encodableShot()).size();
  assert(readFile(shotPath(1)).size() ==
         rawLength + pump_scale::kShotExtractionCrcBytes + maximum.size() +
             pump_scale::kShotMetadataFooterBytes);

  const std::string replacement = R"({"x":"unchanged"})";
  const auto expected = metadata;
  const std::vector<uint8_t> beforeFailure = readFile(shotPath(1));
  LittleFS.setFailWrites(true);
  assert(store.writeUserMetadata(
             1, reinterpret_cast<const uint8_t*>(replacement.data()),
             replacement.size(), expected,
             metadata) == pump_scale::ShotUserMetadataWriteResult::Error);
  LittleFS.setFailWrites(false);
  assert(readFile(shotPath(1)) == beforeFailure);
  assert(store.revision() == 2);
}

void testMetadataRejectsUnsupportedAndOversizedTails() {
  resetStorage();
  const std::vector<uint8_t> json = {'{', '}'};
  std::vector<uint8_t> unsupported = storedShotWithMetadata(
      pump_scale::ShotMetadataStoredState::Active, json, 32);
  unsupported[unsupported.size() - pump_scale::kShotMetadataFooterBytes + 4] =
      2;
  LittleFS.addFile(shotPath(1), unsupported);

  std::vector<uint8_t> oversized = encodedShot(encodableShot());
  appendRawCrc(oversized);
  oversized.resize(oversized.size() + pump_scale::kMaxShotMetadataJsonBytes +
                       pump_scale::kShotMetadataFooterBytes + 1,
                   0xA5);
  LittleFS.addFile(shotPath(2), oversized);

  ShotStore store;
  pump_scale::ShotUserMetadata metadata;
  assert(store.readUserMetadata(1, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Unsupported);
  pump_scale::ShotUserMetadata saved;
  assert(
      store.writeUserMetadata(1, json.data(), json.size(), metadata, saved) ==
      pump_scale::ShotUserMetadataWriteResult::Unsupported);

  assert(store.readUserMetadata(2, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(metadata.state == pump_scale::ShotUserMetadataState::Corrupt);
  assert(
      store.writeUserMetadata(2, json.data(), json.size(), metadata, saved) ==
      pump_scale::ShotUserMetadataWriteResult::CannotRepair);

  std::vector<uint8_t> tooLarge(pump_scale::kMaxShotMetadataJsonBytes + 1, 'x');
  assert(store.writeUserMetadata(1, tooLarge.data(), tooLarge.size(), metadata,
                                 saved) ==
         pump_scale::ShotUserMetadataWriteResult::TooLarge);
}

void testMetadataWriteRejectsInvalidJsonWithoutChangingTheRecord() {
  resetStorage();
  const std::string original = R"({"coffee":{"name":"Keep me"},"rating":5})";
  LittleFS.addFile(shotPath(1),
                   storedShotWithMetadata(
                       pump_scale::ShotMetadataStoredState::Active,
                       std::vector<uint8_t>(original.begin(), original.end()),
                       original.size()));
  LittleFS.addFile(shotPath(2), encodedShot(encodableShot()));

  ShotStore store;
  pump_scale::ShotUserMetadata metadata;
  assert(store.readUserMetadata(1, metadata) ==
         pump_scale::ShotStoreReadResult::Ok);
  const auto beforeEdit = readFile(shotPath(1));
  const auto beforeInitialize = readFile(shotPath(2));
  const auto revision = store.revision();

  using Result = pump_scale::ShotUserMetadataWriteResult;
  const struct {
    std::string text;
    Result result;
  } cases[] = {
      {"", Result::InvalidJson},
      {"[]", Result::NotObject},
      {"1", Result::NotObject},
      {"\xEF\xBB\xBF{}", Result::InvalidJson},
      {R"({"rating":01})", Result::InvalidJson},
      {R"({"rating":1.})", Result::InvalidJson},
      {R"({"rating":1,})", Result::InvalidJson},
      {R"({"tags":["a",]})", Result::InvalidJson},
      {std::string("{}\0extra", 8), Result::InvalidJson},
      {"{\f\"rating\":1}", Result::InvalidJson},
      {"{\"notes\":\"\xFF\"}", Result::InvalidJson},
      {"{\"x\":" + std::string(pump_scale::kMaxShotMetadataJsonNesting, '[') +
           "0" + std::string(pump_scale::kMaxShotMetadataJsonNesting, ']') +
           "}",
       Result::InvalidJson},
      {std::string(pump_scale::kMaxShotMetadataJsonBytes + 1, 'x'),
       Result::TooLarge},
  };
  for (const auto& item : cases) {
    pump_scale::ShotUserMetadata ignored;
    const auto* bytes = reinterpret_cast<const uint8_t*>(item.text.data());
    assert(store.writeUserMetadata(1, bytes, item.text.size(), metadata,
                                   ignored) == item.result);
    assert(store.initializeUserMetadata(2, bytes, item.text.size(), ignored) ==
           item.result);
    assert(readFile(shotPath(1)) == beforeEdit);
    assert(readFile(shotPath(2)) == beforeInitialize);
    assert(store.revision() == revision);
  }

  pump_scale::ShotUserMetadata current;
  assert(store.readUserMetadata(1, current) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(current.state == metadata.state);
  assert(current.crc32 == metadata.crc32);
  assert(current.json == original);
}

void testMetadataWritesPreserveJsonText() {
  resetStorage();
  LittleFS.addFile(shotPath(1), encodedShot(encodableShot()));
  ShotStore store;
  const std::string original =
      R"( { "n": 123456789012345678901234567890, "f": 1.2300e+004, "s": "\u0061" } )";
  const auto* bytes = reinterpret_cast<const uint8_t*>(original.data());
  pump_scale::ShotUserMetadata saved;
  assert(store.initializeUserMetadata(1, bytes, original.size(), saved) ==
         pump_scale::ShotUserMetadataWriteResult::Ok);
  assert(saved.json == original);
  assert(store.writeUserMetadata(1, bytes, original.size(), saved, saved) ==
         pump_scale::ShotUserMetadataWriteResult::Ok);
  assert(saved.json == original);

  pump_scale::ShotHistoryEntry entry;
  assert(store.readHistoryEntry(1, entry));
  assert(entry.userMetadata.json == original);
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

void testStorageIdentitySurvivesRestart() {
  resetStorage();
  testNvs.setU32("shots", "store_nonce", 0x87654321);
  ShotStore beforeSleep;
  assert(beforeSleep.shotStoreNonce() == 0x87654321);
  const uint32_t id = beforeSleep.save(encodableShot());
  assert(id != 0);
  pump_scale::ShotUserMetadata before;
  assert(beforeSleep.readUserMetadata(id, before) ==
         pump_scale::ShotStoreReadResult::Ok);

  ShotStore afterWake;
  assert(afterWake.shotStoreNonce() == beforeSleep.shotStoreNonce());
  pump_scale::ShotUserMetadata after;
  assert(afterWake.readUserMetadata(id, after) ==
         pump_scale::ShotStoreReadResult::Ok);
  assert(after.state == before.state && after.crc32 == before.crc32);

  LittleFS.reset();
  ShotStore afterHistoryFormat;
  assert(afterHistoryFormat.shotStoreNonce() == beforeSleep.shotStoreNonce());
  assert(afterHistoryFormat.save(encodableShot()) == id + 1);

  resetStorage();
  ShotStore afterErase;
  assert(afterErase.shotStoreNonce() != beforeSleep.shotStoreNonce());
  assert(afterErase.save(encodableShot()) == id);
}

void testStorageIdentityFallbackStaysFixed() {
  for (auto error : {&testNvs.nextOpenError, &testNvs.nextReadError,
                     &testNvs.nextWriteError, &testNvs.nextCommitError}) {
    resetStorage();
    ShotStore store;
    *error = ESP_FAIL;
    const uint32_t fallback = store.shotStoreNonce();
    assert(fallback != 0 && fallback == store.bootNonce());

    testNvs.setU32("shots", "store_nonce", 0x87654321);
    assert(store.shotStoreNonce() == fallback);
    ShotStore afterRestart;
    assert(afterRestart.shotStoreNonce() == 0x87654321);
  }
  resetStorage();
  testNvs.setU64("shots", "store_nonce", 42);
  ShotStore store;
  assert(store.shotStoreNonce() == store.bootNonce());
}

void testZeroStorageIdentityRecovery() {
  resetStorage();
  testNvs.setU32("shots", "store_nonce", 0);
  testNvs.setU32("shots", "last_id", 57);
  ShotStore store;
  const uint32_t repaired = store.shotStoreNonce();
  assert(repaired != 0);
  assert(testNvs.value("shots", "store_nonce") == repaired);
  assert(testNvs.value("shots", "last_id") == 57);
  ShotStore afterRestart;
  assert(afterRestart.shotStoreNonce() == repaired);
  assert(afterRestart.save(encodableShot()) == 58);

  for (auto error : {&testNvs.nextWriteError, &testNvs.nextCommitError}) {
    resetStorage();
    testNvs.setU32("shots", "store_nonce", 0);
    ShotStore failedRepair;
    *error = ESP_FAIL;
    const uint32_t fallback = failedRepair.shotStoreNonce();
    assert(fallback != 0 && fallback == failedRepair.bootNonce());
    assert(testNvs.value("shots", "store_nonce") == 0);
    assert(failedRepair.shotStoreNonce() == fallback);
    assert(testNvs.value("shots", "store_nonce") == 0);
    ShotStore retryAfterRestart;
    assert(retryAfterRestart.shotStoreNonce() != 0);
    assert(testNvs.value("shots", "store_nonce") != 0);
  }
}

}  // namespace

int main() {
  testStorageIdentitySurvivesRestart();
  testStorageIdentityFallbackStaysFixed();
  testZeroStorageIdentityRecovery();
  testLazyBuildAndWarmPagination();
  testUnreadableRecordsRemainPageMembers();
  testBinaryReadDistinguishesMissingAndInvalidRecords();
  testStoredFileRecoveryReturnsExactPhysicalBytes();
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
  testMetadataReadStates();
  testMetadataListingDoesNotScanExtractionPayload();
  testMetadataUpdatesRetainExtractionAndCapacity();
  testMetadataInitializationIsFirstWriterWins();
  testMetadataRepairUsesTheParsedExtractionBoundary();
  testHealthyMetadataUpdateDoesNotDependOnExtractionIntegrity();
  testMetadataGrowthLimitAndWriteFailure();
  testMetadataRejectsUnsupportedAndOversizedTails();
  testMetadataWriteRejectsInvalidJsonWithoutChangingTheRecord();
  testMetadataWritesPreserveJsonText();
  testSaveRotatesAFullWarmCache();
  testRetentionRemovesNamedRecordFromWarmCache();
  testFailedWriteAdvancesColdRevision();
  testFailedWriteInvalidatesWarmCacheAndRevision();
  testFailedRotationKeepsNewestHistoryReadable();
  std::puts("OK: ShotStore cache and retention contracts");
  return 0;
}
