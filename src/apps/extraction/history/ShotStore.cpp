// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "ShotStore.h"

#include <LittleFS.h>
#include <M5Unified.h>
#include <esp_random.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <functional>
#include <new>

#include "apps/extraction/extraction_encoding.h"
#include "shot_id_reservation.h"
#include "shot_metadata_codec.h"
#include "util/crc32.h"
#include "util/scoped_lock.h"
#include "util/storage.h"
#include "util/storage_file_access.h"

namespace pump_scale {
namespace {
constexpr const char* kShotsDir = "/shots";

using Lock = ScopedLock;

uint32_t parseIdFromName(const char* name) {
  // LittleFS ports differ on whether name() includes the directory prefix.
  const char* slash = std::strrchr(name, '/');
  const char* base = slash ? slash + 1 : name;
  if (std::strlen(base) != shot_store_detail::kShotIdDigits + 4 ||
      std::strcmp(base + shot_store_detail::kShotIdDigits, ".bin") != 0) {
    return 0;
  }

  uint32_t id = 0;
  for (size_t i = 0; i < shot_store_detail::kShotIdDigits; ++i) {
    if (base[i] < '0' || base[i] > '9') return 0;
    id = id * 10 + static_cast<uint32_t>(base[i] - '0');
  }
  return id;
}

bool hasSupportedShotHeader(const uint8_t* header) {
  return header[0] == 'E' && header[1] == 'X' && header[2] == 'T' &&
         header[3] == 'R' && isCompactVersionSupported(header[4]);
}

bool isValidShotHeader(const uint8_t* header, size_t size) {
  return size == kCompactHeaderBytes && hasSupportedShotHeader(header);
}

struct StoredRecordInfo {
  size_t rawLength = 0;
  bool hasExtractionCrc = false;
};

using StoredRecordDecoder = std::function<bool(const WireSource&)>;

// Reads the EXTR data through the decoder and checks its CRC if present.
// Metadata bytes after the CRC are ignored.
ShotBinaryReadResult readStoredExtraction(storage::FileReader& file,
                                          size_t fileSize,
                                          uint8_t* encodedExtractionBytes,
                                          const StoredRecordDecoder& decoder,
                                          StoredRecordInfo& out) {
  out = StoredRecordInfo{};
  Crc32 computedExtractionCrc;
  bool readError = false;
  const size_t capacity = std::min(fileSize, kMaxCompactRecordBytes);
  const WireSource source = [&](uint8_t* destination, size_t length) {
    if (out.rawLength + length > capacity) return false;
    if (!file.readExactly(destination, length)) {
      readError = out.rawLength + length <= fileSize;
      return false;
    }
    if (encodedExtractionBytes) {
      std::memcpy(encodedExtractionBytes + out.rawLength, destination, length);
    }
    computedExtractionCrc.update(destination, length);
    out.rawLength += length;
    return true;
  };
  if (!decoder(source)) {
    return readError ? ShotBinaryReadResult::Error
                     : ShotBinaryReadResult::Invalid;
  }

  const size_t trailingBytes = fileSize - out.rawLength;
  if (trailingBytes == 0) return ShotBinaryReadResult::Ok;
  if (trailingBytes < kShotExtractionCrcBytes) {
    return ShotBinaryReadResult::Invalid;
  }

  uint8_t encodedExtractionCrc[kShotExtractionCrcBytes];
  if (!file.readExactly(encodedExtractionCrc, sizeof(encodedExtractionCrc))) {
    return ShotBinaryReadResult::Error;
  }
  if (readU32LE(encodedExtractionCrc) != computedExtractionCrc.value()) {
    return ShotBinaryReadResult::Invalid;
  }
  out.hasExtractionCrc = true;
  return ShotBinaryReadResult::Ok;
}

bool verifyRecord(const char* path, size_t expectedRawLength) {
  storage::FileReader file;
  if (file.open(path) != storage::FileOpenResult::Opened) return false;

  const size_t fileSize = file.size();
  StoredRecordInfo info;
  if (readStoredExtraction(file, fileSize, nullptr, scanCompact, info) !=
          ShotBinaryReadResult::Ok ||
      info.rawLength != expectedRawLength || !info.hasExtractionCrc ||
      fileSize != expectedRawLength + kShotExtractionCrcBytes +
                      kShotMetadataFooterBytes) {
    return false;
  }

  uint8_t encodedFooter[kShotMetadataFooterBytes];
  if (!file.seek(fileSize - sizeof(encodedFooter)) ||
      !file.readExactly(encodedFooter, sizeof(encodedFooter))) {
    return false;
  }
  ShotMetadataFooter footer;
  return decodeShotMetadataFooter(encodedFooter, fileSize, footer) ==
             ShotMetadataFooterReadResult::Supported &&
         footer.state == ShotMetadataStoredState::Absent &&
         footer.rawLength == expectedRawLength && footer.jsonLength == 0 &&
         validateShotMetadataEnvelope(footer, nullptr, 0, encodedFooter);
}

ShotBinaryReadResult openShotFile(const char* path, storage::FileReader& file) {
  switch (file.open(path)) {
    case storage::FileOpenResult::Opened:
      return ShotBinaryReadResult::Ok;
    case storage::FileOpenResult::Missing:
      return ShotBinaryReadResult::Missing;
    case storage::FileOpenResult::Error:
      return ShotBinaryReadResult::Error;
  }
  return ShotBinaryReadResult::Error;
}

// Returns the validated, encoded (wire) extraction data without the appended
// envelope.
ShotBinaryReadResult readShotFileBytes(const char* path,
                                       std::unique_ptr<uint8_t[]>& encodedBytes,
                                       StoredRecordInfo& info) {
  storage::FileReader file;
  const auto opened = openShotFile(path, file);
  if (opened != ShotBinaryReadResult::Ok) return opened;

  const size_t capacity = std::min(file.size(), kMaxCompactRecordBytes);
  encodedBytes.reset(new (std::nothrow) uint8_t[capacity]);
  if (!encodedBytes) return ShotBinaryReadResult::Error;
  return readStoredExtraction(file, file.size(), encodedBytes.get(),
                              scanCompact, info);
}

// Returns a validated, decoded Extraction.
ShotBinaryReadResult decodeShotFile(const char* path, Extraction& decoded,
                                    StoredRecordInfo& info) {
  storage::FileReader file;
  const auto opened = openShotFile(path, file);
  if (opened != ShotBinaryReadResult::Ok) return opened;

  const StoredRecordDecoder decoder = [&](const WireSource& source) {
    return decodeCompact(source, decoded);
  };
  return readStoredExtraction(file, file.size(), nullptr, decoder, info);
}

bool writeRecord(storage::FileWriter& file, const Extraction& ext,
                 size_t encodedSize) {
  Crc32 extractionCrc;
  if (!encodeCompact(ext, [&](const uint8_t* data, size_t len) {
        if (!file.writeExactly(data, len)) return false;
        extractionCrc.update(data, len);
        return true;
      })) {
    return false;
  }

  uint8_t extractionCrcBytes[kShotExtractionCrcBytes];
  writeU32LE(extractionCrcBytes, extractionCrc.value());
  if (!file.writeExactly(extractionCrcBytes, sizeof(extractionCrcBytes))) {
    return false;
  }

  uint8_t footer[kShotMetadataFooterBytes];
  if (!encodeShotMetadataFooter(ShotMetadataStoredState::Absent,
                                static_cast<uint32_t>(encodedSize), nullptr, 0,
                                0, footer) ||
      !file.writeExactly(footer, sizeof(footer))) {
    return false;
  }
  return true;
}
}  // namespace

ShotStore::ShotStore() : _mutex(xSemaphoreCreateMutex()) {
  _bootNonce = esp_random();
}

ShotStore::~ShotStore() {
  if (_mutex) {
    vSemaphoreDelete(_mutex);
    _mutex = nullptr;
  }
}

void ShotStore::_pathFor(uint32_t id, char* buf, size_t cap) {
  std::snprintf(buf, cap, "%s/%0*u.bin", kShotsDir,
                static_cast<int>(shot_store_detail::kShotIdDigits),
                static_cast<unsigned>(id));
}

bool ShotStore::_scanIdsUnlocked(std::vector<uint32_t>& ids) {
  ids.clear();
  storage::DirectoryReader directory;
  const auto opened = directory.open(kShotsDir);
  if (opened == storage::DirectoryOpenResult::Missing) return true;
  if (opened == storage::DirectoryOpenResult::Error) return false;

  const char* name = nullptr;
  storage::DirectoryReadResult readResult;
  while ((readResult = directory.next(name)) ==
         storage::DirectoryReadResult::Entry) {
    const uint32_t id = parseIdFromName(name);
    if (id != 0) ids.push_back(id);
  }
  if (readResult == storage::DirectoryReadResult::Error) return false;
  std::sort(ids.begin(), ids.end());
  return true;
}

bool ShotStore::_buildShotIdCacheUnlocked() {
  _cachedShotIdCount = 0;
  _shotIdCacheValid = false;
  bool overflow = false;
  storage::DirectoryReader directory;
  const auto opened = directory.open(kShotsDir);
  if (opened == storage::DirectoryOpenResult::Missing) {
    _shotIdCacheValid = true;
    return true;
  }
  if (opened == storage::DirectoryOpenResult::Error) return false;

  const char* name = nullptr;
  storage::DirectoryReadResult readResult;
  while ((readResult = directory.next(name)) ==
         storage::DirectoryReadResult::Entry) {
    const uint32_t id = parseIdFromName(name);
    if (id != 0) {
      if (_cachedShotIdCount < _cachedShotIds.size()) {
        _cachedShotIds[_cachedShotIdCount++] = id;
      } else {
        overflow = true;
        const auto oldest =
            std::min_element(_cachedShotIds.begin(),
                             _cachedShotIds.begin() + _cachedShotIdCount);
        if (id > *oldest) *oldest = id;
      }
    }
  }
  if (readResult == storage::DirectoryReadResult::Error) {
    _cachedShotIdCount = 0;
    return false;
  }

  std::sort(_cachedShotIds.begin(), _cachedShotIds.begin() + _cachedShotIdCount,
            std::greater<uint32_t>());
  if (overflow) {
    M5_LOGW("ShotStore: showing newest %u shot files; history exceeds cap",
            static_cast<unsigned>(_cachedShotIds.size()));
  }
  _shotIdCacheValid = true;
  return true;
}

void ShotStore::_invalidateShotIdCacheUnlocked() {
  // A failed save may leave a record behind if cleanup also fails, so advance
  // the list validator even when there is no valid index to discard.
  ++_revision;
  if (!_shotIdCacheValid) return;
  _cachedShotIdCount = 0;
  _shotIdCacheValid = false;
}

void ShotStore::_cacheAddedShotUnlocked(uint32_t id) {
  if (!_shotIdCacheValid) return;
  if (_cachedShotIdCount == _cachedShotIds.size()) {
    // Reserved IDs are monotonic, so a new record becomes the first entry and
    // the oldest logical entry falls outside the bounded history view.
    std::move_backward(_cachedShotIds.begin(), _cachedShotIds.end() - 1,
                       _cachedShotIds.end());
    _cachedShotIds[0] = id;
    return;
  }
  std::move_backward(_cachedShotIds.begin(),
                     _cachedShotIds.begin() + _cachedShotIdCount,
                     _cachedShotIds.begin() + _cachedShotIdCount + 1);
  _cachedShotIds[0] = id;
  ++_cachedShotIdCount;
}

void ShotStore::_cacheRemovedShotUnlocked(uint32_t id) {
  if (!_shotIdCacheValid) return;
  const auto end = _cachedShotIds.begin() + _cachedShotIdCount;
  const auto found = std::find(_cachedShotIds.begin(), end, id);
  // When the directory exceeds the cache limit, its oldest IDs are not cached.
  if (found == end) return;
  std::move(found + 1, end, found);
  --_cachedShotIdCount;
}

bool ShotStore::_readMetaUnlocked(uint32_t id, ShotMeta& out) {
  out = ShotMeta{};
  char path[32];
  _pathFor(id, path, sizeof(path));
  uint8_t header[kCompactHeaderBytes];
  if (!storage::readFilePrefix(path, header, sizeof(header)) ||
      !isValidShotHeader(header, sizeof(header))) {
    return false;
  }

  out.id = id;
  out.beginMs = readU32LE(header + 8);
  // Unsigned subtraction preserves the duration across a millis() wrap.
  out.durationMs = readU32LE(header + 20) - out.beginMs;
  out.totalPumpOnMs = readU32LE(header + 24);
  out.startUtcSec = readU32LE(header + 28);
  out.yieldCg = readI16LE(header + 32);
  return true;
}

// Writes a new record and verifies it by reading it immediately after.
bool ShotStore::_writeRecordUnlocked(const Extraction& ext, uint32_t id,
                                     size_t encodedSize) {
  char path[32];
  _pathFor(id, path, sizeof(path));
  bool written = false;
  {
    storage::FileWriter file;
    if (!file.open(path)) {
      M5_LOGE("ShotStore: cannot open %s", path);
      return false;
    }
    written = writeRecord(file, ext, encodedSize) && file.close();
  }
  if (written && verifyRecord(path, encodedSize)) return true;

  if (!LittleFS.remove(path)) {
    M5_LOGW("ShotStore: could not remove incomplete %s", path);
  }
  M5_LOGE("ShotStore: write verification failed for %s", path);
  return false;
}

void ShotStore::_enforceRetentionUnlocked(const std::vector<uint32_t>& ids) {
  const size_t removeCount =
      ids.size() > kMaxShots ? ids.size() - kMaxShots : 0;
  for (size_t index = 0; index < removeCount; ++index) {
    char path[32];
    _pathFor(ids[index], path, sizeof(path));
    if (!LittleFS.remove(path)) {
      M5_LOGE("ShotStore: cannot remove oldest record %s", path);
      break;
    }
    _cacheRemovedShotUnlocked(ids[index]);
    ++_revision;
  }
}

bool ShotStore::save(const Extraction& ext) {
  Lock lock(_mutex);
  if (storage::mountState() != storage::MountState::Ready) {
    M5_LOGE("ShotStore: storage unavailable");
    return false;
  }
  if (ext.version != kCurrentExtractionVersion) {
    M5_LOGE("ShotStore: refusing to persist non-current record");
    return false;
  }
  size_t encodedSize = 0;
  if (!encodeCompactSize(ext, encodedSize)) {
    M5_LOGE("ShotStore: record version cannot be encoded");
    return false;
  }
  if (!LittleFS.exists(kShotsDir) && !LittleFS.mkdir(kShotsDir)) {
    M5_LOGE("ShotStore: cannot create %s", kShotsDir);
    return false;
  }

  std::vector<uint32_t> ids;
  if (!_scanIdsUnlocked(ids)) return false;

  const uint32_t greatestExistingShotId = ids.empty() ? 0 : ids.back();
  const uint32_t id =
      shot_store_detail::reserveNextShotId(greatestExistingShotId);
  if (id == 0) return false;

  if (!_writeRecordUnlocked(ext, id, encodedSize)) {
    _invalidateShotIdCacheUnlocked();
    return false;
  }

  ++_revision;
  ids.push_back(id);
  _enforceRetentionUnlocked(ids);
  _cacheAddedShotUnlocked(id);

  M5_LOGI("ShotStore: saved shot id=%u", static_cast<unsigned>(id));
  return true;
}

bool ShotStore::page(uint32_t before, size_t limit, std::vector<uint32_t>& ids,
                     bool* hasMore, size_t* total, uint32_t* outRevision) {
  Lock lock(_mutex);
  ids.clear();
  if (!_shotIdCacheValid && !_buildShotIdCacheUnlocked()) return false;

  // The page and its ETag revision describe the same locked filesystem view.
  if (outRevision) *outRevision = _revision;
  if (total) *total = _cachedShotIdCount;

  size_t eligibleCount = 0;
  for (size_t index = 0; index < _cachedShotIdCount; ++index) {
    const uint32_t id = _cachedShotIds[index];
    if (before != 0 && id >= before) continue;
    ++eligibleCount;
    if (ids.size() < limit) ids.push_back(id);
  }
  if (hasMore) *hasMore = eligibleCount > ids.size();
  return true;
}

bool ShotStore::readMeta(uint32_t id, ShotMeta& out) {
  Lock lock(_mutex);
  return _readMetaUnlocked(id, out);
}

ShotBinaryReadResult ShotStore::readBinary(uint32_t id, ShotBinary& out) {
  Lock lock(_mutex);
  out = ShotBinary{};
  char path[32];
  _pathFor(id, path, sizeof(path));
  std::unique_ptr<uint8_t[]> data;
  StoredRecordInfo info;
  const auto result = readShotFileBytes(path, data, info);
  if (result == ShotBinaryReadResult::Ok) {
    out.data = std::move(data);
    out.size = info.rawLength;
  }
  return result;
}

bool ShotStore::load(uint32_t id, Extraction& out) {
  Lock lock(_mutex);
  char path[32];
  _pathFor(id, path, sizeof(path));
  StoredRecordInfo info;
  return decodeShotFile(path, out, info) == ShotBinaryReadResult::Ok;
}

bool ShotStore::erase(uint32_t id) {
  Lock lock(_mutex);
  char path[32];
  _pathFor(id, path, sizeof(path));
  if (!LittleFS.remove(path)) return false;
  // Below capacity no records were omitted, so incremental removal is safe. A
  // full cache may be truncated and needs a rebuild to promote the next ID.
  if (_shotIdCacheValid && _cachedShotIdCount < _cachedShotIds.size()) {
    _cacheRemovedShotUnlocked(id);
    ++_revision;
  } else if (_shotIdCacheValid) {
    _invalidateShotIdCacheUnlocked();
  } else {
    ++_revision;
  }
  return true;
}

uint32_t ShotStore::newestId() {
  Lock lock(_mutex);
  std::vector<uint32_t> ids;
  if (!_scanIdsUnlocked(ids)) return 0;

  ShotMeta meta{};
  for (auto it = ids.rbegin(); it != ids.rend(); ++it) {
    if (_readMetaUnlocked(*it, meta)) return *it;
  }
  return 0;
}

uint32_t ShotStore::revision() {
  Lock lock(_mutex);
  return _revision;
}

}  // namespace pump_scale
