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
#include "util/json_validate.h"
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

struct StoredExtractionInfo {
  size_t rawLength = 0;
  uint32_t crc = 0;
  bool hasStoredCrc = false;

  size_t storedLength() const {
    return rawLength + (hasStoredCrc ? kShotExtractionCrcBytes : 0);
  }
};

struct StoredMetadataInfo {
  ShotUserMetadata metadata;
  ShotMetadataFooter footer;
  size_t payloadCapacity = 0;
};

enum class StoredMetadataReadResult : uint8_t {
  Valid,
  NoValidFooter,
  UnsupportedVersion,
  Error,
};

using StoredRecordDecoder = std::function<bool(const WireSource&)>;

// Reads the EXTR data through the decoder and checks its CRC if present.
// Metadata bytes after the CRC are ignored.
ShotStoreReadResult readStoredExtraction(storage::FileReader& file,
                                         size_t fileSize,
                                         uint8_t* encodedExtractionBytes,
                                         const StoredRecordDecoder& decoder,
                                         StoredExtractionInfo& out) {
  out = StoredExtractionInfo{};
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
    return readError ? ShotStoreReadResult::Error
                     : ShotStoreReadResult::InvalidRecord;
  }

  out.crc = computedExtractionCrc.value();

  const size_t trailingBytes = fileSize - out.rawLength;
  if (trailingBytes == 0) return ShotStoreReadResult::Ok;
  if (trailingBytes < kShotExtractionCrcBytes) {
    return ShotStoreReadResult::InvalidRecord;
  }

  uint8_t encodedExtractionCrc[kShotExtractionCrcBytes];
  if (!file.readExactly(encodedExtractionCrc, sizeof(encodedExtractionCrc))) {
    return ShotStoreReadResult::Error;
  }
  if (readU32LE(encodedExtractionCrc) != computedExtractionCrc.value()) {
    return ShotStoreReadResult::InvalidRecord;
  }
  out.hasStoredCrc = true;
  return ShotStoreReadResult::Ok;
}

// Reads and validates the user metadata at the end of the file.
StoredMetadataReadResult readStoredMetadata(storage::FileReader& file,
                                            size_t fileSize,
                                            StoredMetadataInfo& out) {
  out = StoredMetadataInfo{};
  if (fileSize < kShotMetadataFooterBytes) {
    return StoredMetadataReadResult::NoValidFooter;
  }

  uint8_t encodedFooter[kShotMetadataFooterBytes];
  if (!file.seek(fileSize - sizeof(encodedFooter)) ||
      !file.readExactly(encodedFooter, sizeof(encodedFooter))) {
    return StoredMetadataReadResult::Error;
  }

  const auto footerResult =
      decodeShotMetadataFooter(encodedFooter, fileSize, out.footer);
  switch (footerResult) {
    case ShotMetadataFooterReadResult::Supported:
      break;
    case ShotMetadataFooterReadResult::UnsupportedVersion:
      out = StoredMetadataInfo{};
      out.metadata.available = true;
      out.metadata.state = ShotUserMetadataState::Unsupported;
      return StoredMetadataReadResult::UnsupportedVersion;
    case ShotMetadataFooterReadResult::MagicMismatch:
    case ShotMetadataFooterReadResult::Corrupt:
      out = StoredMetadataInfo{};
      return StoredMetadataReadResult::NoValidFooter;
  }
  if (out.footer.rawLength < kCompactHeaderBytes ||
      out.footer.rawLength > kMaxCompactRecordBytes) {
    // While this may mean that the footer or the data is corrupt, we can only
    // know for sure by examining the EXTR and making sure this is not part of a
    // legacy record that matches the magic by chance.
    out = StoredMetadataInfo{};
    return StoredMetadataReadResult::NoValidFooter;
  }

  out.payloadCapacity = out.footer.payloadCapacity;
  if (out.footer.jsonLength != 0) {
    out.metadata.json.resize(out.footer.jsonLength);
    if (!file.seek(out.footer.rawLength + kShotExtractionCrcBytes) ||
        !file.readExactly(reinterpret_cast<uint8_t*>(out.metadata.json.data()),
                          out.metadata.json.size())) {
      out.metadata.json.clear();
      return StoredMetadataReadResult::Error;
    }
  }
  if (!validateShotMetadataEnvelope(
          out.footer,
          reinterpret_cast<const uint8_t*>(out.metadata.json.data()),
          out.metadata.json.size(), encodedFooter)) {
    out.metadata.json.clear();
    out = StoredMetadataInfo{};
    // While this may mean that the footer or the data is corrupt, we can only
    // know for sure by examining the EXTR and making sure this is not part of a
    // legacy record that matches the magic by chance.
    return StoredMetadataReadResult::NoValidFooter;
  }

  out.metadata.crc32 = out.footer.metadataCrc;
  out.metadata.available = true;
  switch (out.footer.state) {
    case ShotMetadataStoredState::Absent:
      out.metadata.state = ShotUserMetadataState::Absent;
      break;
    case ShotMetadataStoredState::Active:
      out.metadata.state = ShotUserMetadataState::Active;
      break;
    case ShotMetadataStoredState::Cleared:
      out.metadata.state = ShotUserMetadataState::Cleared;
      break;
  }
  return StoredMetadataReadResult::Valid;
}

// Discerns whether the absence of a valid footer is because it's a legacy bare
// record (metadata absent) or because of potential damage.
StoredMetadataInfo resolveMetadataWithoutValidFooter(
    size_t fileSize, const StoredExtractionInfo& extraction) {
  StoredMetadataInfo out;
  out.metadata.available = true;
  if (fileSize == extraction.storedLength()) {
    // Legacy bare record with no metadata at the end
    out.metadata.state = ShotUserMetadataState::Absent;
    return out;
  }

  // Extra bytes at the end that don't end in a valid footer. Metadata was
  // truncated or damaged.
  out.metadata.state = ShotUserMetadataState::Corrupt;
  if (fileSize > extraction.storedLength()) {
    const size_t tailBytes = fileSize - extraction.storedLength();
    if (tailBytes >= kShotMetadataFooterBytes) {
      out.payloadCapacity = tailBytes - kShotMetadataFooterBytes;
    }
  }
  return out;
}

ShotStoreReadResult openShotFile(const char* path, storage::FileReader& file) {
  switch (file.open(path)) {
    case storage::FileOpenResult::Opened:
      return ShotStoreReadResult::Ok;
    case storage::FileOpenResult::Missing:
      return ShotStoreReadResult::Missing;
    case storage::FileOpenResult::Error:
      return ShotStoreReadResult::Error;
  }
  return ShotStoreReadResult::Error;
}

// Returns the validated, encoded (wire) extraction data without the appended
// envelope.
ShotStoreReadResult readShotFileBytes(const char* path,
                                      std::unique_ptr<uint8_t[]>& encodedBytes,
                                      StoredExtractionInfo& info) {
  storage::FileReader file;
  const auto opened = openShotFile(path, file);
  if (opened != ShotStoreReadResult::Ok) return opened;

  const size_t capacity = std::min(file.size(), kMaxCompactRecordBytes);
  encodedBytes.reset(new (std::nothrow) uint8_t[capacity]);
  if (!encodedBytes) return ShotStoreReadResult::Error;
  return readStoredExtraction(file, file.size(), encodedBytes.get(),
                              scanCompact, info);
}

// Returns a validated, decoded Extraction.
ShotStoreReadResult decodeShotFile(const char* path, Extraction& decoded,
                                   StoredExtractionInfo& info) {
  storage::FileReader file;
  const auto opened = openShotFile(path, file);
  if (opened != ShotStoreReadResult::Ok) return opened;

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

ShotUserMetadataWriteResult validateMetadataWriteInput(
    ShotMetadataStoredState state, const uint8_t* json, size_t jsonLength) {
  if (jsonLength > kMaxShotMetadataJsonBytes) {
    return ShotUserMetadataWriteResult::TooLarge;
  }
  if (state != ShotMetadataStoredState::Active) {
    return json == nullptr && jsonLength == 0
               ? ShotUserMetadataWriteResult::Ok
               : ShotUserMetadataWriteResult::Error;
  }
  if (json == nullptr || jsonLength == 0) {
    return ShotUserMetadataWriteResult::InvalidJson;
  }
  switch (json::validateObject(reinterpret_cast<const char*>(json), jsonLength,
                               kMaxShotMetadataJsonBytes,
                               kMaxShotMetadataJsonNesting)) {
    case json::ObjectValidationResult::Valid:
      return ShotUserMetadataWriteResult::Ok;
    case json::ObjectValidationResult::TooLarge:
      return ShotUserMetadataWriteResult::TooLarge;
    case json::ObjectValidationResult::NotObject:
      return ShotUserMetadataWriteResult::NotObject;
    case json::ObjectValidationResult::InvalidUtf8:
    case json::ObjectValidationResult::InvalidJson:
      return ShotUserMetadataWriteResult::InvalidJson;
  }
  return ShotUserMetadataWriteResult::InvalidJson;
}

bool writeStoredMetadata(storage::FileWriter& file,
                         const StoredExtractionInfo& record,
                         ShotMetadataStoredState state, const uint8_t* json,
                         size_t jsonLength, size_t payloadCapacity) {
  uint8_t encodedFooter[kShotMetadataFooterBytes];
  if (!encodeShotMetadataFooter(state, static_cast<uint32_t>(record.rawLength),
                                json, jsonLength, payloadCapacity,
                                encodedFooter)) {
    return false;
  }

  // Legacy records do not have the EXTR CRC; add it before the metadata.
  if (!record.hasStoredCrc) {
    uint8_t encodedExtractionCrc[kShotExtractionCrcBytes];
    writeU32LE(encodedExtractionCrc, record.crc);
    if (!file.seek(record.rawLength) ||
        !file.writeExactly(encodedExtractionCrc,
                           sizeof(encodedExtractionCrc))) {
      return false;
    }
  }

  const size_t payloadOffset = record.rawLength + kShotExtractionCrcBytes;
  if (jsonLength != 0 &&
      (!file.seek(payloadOffset) || !file.writeExactly(json, jsonLength))) {
    return false;
  }
  return file.seek(payloadOffset + payloadCapacity) &&
         file.writeExactly(encodedFooter, sizeof(encodedFooter));
}

bool verifyStoredMetadata(const char* path, size_t rawLength,
                          ShotMetadataStoredState state, const uint8_t* json,
                          size_t jsonLength, ShotUserMetadata& saved) {
  storage::FileReader file;
  if (file.open(path) != storage::FileOpenResult::Opened) return false;

  StoredMetadataInfo verified;
  if (readStoredMetadata(file, file.size(), verified) !=
          StoredMetadataReadResult::Valid ||
      verified.footer.rawLength != rawLength ||
      verified.metadata.state != (state == ShotMetadataStoredState::Active
                                      ? ShotUserMetadataState::Active
                                      : ShotUserMetadataState::Cleared) ||
      verified.metadata.json.size() != jsonLength ||
      (jsonLength != 0 &&
       std::memcmp(verified.metadata.json.data(), json, jsonLength) != 0)) {
    return false;
  }
  saved = std::move(verified.metadata);
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

bool ShotStore::_readHistoryEntryUnlocked(uint32_t id, ShotSummary& summary,
                                          ShotUserMetadata* userMetadata) {
  summary = ShotSummary{};
  if (userMetadata) {
    *userMetadata = ShotUserMetadata{};
  }
  char path[32];
  _pathFor(id, path, sizeof(path));
  storage::FileReader file;
  if (file.open(path) != storage::FileOpenResult::Opened) return false;

  uint8_t header[kCompactHeaderBytes];
  bool validHeader = false;
  if (file.size() >= sizeof(header)) {
    if (!file.readExactly(header, sizeof(header))) return false;
    validHeader = isValidShotHeader(header, sizeof(header));
  }
  if (userMetadata) {
    StoredMetadataInfo metadata;
    switch (readStoredMetadata(file, file.size(), metadata)) {
      case StoredMetadataReadResult::Valid:
      case StoredMetadataReadResult::UnsupportedVersion:
        *userMetadata = std::move(metadata.metadata);
        break;
      case StoredMetadataReadResult::NoValidFooter:
        break;
      case StoredMetadataReadResult::Error:
        return false;
    }
  }
  if (!validHeader) return true;

  summary.available = true;
  summary.id = id;
  summary.beginMs = readU32LE(header + 8);
  // Unsigned subtraction preserves the duration across a millis() wrap.
  summary.durationMs = readU32LE(header + 20) - summary.beginMs;
  summary.totalPumpOnMs = readU32LE(header + 24);
  summary.startUtcSec = readU32LE(header + 28);
  summary.yieldCg = readI16LE(header + 32);
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

  bool verified = false;
  if (written) {
    storage::FileReader file;
    if (file.open(path) == storage::FileOpenResult::Opened) {
      StoredExtractionInfo extraction;
      const auto extractionResult = readStoredExtraction(
          file, file.size(), nullptr, scanCompact, extraction);
      if (extractionResult == ShotStoreReadResult::Ok &&
          extraction.rawLength == encodedSize && extraction.hasStoredCrc) {
        StoredMetadataInfo metadata;
        verified = readStoredMetadata(file, file.size(), metadata) ==
                       StoredMetadataReadResult::Valid &&
                   metadata.metadata.state == ShotUserMetadataState::Absent &&
                   metadata.footer.rawLength == encodedSize;
      }
    }
  }
  if (verified) return true;

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

bool ShotStore::readSummary(uint32_t id, ShotSummary& out) {
  Lock lock(_mutex);
  return _readHistoryEntryUnlocked(id, out) && out.available;
}

bool ShotStore::readHistoryEntry(uint32_t id, ShotHistoryEntry& out) {
  Lock lock(_mutex);
  out = ShotHistoryEntry{};
  return _readHistoryEntryUnlocked(id, out.summary, &out.userMetadata);
}

ShotStoreReadResult ShotStore::readEncodedExtraction(uint32_t id,
                                                     EncodedExtraction& out) {
  Lock lock(_mutex);
  out = EncodedExtraction{};
  char path[32];
  _pathFor(id, path, sizeof(path));
  std::unique_ptr<uint8_t[]> data;
  StoredExtractionInfo info;
  const auto result = readShotFileBytes(path, data, info);
  if (result == ShotStoreReadResult::Ok) {
    out.data = std::move(data);
    out.size = info.rawLength;
  }
  return result;
}

ShotStoreReadResult ShotStore::readStoredFile(uint32_t id,
                                              storage::FileSnapshot& out) {
  Lock lock(_mutex);
  out = storage::FileSnapshot{};
  char path[32];
  _pathFor(id, path, sizeof(path));
  storage::FileReader file;
  switch (file.open(path)) {
    case storage::FileOpenResult::Missing:
      return ShotStoreReadResult::Missing;
    case storage::FileOpenResult::Error:
      return ShotStoreReadResult::Error;
    case storage::FileOpenResult::Opened:
      break;
  }
  const size_t fileSize = file.size();
  if (fileSize > kMaxRecoverableShotFileBytes) {
    M5_LOGE("ShotStore: recovery file too large size=%u limit=%u",
            static_cast<unsigned>(fileSize),
            static_cast<unsigned>(kMaxRecoverableShotFileBytes));
    return ShotStoreReadResult::Error;
  }
  return out.read(file, kMaxRecoverableShotFileBytes)
             ? ShotStoreReadResult::Ok
             : ShotStoreReadResult::Error;
}

bool ShotStore::load(uint32_t id, Extraction& out) {
  Lock lock(_mutex);
  char path[32];
  _pathFor(id, path, sizeof(path));
  StoredExtractionInfo info;
  return decodeShotFile(path, out, info) == ShotStoreReadResult::Ok;
}

ShotStoreReadResult ShotStore::readUserMetadata(uint32_t id,
                                                ShotUserMetadata& out) {
  Lock lock(_mutex);
  out = ShotUserMetadata{};
  char path[32];
  _pathFor(id, path, sizeof(path));
  storage::FileReader file;
  const auto opened = openShotFile(path, file);
  if (opened != ShotStoreReadResult::Ok) return opened;

  StoredMetadataInfo metadata;
  switch (readStoredMetadata(file, file.size(), metadata)) {
    case StoredMetadataReadResult::Valid:
    case StoredMetadataReadResult::UnsupportedVersion:
      out = std::move(metadata.metadata);
      return ShotStoreReadResult::Ok;
    case StoredMetadataReadResult::Error:
      return ShotStoreReadResult::Error;
    case StoredMetadataReadResult::NoValidFooter:
      break;
  }

  // Differentiate between metadata absent in a legacy record without a footer,
  // and record with corrupt metadata by finding out if there's extra bytes
  // after the extraction data.
  if (!file.seek(0)) return ShotStoreReadResult::Error;
  StoredExtractionInfo extraction;
  const auto extractionResult =
      readStoredExtraction(file, file.size(), nullptr, scanCompact, extraction);
  if (extractionResult != ShotStoreReadResult::Ok) return extractionResult;
  out = resolveMetadataWithoutValidFooter(file.size(), extraction).metadata;
  return ShotStoreReadResult::Ok;
}

ShotUserMetadataWriteResult ShotStore::_writeUserMetadataUnlocked(
    uint32_t id, const uint8_t* json, size_t jsonLength,
    ShotMetadataStoredState newState, const ShotUserMetadata& expected,
    ShotUserMetadata& saved) {
  const bool expectedAvailable = expected.available;
  const ShotUserMetadataState expectedState = expected.state;
  const uint32_t expectedCrc = expected.crc32;
  saved = ShotUserMetadata{};
  const auto inputResult =
      validateMetadataWriteInput(newState, json, jsonLength);
  if (inputResult != ShotUserMetadataWriteResult::Ok) return inputResult;
  if (!expectedAvailable) return ShotUserMetadataWriteResult::Conflict;

  char path[32];
  _pathFor(id, path, sizeof(path));
  StoredExtractionInfo record;
  StoredMetadataInfo current;
  {
    storage::FileReader file;
    switch (openShotFile(path, file)) {
      case ShotStoreReadResult::Missing:
        return ShotUserMetadataWriteResult::Missing;
      case ShotStoreReadResult::InvalidRecord:
        return ShotUserMetadataWriteResult::InvalidRecord;
      case ShotStoreReadResult::Error:
        return ShotUserMetadataWriteResult::Error;
      case ShotStoreReadResult::Ok:
        break;
    }
    const size_t fileSize = file.size();
    const auto metadataResult = readStoredMetadata(file, fileSize, current);
    switch (metadataResult) {
      case StoredMetadataReadResult::Valid:
        record.rawLength = current.footer.rawLength;
        record.hasStoredCrc = true;
        break;
      case StoredMetadataReadResult::UnsupportedVersion:
        break;
      case StoredMetadataReadResult::Error:
        return ShotUserMetadataWriteResult::Error;
      case StoredMetadataReadResult::NoValidFooter:
        if (!file.seek(0)) return ShotUserMetadataWriteResult::Error;
        switch (readStoredExtraction(file, fileSize, nullptr, scanCompact,
                                     record)) {
          case ShotStoreReadResult::InvalidRecord:
            return ShotUserMetadataWriteResult::InvalidRecord;
          case ShotStoreReadResult::Missing:
          case ShotStoreReadResult::Error:
            return ShotUserMetadataWriteResult::Error;
          case ShotStoreReadResult::Ok:
            break;
        }
        current = resolveMetadataWithoutValidFooter(fileSize, record);
        break;
    }
  }

  if (current.metadata.state != expectedState ||
      current.metadata.crc32 != expectedCrc) {
    return ShotUserMetadataWriteResult::Conflict;
  }
  if (current.metadata.state == ShotUserMetadataState::Unsupported) {
    return ShotUserMetadataWriteResult::Unsupported;
  }
  if (newState == ShotMetadataStoredState::Cleared &&
      current.metadata.state == ShotUserMetadataState::Cleared) {
    saved = current.metadata;
    return ShotUserMetadataWriteResult::Ok;
  }
  if (current.metadata.state == ShotUserMetadataState::Corrupt &&
      current.payloadCapacity > kMaxShotMetadataJsonBytes) {
    return ShotUserMetadataWriteResult::CannotRepair;
  }

  const size_t payloadCapacity = std::max(current.payloadCapacity, jsonLength);

  {
    storage::FileWriter file;
    if (!file.openForUpdate(path)) return ShotUserMetadataWriteResult::Error;
    ++_revision;
    if (!writeStoredMetadata(file, record, newState, json, jsonLength,
                             payloadCapacity) ||
        !file.close()) {
      return ShotUserMetadataWriteResult::Error;
    }
  }

  if (!verifyStoredMetadata(path, record.rawLength, newState, json, jsonLength,
                            saved)) {
    return ShotUserMetadataWriteResult::Error;
  }
  return ShotUserMetadataWriteResult::Ok;
}

ShotUserMetadataWriteResult ShotStore::writeUserMetadata(
    uint32_t id, const uint8_t* json, size_t jsonLength,
    const ShotUserMetadata& expected, ShotUserMetadata& saved) {
  Lock lock(_mutex);
  return _writeUserMetadataUnlocked(
      id, json, jsonLength, ShotMetadataStoredState::Active, expected, saved);
}

ShotUserMetadataWriteResult ShotStore::clearUserMetadata(
    uint32_t id, const ShotUserMetadata& expected, ShotUserMetadata& saved) {
  Lock lock(_mutex);
  return _writeUserMetadataUnlocked(
      id, nullptr, 0, ShotMetadataStoredState::Cleared, expected, saved);
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

  ShotSummary summary{};
  for (auto it = ids.rbegin(); it != ids.rend(); ++it) {
    if (_readHistoryEntryUnlocked(*it, summary) && summary.available) {
      return *it;
    }
  }
  return 0;
}

uint32_t ShotStore::revision() {
  Lock lock(_mutex);
  return _revision;
}

}  // namespace pump_scale
