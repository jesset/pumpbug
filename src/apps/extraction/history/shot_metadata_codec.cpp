// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "shot_metadata_codec.h"

#include <cstring>

#include "apps/extraction/extraction_encoding.h"
#include "util/crc32.h"

namespace pump_scale {
namespace {

constexpr uint8_t kMagic[] = {'P', 'B', 'M', 'D'};
constexpr uint8_t kVersion = 1;
constexpr size_t kStateOffset = 5;
constexpr size_t kRawLengthOffset = 6;
constexpr size_t kJsonLengthOffset = 10;
constexpr size_t kMetadataCrcOffset = 12;

bool isKnownState(uint8_t state) {
  return state <= static_cast<uint8_t>(ShotMetadataStoredState::Cleared);
}

bool lengthsAreValid(ShotMetadataStoredState state, size_t jsonLength,
                     size_t payloadCapacity) {
  if (payloadCapacity > kMaxShotMetadataJsonBytes ||
      jsonLength > payloadCapacity) {
    return false;
  }
  switch (state) {
    case ShotMetadataStoredState::Absent:
      return jsonLength == 0 && payloadCapacity == 0;
    case ShotMetadataStoredState::Active:
      return jsonLength != 0;
    case ShotMetadataStoredState::Cleared:
      return jsonLength == 0;
  }
  return false;
}

uint32_t metadataCrc(const uint8_t* activeJson, size_t jsonLength,
                     const uint8_t encoded[kShotMetadataFooterBytes]) {
  Crc32 crc;
  crc.update(activeJson, jsonLength);
  crc.update(encoded, kMetadataCrcOffset);
  return crc.value();
}

}  // namespace

bool encodeShotMetadataFooter(ShotMetadataStoredState state, uint32_t rawLength,
                              const uint8_t* activeJson, size_t jsonLength,
                              size_t payloadCapacity,
                              uint8_t out[kShotMetadataFooterBytes]) {
  if (!out || jsonLength > UINT16_MAX || (jsonLength != 0 && !activeJson) ||
      !lengthsAreValid(state, jsonLength, payloadCapacity)) {
    return false;
  }

  std::memcpy(out, kMagic, sizeof(kMagic));
  out[4] = kVersion;
  out[kStateOffset] = static_cast<uint8_t>(state);
  writeU32LE(out + kRawLengthOffset, rawLength);
  writeU16LE(out + kJsonLengthOffset, static_cast<uint16_t>(jsonLength));
  writeU32LE(out + kMetadataCrcOffset,
             metadataCrc(activeJson, jsonLength, out));
  return true;
}

ShotMetadataFooterReadResult decodeShotMetadataFooter(
    const uint8_t encoded[kShotMetadataFooterBytes], size_t fileSize,
    ShotMetadataFooter& out) {
  out = ShotMetadataFooter{};
  if (!encoded || std::memcmp(encoded, kMagic, sizeof(kMagic)) != 0) {
    return ShotMetadataFooterReadResult::NoFooter;
  }
  if (encoded[4] != kVersion) {
    return ShotMetadataFooterReadResult::Unsupported;
  }
  if (!isKnownState(encoded[kStateOffset])) {
    return ShotMetadataFooterReadResult::Corrupt;
  }

  out.state = static_cast<ShotMetadataStoredState>(encoded[kStateOffset]);
  out.rawLength = readU32LE(encoded + kRawLengthOffset);
  out.jsonLength = readU16LE(encoded + kJsonLengthOffset);
  out.metadataCrc = readU32LE(encoded + kMetadataCrcOffset);

  constexpr size_t kEnvelopeOverhead =
      kShotExtractionCrcBytes + kShotMetadataFooterBytes;
  if (out.rawLength > fileSize ||
      fileSize - out.rawLength < kEnvelopeOverhead) {
    return ShotMetadataFooterReadResult::Corrupt;
  }
  out.payloadCapacity = fileSize - out.rawLength - kEnvelopeOverhead;
  if (!lengthsAreValid(out.state, out.jsonLength, out.payloadCapacity)) {
    return ShotMetadataFooterReadResult::Corrupt;
  }
  return ShotMetadataFooterReadResult::Supported;
}

bool validateShotMetadataEnvelope(
    const ShotMetadataFooter& footer, const uint8_t* activeJson,
    size_t jsonLength, const uint8_t encoded[kShotMetadataFooterBytes]) {
  if (!encoded || jsonLength != footer.jsonLength ||
      (jsonLength != 0 && !activeJson) ||
      !lengthsAreValid(footer.state, jsonLength, footer.payloadCapacity)) {
    return false;
  }
  return metadataCrc(activeJson, jsonLength, encoded) == footer.metadataCrc;
}

}  // namespace pump_scale
