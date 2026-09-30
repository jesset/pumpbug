// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include <nvs.h>

#include <cassert>
#include <cstdio>

#include "apps/extraction/history/shot_id_reservation.h"

void testM5LogInfo(const char*, ...) {}
void testM5LogWarning(const char*, ...) {}
void testM5LogError(const char*, ...) {}

namespace {
constexpr char kNamespace[] = "shots";
constexpr char kLastIdKey[] = "last_id";

using pump_scale::shot_store_detail::kMaxShotId;
using pump_scale::shot_store_detail::loadShotStoreNonce;
using pump_scale::shot_store_detail::reserveNextShotId;

void expectStored(uint32_t expected) {
  assert(testNvs.value(kNamespace, kLastIdKey) == expected);
}
}  // namespace

int main() {
  testNvs.reset();
  assert(reserveNextShotId(0) == 1);
  expectStored(1);

  testNvs.reset();
  testNvs.ensureNamespace(kNamespace);
  assert(reserveNextShotId(3) == 4);
  expectStored(4);

  testNvs.setU32(kNamespace, kLastIdKey, 20);
  assert(reserveNextShotId(10) == 21);
  expectStored(21);

  testNvs.setU32(kNamespace, kLastIdKey, 5);
  assert(reserveNextShotId(20) == 21);
  expectStored(21);

  testNvs.setU32(kNamespace, kLastIdKey, 30);
  testNvs.nextOpenError = ESP_FAIL;
  assert(reserveNextShotId(40) == 0);
  expectStored(30);

  testNvs.nextReadError = ESP_FAIL;
  assert(reserveNextShotId(40) == 0);
  expectStored(30);

  testNvs.setU64(kNamespace, kLastIdKey, 30);
  assert(reserveNextShotId(40) == 0);
  expectStored(30);

  testNvs.setU32(kNamespace, kLastIdKey, 30);
  testNvs.nextWriteError = ESP_FAIL;
  assert(reserveNextShotId(40) == 0);
  expectStored(30);

  testNvs.nextCommitError = ESP_FAIL;
  assert(reserveNextShotId(40) == 0);
  expectStored(30);
  assert(reserveNextShotId(40) == 41);
  expectStored(41);

  testNvs.setU32(kNamespace, kLastIdKey, kMaxShotId - 1);
  assert(reserveNextShotId(0) == kMaxShotId);
  expectStored(kMaxShotId);
  assert(reserveNextShotId(0) == 0);
  expectStored(kMaxShotId);

  testNvs.reset();
  const uint32_t identity = loadShotStoreNonce();
  assert(identity != 0);
  assert(testNvs.value(kNamespace, "store_nonce") == identity);
  assert(reserveNextShotId(0) == 1);
  assert(loadShotStoreNonce() == identity);
  assert(reserveNextShotId(0) == 2);
  assert(loadShotStoreNonce() == identity);

  // A new store instance uses persisted identity, not fresh boot randomness.
  testNvs.setU32(kNamespace, "store_nonce", 0x87654321);
  assert(loadShotStoreNonce() == 0x87654321);
  testNvs.reset();
  assert(loadShotStoreNonce() != 0x87654321);

  for (auto error : {&testNvs.nextOpenError, &testNvs.nextReadError,
                     &testNvs.nextWriteError, &testNvs.nextCommitError}) {
    testNvs.reset();
    *error = ESP_FAIL;
    assert(loadShotStoreNonce() == 0);
    assert(loadShotStoreNonce() != 0);
  }
  testNvs.setU64(kNamespace, "store_nonce", 42);
  assert(loadShotStoreNonce() == 0);
  testNvs.setU32(kNamespace, "store_nonce", 0);
  testNvs.setU32(kNamespace, kLastIdKey, 57);
  const uint32_t repaired = loadShotStoreNonce();
  assert(repaired != 0);
  assert(testNvs.value(kNamespace, "store_nonce") == repaired);
  assert(loadShotStoreNonce() == repaired);
  expectStored(57);
  assert(reserveNextShotId(0) == 58);
  assert(loadShotStoreNonce() == repaired);

  for (auto error : {&testNvs.nextOpenError, &testNvs.nextReadError,
                     &testNvs.nextWriteError, &testNvs.nextCommitError}) {
    testNvs.reset();
    testNvs.setU32(kNamespace, "store_nonce", 0);
    *error = ESP_FAIL;
    assert(loadShotStoreNonce() == 0);
    assert(testNvs.value(kNamespace, "store_nonce") == 0);
    const uint32_t retry = loadShotStoreNonce();
    assert(retry != 0);
    assert(testNvs.value(kNamespace, "store_nonce") == retry);
  }

  std::puts("OK: shot ID reservation NVS contracts");
  return 0;
}
