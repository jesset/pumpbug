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

// Validates one UTF-8 JSON document. The document must be an object, use at
// most `maxLength` bytes, and have an object-or-array nesting depth no greater
// than `maxNesting`.
ObjectValidationResult validateObject(const char* text, size_t length,
                                      size_t maxLength, size_t maxNesting);

}  // namespace json
