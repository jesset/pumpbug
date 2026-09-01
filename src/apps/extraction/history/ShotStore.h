// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "apps/extraction/Extraction.h"
#include "apps/extraction/ExtractionWire.h"
#include "apps/extraction/history/shot_metadata_codec.h"
#include "util/storage_file_access.h"

namespace pump_scale {

struct ShotSummary {
  bool available = false;  // false indicates the EXTR header was damaged
  uint32_t id = 0;
  uint32_t startUtcSec = 0;
  uint32_t beginMs = 0;
  uint32_t durationMs = 0;
  uint32_t totalPumpOnMs = 0;
  int16_t yieldCg = 0;
};

enum class ShotUserMetadataState : uint8_t {
  Absent,
  Active,
  Cleared,
  Corrupt,
  Unsupported,
};

struct ShotUserMetadata {
  bool available = false;  // false indicates `state` is unknown due to a
                           // missing or damaged PBMD footer; decoding the
                           // entire record can discern and set `state`
  ShotUserMetadataState state = ShotUserMetadataState::Absent;
  std::string json;
  uint32_t crc32 = 0;
};

struct ShotHistoryEntry {
  ShotSummary summary;
  ShotUserMetadata userMetadata;
};

struct EncodedExtraction {
  std::unique_ptr<uint8_t[]> data;
  size_t size = 0;
};

enum class ShotStoreReadResult : uint8_t {
  Ok,
  Missing,
  InvalidRecord,
  Error,
};

enum class ShotUserMetadataWriteResult : uint8_t {
  Ok,
  Missing,
  InvalidRecord,
  InvalidJson,
  NotObject,
  Unsupported,
  Conflict,
  CannotRepair,
  TooLarge,
  Error,
};

inline constexpr size_t kMaxStoredShotRecordBytes =
    kMaxCompactRecordBytes + kShotExtractionCrcBytes +
    kMaxShotMetadataJsonBytes + kShotMetadataFooterBytes;
inline constexpr size_t kMaxRecoverableShotFileBytes =
    2 * kMaxStoredShotRecordBytes;
// With the current filesystem settings, 3 filesystem blocks can fit files up to
// 12,276 bytes long. Measured with mklittlefs 0.2.3-35-g943d2f7.
static_assert(kMaxStoredShotRecordBytes <= 12276,
              "maximum shot record no longer fits in three data blocks");

// Persistent FIFO of finalized extractions.
//
// Records are compact blobs named /shots/00000001.bin, with a monotonically
// increasing eight-digit ID. We use a 4.375 MiB history partition and limit
// history to at most 250 records and each record to three filesystem data
// blocks. This effectively caps shot history size to about 67% of the partition
// size, not including filesystem metadata.
//
// Every file begins with the EXTR extraction record: a fixed 54-byte header,
// variable-length events, variable-length samples, and a fixed 20-byte
// target/alarm block. See ExtractionWire.
//
// Stored files use one of these layouts:
//
//   EXTR
//   EXTR | EXTR CRC32
//   EXTR | EXTR CRC32 | user metadata JSON | inactive capacity | PBMD footer
//
// EXTR-only ("bare") files are from earlier firmware versions. Records written
// by this firmware include the EXTR CRC and the metadata trailer, but a record
// without metadata (or with corrupt metadata) can also be read as long as
// there's no CRC or the CRC matches. See shot_metadata_codec.h.
//
// Each save writes and verifies the new record before removing older records.
// A failed write therefore preserves the existing history. History listing
// uses a lazy in-memory index so pagination does not rescan the filesystem for
// every page.
class ShotStore {
 public:
  static constexpr size_t kMaxShots = 250;

  ShotStore();
  ~ShotStore();

  // Writes and verifies `ext`, then enforces FIFO retention. Returns the
  // allocated shot ID. If the record cannot be saved, it returns zero and
  // doesn't rotate existing history.
  uint32_t save(const Extraction& ext);

  // Produces a newest-first page from files named /shots/NNNNNNNN.bin with id
  // < `before`; before == 0 starts at the newest file. At most the newest
  // kMaxShots files are visible, and `total` reports that bounded count.
  // Records are not checked for integrity, just for existence. Returns false if
  // the directory cannot be read.
  bool page(uint32_t before, size_t limit, std::vector<uint32_t>& ids,
            bool* hasMore, size_t* total, uint32_t* outRevision);

  // Reads one record's compact summary without decoding its samples.
  // Returns false and clears `out` when the file is missing or its header is
  // invalid.
  bool readSummary(uint32_t id, ShotSummary& out);
  // Reads the compact summary from the EXTR header and user metadata from the
  // footer. It does not read the EXTR events or samples and does not check the
  // EXTR CRC; because of that, it doesn't distinguish between a legacy bare
  // record without a metadata footer and a damaged metadata footer: both are
  // reported as `out.metadata.avalable = false`. Returns false on a filesystem
  // read error; discard `out` in that case.
  bool readHistoryEntry(uint32_t id, ShotHistoryEntry& out);

  // Reads the complete EXTR record—header, events, samples, and target block.
  // Performs structural and CRC validation (if the record includes a CRC).
  // Metadata state does not affect the result and is not returned.
  ShotStoreReadResult readEncodedExtraction(uint32_t id,
                                            EncodedExtraction& out);

  // Copies the complete physical file without parsing it. The snapshot is
  // complete before the store mutex is released, so callers may perform slow
  // I/O without blocking other history operations. It supports files up to
  // twice kMaxStoredShotRecordBytes in order to enable data recovery of records
  // damaged or stored by unsupported firmware versions.
  ShotStoreReadResult readStoredFile(uint32_t id, storage::FileSnapshot& out);

  // Reads the metadata footer and JSON, if present (active state). For other
  // metadata states, the json field is empty. A record without a recognizable
  // footer is structurally scanned to distinguish a bare EXTR record from a
  // damaged tail, thus `out.available = true` is guaranteed.
  ShotStoreReadResult readUserMetadata(uint32_t id, ShotUserMetadata& out);

  // Validates and writes one JSON object when the stored metadata state and CRC
  // match `expected`. On success, `saved` contains the value read back from the
  // file. Reads check the metadata CRC but do not parse the JSON again.
  ShotUserMetadataWriteResult writeUserMetadata(
      uint32_t id, const uint8_t* json, size_t jsonLength,
      const ShotUserMetadata& expected, ShotUserMetadata& saved);

  // Writes one JSON object only when the stored metadata state is Absent.
  // The state check and write occur under the same store lock.
  ShotUserMetadataWriteResult initializeUserMetadata(uint32_t id,
                                                     const uint8_t* json,
                                                     size_t jsonLength,
                                                     ShotUserMetadata& saved);

  // Sets the stored state to Cleared and the JSON length to zero. Existing
  // payload capacity and its bytes are retained.
  ShotUserMetadataWriteResult clearUserMetadata(
      uint32_t id, const ShotUserMetadata& expected, ShotUserMetadata& saved);

  // Decodes and validates one stored EXTR record into `out`. Metadata state
  // does not affect the result. Discard `out` when this returns false.
  bool load(uint32_t id, Extraction& out);
  // Removes one record and advances the HTTP list revision.
  bool erase(uint32_t id);
  // Newest record with a valid compact header, or zero when history is empty.
  // Unlike page(), this filters record contents because its caller restores
  // the record for replay.
  uint32_t newestId();

  // Mutations advance the O(1) revision without requiring a directory scan.
  // List ETags combine it with bootNonce so a browser cannot confuse records
  // from different storage lifetimes.
  uint32_t revision();
  // Random for each boot and immutable after construction.
  uint32_t bootNonce() const { return _bootNonce; }

 private:
  enum class MetadataMatch : uint8_t { StateAndCrc, StateOnly };

  mutable SemaphoreHandle_t _mutex;
  uint32_t _bootNonce = 0;
  uint32_t _revision = 0;
  // Cache correctness assumes /shots changes only through ShotStore. Data-
  // erasure flows stop shot-history consumers before formatting and reboot.
  std::array<uint32_t, kMaxShots> _cachedShotIds{};
  size_t _cachedShotIdCount = 0;
  bool _shotIdCacheValid = false;

  // Helpers require _mutex.
  bool _scanIdsUnlocked(std::vector<uint32_t>& ids);
  bool _buildShotIdCacheUnlocked();
  void _invalidateShotIdCacheUnlocked();
  void _cacheAddedShotUnlocked(uint32_t id);
  void _cacheRemovedShotUnlocked(uint32_t id);
  bool _writeRecordUnlocked(const Extraction& ext, uint32_t id,
                            size_t encodedSize);
  void _enforceRetentionUnlocked(const std::vector<uint32_t>& ids);
  bool _readHistoryEntryUnlocked(uint32_t id, ShotSummary& summary,
                                 ShotUserMetadata* userMetadata = nullptr);
  ShotUserMetadataWriteResult _writeUserMetadataUnlocked(
      uint32_t id, const uint8_t* json, size_t jsonLength,
      ShotMetadataStoredState newState, const ShotUserMetadata& expected,
      MetadataMatch match, ShotUserMetadata& saved);
  static void _pathFor(uint32_t id, char* buf, size_t cap);
};

}  // namespace pump_scale
