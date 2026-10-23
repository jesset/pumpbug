// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

// Host test for lm::sha256 / lm::base64Encode / lm::generateRequestProof.
//
// The proof vectors were generated with pylamarzocco's Python implementation
// (generate_request_proof) so the C++ port is pinned byte-for-byte to the
// reference. The secret hex is reproduced above each case.
//
//   g++ -std=c++17 -Wall -Wextra test/test_lm_crypto.cpp src/ble/lamarzocco/LmCrypto.cpp -Isrc/ble -o /tmp/test_lm_crypto

#include <cstdio>
#include <cstring>

#include "ble/lamarzocco/LmCrypto.h"

namespace {

int g_failures = 0;

#define CHECK(cond)                                               \
  do {                                                            \
    if (!(cond)) {                                                \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                               \
    }                                                             \
  } while (0)

void hexToBytes(const char* hex, uint8_t* out, size_t cap) {
  size_t n = strlen(hex) / 2;
  if (n > cap) n = cap;
  for (size_t i = 0; i < n; i++) {
    unsigned v = 0;
    std::sscanf(hex + i * 2, "%2x", &v);
    out[i] = static_cast<uint8_t>(v);
  }
}

// SHA-256 of "abc" (FIPS 180-4 test vector) and of the empty string.
void testSha256() {
  const uint8_t abc[] = {'a', 'b', 'c'};
  uint8_t d[32];
  lm::sha256(abc, 3, d);
  const char* want =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  char got[65];
  for (int i = 0; i < 32; i++) std::sprintf(got + i * 2, "%02x", d[i]);
  CHECK(std::strcmp(got, want) == 0);

  lm::sha256(nullptr, 0, d);
  const char* wantEmpty =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  for (int i = 0; i < 32; i++) std::sprintf(got + i * 2, "%02x", d[i]);
  CHECK(std::strcmp(got, wantEmpty) == 0);

  // 56-byte input crosses the padding boundary at 55/56.
  uint8_t buf[56];
  for (size_t i = 0; i < sizeof(buf); i++) buf[i] = static_cast<uint8_t>(i);
  lm::sha256(buf, sizeof(buf), d);
  // Computed independently (python hashlib).
  const char* want56 =
      "da2ae4d6b36748f2a318f23e7ab1dfdf45acdc9d049bd80e59de82a60895f562";
  for (int i = 0; i < 32; i++) std::sprintf(got + i * 2, "%02x", d[i]);
  CHECK(std::strcmp(got, want56) == 0);
}

void testBase64() {
  char out[64];
  const uint8_t a[] = {0, 0, 0};
  CHECK(lm::base64Encode(a, 3, out, sizeof(out)) == 4);
  CHECK(std::strcmp(out, "AAAA") == 0);
  const uint8_t b[] = {'f', 'o', 'o'};
  CHECK(lm::base64Encode(b, 3, out, sizeof(out)) == 4);
  CHECK(std::strcmp(out, "Zm9v") == 0);
  const uint8_t c2[] = {'f'};
  CHECK(lm::base64Encode(c2, 1, out, sizeof(out)) == 4);
  CHECK(std::strcmp(out, "Zg==") == 0);
  const uint8_t d2[] = {'f', 'o'};
  CHECK(lm::base64Encode(d2, 2, out, sizeof(out)) == 4);
  CHECK(std::strcmp(out, "Zm8=") == 0);
  // Truncated buffer refused.
  CHECK(lm::base64Encode(b, 3, out, 4) == 0);
}

struct ProofCase {
  const char* baseString;
  const char* secretHex;
  const char* expected;
};

void testRequestProof() {
  const ProofCase cases[] = {
      {"9f0d3dc5-3af9-4fbb-b151-5f09a72fdf7e."
       "c49b05f1-a7c4-4046-ac42-c5f461b57b35.1700000000000",
       "390c8c7d7247342cd8100f2f6f770d65d670e58e0351d8ae8e4f6eac342fc231",
       "raAHB1NaBRz84a19aMBan1lYbBTjBG98nq2hFKBmJoY="},
      {"9f0d3dc5-3af9-4fbb-b151-5f09a72fdf7e."
       "MacKaHk9qgWpytoCr/fVx34dX7j7QLPM5sHdB9mq+V4=",
       "390c8c7d7247342cd8100f2f6f770d65d670e58e0351d8ae8e4f6eac342fc231",
       "OvcKDnY+4X2oH7Dr6Fn1Sob8yuC3kPCwIqj8KYZ1yg0="},
      {"ece8cad6-8650-4f99-8b75-328044189c20."
       "b9fc2c2d-3996-4734-aa12-9535959cb422.1700000001237",
       "fa0939b99d7a1d7b282bf8234041f35487d86c669fccbfe0e73d7e7320ad0a75",
       "26laexzsnfoDq1HW03yCkaVcIDi/aQFmnndpDgNFbuo="},
      {"ece8cad6-8650-4f99-8b75-328044189c20."
       "u226v1ukHhJ8ozCgObkoPY3/Z7veGNy8rNVpDXxOs/s=",
       "fa0939b99d7a1d7b282bf8234041f35487d86c669fccbfe0e73d7e7320ad0a75",
       "UkXmShfCjFif/ks5HHbmHm/fEuhWp0vlLpb2es6m2D0="},
      {"2d8eb9c7-4eb5-4757-aacc-e4970b5cd471."
       "d1eee8b6-a120-4805-bb83-859d152999d0.1700000002474",
       "a07a87ca4399eaa12504ea33256d8743b2237dbd9150e09a04993544873b364f",
       "qCjbw57HcYZje5YoS2jYIyaPNPTjQxPto65VZxR34vU="},
      {"2d8eb9c7-4eb5-4757-aacc-e4970b5cd471."
       "g4f2w1trKmcjm0/47Hx24OedzQU68lgEnWhx8B3olpo=",
       "a07a87ca4399eaa12504ea33256d8743b2237dbd9150e09a04993544873b364f",
       "PBTcS7b9gP0M3MEyLcH0HDTobADh1hC5KlM9CsWyDVM="},
  };
  for (const auto& tc : cases) {
    uint8_t secret[32];
    hexToBytes(tc.secretHex, secret, sizeof(secret));
    char out[45];
    CHECK(lm::generateRequestProof(tc.baseString, secret, out, sizeof(out)));
    if (std::strcmp(out, tc.expected) != 0) {
      std::printf("FAIL proof mismatch\n  base: %s\n  got:  %s\n  want: %s\n",
                  tc.baseString, out, tc.expected);
      ++g_failures;
    }
  }
  // Bad capacity is rejected.
  uint8_t secret[32] = {};
  char small[8];
  CHECK(!lm::generateRequestProof("x", secret, small, sizeof(small)));
}

}  // namespace

int main() {
  testSha256();
  testBase64();
  testRequestProof();
  if (g_failures == 0) std::printf("test_lm_crypto OK\n");
  return g_failures == 0 ? 0 : 1;
}
