// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "LmCrypto.h"

#include <cstring>

namespace lm {

namespace {

struct Sha256Ctx {
  uint32_t h[8];
  uint64_t totalLen = 0;
  uint8_t block[64];
  size_t blockLen = 0;
};

constexpr uint32_t kK[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

uint32_t rotr(uint32_t v, uint32_t n) {
  return (v >> n) | (v << (32 - n));
}

void sha256Compress(Sha256Ctx& c, const uint8_t* p) {
  uint32_t w[64];
  for (size_t i = 0; i < 16; i++) {
    w[i] = (static_cast<uint32_t>(p[i * 4]) << 24) |
           (static_cast<uint32_t>(p[i * 4 + 1]) << 16) |
           (static_cast<uint32_t>(p[i * 4 + 2]) << 8) |
           static_cast<uint32_t>(p[i * 4 + 3]);
  }
  for (size_t i = 16; i < 64; i++) {
    const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^
                        (w[i - 15] >> 3);
    const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^
                        (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = c.h[0], b = c.h[1], cc = c.h[2], d = c.h[3];
  uint32_t e = c.h[4], f = c.h[5], g = c.h[6], h = c.h[7];
  for (size_t i = 0; i < 64; i++) {
    const uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const uint32_t ch = (e & f) ^ (~e & g);
    const uint32_t t1 = h + S1 + ch + kK[i] + w[i];
    const uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
    const uint32_t t2 = S0 + maj;
    h = g; g = f; f = e; e = d + t1;
    d = cc; cc = b; b = a; a = t1 + t2;
  }
  c.h[0] += a; c.h[1] += b; c.h[2] += cc; c.h[3] += d;
  c.h[4] += e; c.h[5] += f; c.h[6] += g; c.h[7] += h;
}

void sha256Init(Sha256Ctx& c) {
  c.h[0] = 0x6a09e667; c.h[1] = 0xbb67ae85; c.h[2] = 0x3c6ef372;
  c.h[3] = 0xa54ff53a; c.h[4] = 0x510e527f; c.h[5] = 0x9b05688c;
  c.h[6] = 0x1f83d9ab; c.h[7] = 0x5be0cd19;
  c.totalLen = 0; c.blockLen = 0;
}

void sha256Update(Sha256Ctx& c, const uint8_t* data, size_t len) {
  c.totalLen += len;
  while (len > 0) {
    const size_t take = 64 - c.blockLen < len ? 64 - c.blockLen : len;
    memcpy(c.block + c.blockLen, data, take);
    c.blockLen += take;
    data += take;
    len -= take;
    if (c.blockLen == 64) {
      sha256Compress(c, c.block);
      c.blockLen = 0;
    }
  }
}

}  // namespace

void sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
  Sha256Ctx c;
  sha256Init(c);
  sha256Update(c, data, len);
  const uint64_t msgBits = c.totalLen * 8;  // padding not fed yet

  // Padding: 0x80, zeros up to 56 mod 64, then the big-endian bit length.
  uint8_t pad[72];
  size_t padLen = (64 - ((len + 1 + 8) % 64)) % 64 + 1 + 8;
  memset(pad, 0, sizeof(pad));
  pad[0] = 0x80;
  for (int i = 0; i < 8; i++) {
    pad[padLen - 1 - i] = static_cast<uint8_t>(msgBits >> (8 * i));
  }
  sha256Update(c, pad, padLen);

  for (size_t i = 0; i < 8; i++) {
    uint32_t v = c.h[i];
    out[i * 4] = static_cast<uint8_t>(v >> 24);
    out[i * 4 + 1] = static_cast<uint8_t>(v >> 16);
    out[i * 4 + 2] = static_cast<uint8_t>(v >> 8);
    out[i * 4 + 3] = static_cast<uint8_t>(v);
  }
}

size_t base64Encode(const uint8_t* data, size_t len, char* out, size_t outCap) {
  static const char kTable[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const size_t need = ((len + 2) / 3) * 4 + 1;
  if (out == nullptr || outCap < need) return 0;
  size_t o = 0;
  size_t i = 0;
  for (; i + 2 < len; i += 3) {
    const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                       (static_cast<uint32_t>(data[i + 1]) << 8) |
                       static_cast<uint32_t>(data[i + 2]);
    out[o++] = kTable[(v >> 18) & 63];
    out[o++] = kTable[(v >> 12) & 63];
    out[o++] = kTable[(v >> 6) & 63];
    out[o++] = kTable[v & 63];
  }
  if (i + 1 == len) {
    const uint32_t v = static_cast<uint32_t>(data[i]) << 16;
    out[o++] = kTable[(v >> 18) & 63];
    out[o++] = kTable[(v >> 12) & 63];
    out[o++] = '=';
    out[o++] = '=';
  } else if (i + 2 == len) {
    const uint32_t v = (static_cast<uint32_t>(data[i]) << 16) |
                       (static_cast<uint32_t>(data[i + 1]) << 8);
    out[o++] = kTable[(v >> 18) & 63];
    out[o++] = kTable[(v >> 12) & 63];
    out[o++] = kTable[(v >> 6) & 63];
    out[o++] = '=';
  }
  out[o] = '\0';
  return o;
}

bool generateRequestProof(const char* baseString, const uint8_t secret32[32],
                          char* out, size_t outCap) {
  if (baseString == nullptr || secret32 == nullptr || out == nullptr ||
      outCap < 45) {
    return false;
  }
  uint8_t work[32];
  memcpy(work, secret32, 32);
  for (const char* p = baseString; *p != '\0'; p++) {
    const uint8_t b = static_cast<uint8_t>(*p);
    const size_t idx = b % 32;
    const size_t shiftIdx = (idx + 1) % 32;
    const uint8_t shiftAmount = work[shiftIdx] & 7;
    const uint8_t xorResult = static_cast<uint8_t>(b ^ work[idx]);
    // rotate-left by shiftAmount within 8 bits; >> (8 - shift) is safe for
    // shift in [0,7] on the int-promoted value.
    const uint8_t rotated = static_cast<uint8_t>(
        (xorResult << shiftAmount) | (xorResult >> (8 - shiftAmount)));
    work[idx] = rotated;
  }
  uint8_t digest[32];
  sha256(work, 32, digest);
  return base64Encode(digest, 32, out, outCap) == 44;
}

}  // namespace lm
