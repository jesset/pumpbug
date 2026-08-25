// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include "apps/extraction/Extraction.h"
#include "apps/extraction/ExtractionWire.h"
#include "apps/extraction/history/shot_metadata_codec.h"

namespace pump_scale {

// Metadata read from a shot file's compact header. It supplies the history list
// without decoding the sample and event streams.
struct ShotMeta {
  uint32_t id;
  uint32_t startUtcSec;
  uint32_t beginMs;
  uint32_t durationMs;
  uint32_t totalPumpOnMs;
  int16_t yieldCg;
};

struct ShotBinary {
  std::unique_ptr<uint8_t[]> data;
  size_t size = 0;
};

enum class ShotBinaryReadResult : uint8_t {
  Ok,
  Missing,
  Invalid,
  Error,
};

inline constexpr size_t kMaxStoredShotRecordBytes =
    kMaxCompactRecordBytes + kShotExtractionCrcBytes +
    kMaxShotMetadataJsonBytes + kShotMetadataFooterBytes;
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

  // Writes and verifies `ext`, then enforces FIFO retention. Returns false
  // without removing existing history when the new record cannot be saved.
  bool save(const Extraction& ext);

  // Produces a newest-first page from files named /shots/NNNNNNNN.bin with id
  // < `before`; before == 0 starts at the newest file. At most the newest
  // kMaxShots files are visible, and `total` reports that bounded count.
  // Records are not checked for integrity, just for existence. Returns false if
  // the directory cannot be read.
  bool page(uint32_t before, size_t limit, std::vector<uint32_t>& ids,
            bool* hasMore, size_t* total, uint32_t* outRevision);

  // Reads one record's compact-header metadata without decoding its samples.
  // Returns false and clears `out` when the file is missing or its header is
  // invalid.
  bool readMeta(uint32_t id, ShotMeta& out);

  // Reads the complete EXTR record—header, events, samples, and target block.
  // Performs structural and CRC validation (if the record includes a CRC).
  // Metadata state does not affect the result and is not returned.
  ShotBinaryReadResult readBinary(uint32_t id, ShotBinary& out);

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
  bool _readMetaUnlocked(uint32_t id, ShotMeta& out);
  static void _pathFor(uint32_t id, char* buf, size_t cap);
};

}  // namespace pump_scale
