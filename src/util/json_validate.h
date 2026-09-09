// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdint>

namespace json {

enum class ObjectValidationResult : uint8_t {
  Valid,
  TooLarge,
  InvalidUtf8,
  InvalidJson,
  NotObject,
};

// Validates one UTF-8 JSON document without heap allocation. When all checks
// pass, returns `Valid` for an object root or `NotObject` for any other root.
//
// The input is limited to `maxLength` bytes and `maxNesting` levels of objects
// and arrays, counting the outermost container as level 1. The nesting limit
// bounds recursive stack use; exceeding it returns `InvalidJson`.
//
// Null input and a leading UTF-8 byte order mark are rejected as `InvalidJson`.
// Escaped UTF-16 surrogates need not be paired.
ObjectValidationResult validateObject(const char* text, size_t length,
                                      size_t maxLength, size_t maxNesting);

}  // namespace json
