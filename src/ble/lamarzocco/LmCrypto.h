// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdint>

// Shared primitives for talking to the La Marzocco cloud and machine:
// SHA-256, base64, and the "Y5.e" request-proof algorithm.
//
// The proof algorithm is a byte-exact port of pylamarzocco's
// generate_request_proof() (see docs/lamarzocco.md for the protocol source);
// host tests pin it against reference vectors produced with the original
// Python implementation, so the two must keep producing identical output.
namespace lm {

// FIPS 180-4 SHA-256. Pure; no mbedtls so the same code runs in host tests.
void sha256(const uint8_t* data, size_t len, uint8_t out[32]);

// Standard base64 (RFC 4648, padding). Writes a NUL terminator. Returns the
// number of characters written excluding the NUL, or 0 when outCap is too
// small. 32 input bytes need 44 chars + NUL.
size_t base64Encode(const uint8_t* data, size_t len, char* out, size_t outCap);

// The cloud's custom request proof ("Y5.e"): folds the base string into the
// 32-byte secret byte by byte (XOR + rotate-left by a secret-derived amount),
// then returns base64(SHA-256(result)). `outCap` must be >= 45. Returns false
// on invalid arguments.
bool generateRequestProof(const char* baseString, const uint8_t secret32[32],
                          char* out, size_t outCap);

}  // namespace lm
