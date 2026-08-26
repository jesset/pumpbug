// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdint>

namespace pump_scale {

// The user-metadata envelope follows the EXTR extraction record (see
// ShotStore.h):
//
//   [EXTR record + CRC] | user metadata JSON | inactive capacity | PBMD footer
//
// Footer layout (little-endian integers):
//
//   bytes  0..3   magic "PBMD"
//   byte      4   envelope version
//   byte      5   stored metadata state
//   bytes  6..9   EXTR length
//   bytes 10..11  current JSON length
//   bytes 12..15  metadata CRC32
//
// The footer is always at the end of the record. The active JSON begins after
// the EXTR CRC and occupies `jsonLength` bytes. Any remaining bytes before the
// footer are retained capacity and are not read or checksummed. Capacity is
// retained when a shorter JSON replaces the existing; this avoids resizing the
// file after shorter metadata edits.
inline constexpr size_t kShotExtractionCrcBytes = sizeof(uint32_t);
inline constexpr size_t kShotMetadataFooterBytes = 16;
inline constexpr size_t kMaxShotMetadataJsonBytes = 1536;
inline constexpr size_t kMaxShotMetadataJsonNesting = 16;

enum class ShotMetadataStoredState : uint8_t {
  Absent = 0,
  Active = 1,
  Cleared = 2,
};

enum class ShotMetadataFooterReadResult : uint8_t {
  MagicMismatch,
  Supported,
  UnsupportedVersion,
  Corrupt,
};

struct ShotMetadataFooter {
  ShotMetadataStoredState state = ShotMetadataStoredState::Absent;
  uint32_t rawLength = 0;
  uint16_t jsonLength = 0;
  uint32_t metadataCrc = 0;
  // Derived from the physical file size; not encoded in the footer.
  size_t payloadCapacity = 0;
};

// Encodes the footer and metadata CRC. The CRC covers the current JSON and
// footer bytes 0 through 11.
bool encodeShotMetadataFooter(ShotMetadataStoredState state, uint32_t rawLength,
                              const uint8_t* activeJson, size_t jsonLength,
                              size_t payloadCapacity,
                              uint8_t out[kShotMetadataFooterBytes]);

// Decodes footer fields and checks their relationship to the physical file
// size. MagicMismatch means the supplied bytes do not start with PBMD.
ShotMetadataFooterReadResult decodeShotMetadataFooter(
    const uint8_t encoded[kShotMetadataFooterBytes], size_t fileSize,
    ShotMetadataFooter& out);

// Checks the CRC over the active JSON followed by footer except the CRC field.
// The caller supplies exactly `footer.jsonLength` bytes.
bool validateShotMetadataEnvelope(
    const ShotMetadataFooter& footer, const uint8_t* activeJson,
    size_t jsonLength, const uint8_t encoded[kShotMetadataFooterBytes]);

}  // namespace pump_scale
