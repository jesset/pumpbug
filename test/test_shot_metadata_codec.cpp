// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include <array>
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "apps/extraction/history/shot_metadata_codec.h"
#include "util/crc32.h"

namespace {

using pump_scale::Crc32;
using pump_scale::decodeShotMetadataFooter;
using pump_scale::encodeShotMetadataFooter;
using pump_scale::kMaxShotMetadataJsonBytes;
using pump_scale::kShotMetadataFooterBytes;
using pump_scale::ShotMetadataFooter;
using pump_scale::ShotMetadataFooterReadResult;
using pump_scale::ShotMetadataStoredState;
using pump_scale::validateShotMetadataEnvelope;

constexpr uint32_t kRawLength = 1234;
constexpr size_t kEnvelopeOverhead =
    pump_scale::kShotExtractionCrcBytes + kShotMetadataFooterBytes;

std::array<uint8_t, kShotMetadataFooterBytes> encode(
    ShotMetadataStoredState state, const uint8_t* json, size_t jsonLength,
    size_t capacity) {
  std::array<uint8_t, kShotMetadataFooterBytes> footer{};
  assert(encodeShotMetadataFooter(state, kRawLength, json, jsonLength, capacity,
                                  footer.data()));
  return footer;
}

ShotMetadataFooter decode(
    const std::array<uint8_t, kShotMetadataFooterBytes>& encoded,
    size_t capacity) {
  ShotMetadataFooter footer{};
  assert(decodeShotMetadataFooter(
             encoded.data(), kRawLength + kEnvelopeOverhead + capacity,
             footer) == ShotMetadataFooterReadResult::Supported);
  return footer;
}

void testStandardCrcAndIncrementalUpdates() {
  constexpr uint8_t input[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
  Crc32 complete;
  complete.update(input, sizeof(input));
  assert(complete.value() == 0xCBF43926u);

  Crc32 incremental;
  incremental.update(input, 4);
  incremental.update(input + 4, sizeof(input) - 4);
  assert(incremental.value() == complete.value());

  Crc32 empty;
  empty.update(nullptr, 0);
}

void testAbsentFooterLayoutAndValidation() {
  const auto encoded = encode(ShotMetadataStoredState::Absent, nullptr, 0, 0);
  assert(std::memcmp(encoded.data(), "PBMD", 4) == 0);
  assert(encoded[4] == 1);
  assert(encoded[5] == 0);
  assert(encoded[6] == 0xD2);
  assert(encoded[7] == 0x04);
  assert(encoded[8] == 0);
  assert(encoded[9] == 0);
  assert(encoded[10] == 0);
  assert(encoded[11] == 0);

  const ShotMetadataFooter footer = decode(encoded, 0);
  assert(footer.state == ShotMetadataStoredState::Absent);
  assert(footer.rawLength == kRawLength);
  assert(footer.jsonLength == 0);
  assert(footer.payloadCapacity == 0);
  assert(validateShotMetadataEnvelope(footer, nullptr, 0, encoded.data()));
}

void testActiveAndClearedStates() {
  constexpr std::array<uint8_t, 7> json = {'{', '"', 'x', '"', ':', '1', '}'};
  const auto active =
      encode(ShotMetadataStoredState::Active, json.data(), json.size(), 32);
  const ShotMetadataFooter activeFooter = decode(active, 32);
  assert(activeFooter.state == ShotMetadataStoredState::Active);
  assert(activeFooter.jsonLength == json.size());
  assert(activeFooter.payloadCapacity == 32);
  assert(validateShotMetadataEnvelope(activeFooter, json.data(), json.size(),
                                      active.data()));

  auto damagedJson = json;
  damagedJson[2] ^= 1;
  assert(!validateShotMetadataEnvelope(activeFooter, damagedJson.data(),
                                       damagedJson.size(), active.data()));

  const auto cleared = encode(ShotMetadataStoredState::Cleared, nullptr, 0, 32);
  const ShotMetadataFooter clearedFooter = decode(cleared, 32);
  assert(clearedFooter.state == ShotMetadataStoredState::Cleared);
  assert(clearedFooter.jsonLength == 0);
  assert(clearedFooter.payloadCapacity == 32);
  assert(
      validateShotMetadataEnvelope(clearedFooter, nullptr, 0, cleared.data()));
}

void testLengthAndStateRules() {
  std::array<uint8_t, kShotMetadataFooterBytes> encoded{};
  const uint8_t value = 'x';
  assert(!encodeShotMetadataFooter(ShotMetadataStoredState::Absent, kRawLength,
                                   nullptr, 0, 1, encoded.data()));
  assert(!encodeShotMetadataFooter(ShotMetadataStoredState::Active, kRawLength,
                                   nullptr, 0, 0, encoded.data()));
  assert(!encodeShotMetadataFooter(ShotMetadataStoredState::Active, kRawLength,
                                   &value, 1, 0, encoded.data()));
  assert(!encodeShotMetadataFooter(ShotMetadataStoredState::Cleared, kRawLength,
                                   &value, 1, 1, encoded.data()));
  assert(!encodeShotMetadataFooter(ShotMetadataStoredState::Absent, kRawLength,
                                   &value, 1, 1, encoded.data()));
  assert(!encodeShotMetadataFooter(ShotMetadataStoredState::Cleared, kRawLength,
                                   nullptr, 0, kMaxShotMetadataJsonBytes + 1,
                                   encoded.data()));

  std::vector<uint8_t> maximum(kMaxShotMetadataJsonBytes, 'x');
  assert(encodeShotMetadataFooter(ShotMetadataStoredState::Active, kRawLength,
                                  maximum.data(), maximum.size(),
                                  maximum.size(), encoded.data()));
  maximum.push_back('x');
  assert(!encodeShotMetadataFooter(ShotMetadataStoredState::Active, kRawLength,
                                   maximum.data(), maximum.size(),
                                   maximum.size(), encoded.data()));
}

void testFooterClassificationAndCorruption() {
  constexpr uint8_t json[] = {'{', '}'};
  auto encoded = encode(ShotMetadataStoredState::Active, json, sizeof(json), 2);
  ShotMetadataFooter footer{};

  auto noMagic = encoded;
  noMagic[0] = 'X';
  assert(decodeShotMetadataFooter(noMagic.data(),
                                  kRawLength + kEnvelopeOverhead + 2, footer) ==
         ShotMetadataFooterReadResult::NoFooter);

  auto unsupported = encoded;
  unsupported[4] = 2;
  assert(decodeShotMetadataFooter(unsupported.data(),
                                  kRawLength + kEnvelopeOverhead + 2, footer) ==
         ShotMetadataFooterReadResult::Unsupported);

  auto unknownState = encoded;
  unknownState[5] = 3;
  assert(decodeShotMetadataFooter(unknownState.data(),
                                  kRawLength + kEnvelopeOverhead + 2, footer) ==
         ShotMetadataFooterReadResult::Corrupt);

  assert(decodeShotMetadataFooter(encoded.data(), kRawLength + 19, footer) ==
         ShotMetadataFooterReadResult::Corrupt);

  auto damagedFooter = encoded;
  damagedFooter[12] ^= 1;
  const ShotMetadataFooter damaged = decode(damagedFooter, 2);
  assert(!validateShotMetadataEnvelope(damaged, json, sizeof(json),
                                       damagedFooter.data()));
}

}  // namespace

int main() {
  testStandardCrcAndIncrementalUpdates();
  testAbsentFooterLayoutAndValidation();
  testActiveAndClearedStates();
  testLengthAndStateRules();
  testFooterClassificationAndCorruption();
  std::puts("OK: shot metadata envelope format");
  return 0;
}
