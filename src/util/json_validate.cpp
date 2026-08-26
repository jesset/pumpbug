// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "json_validate.h"

#include <cJSON.h>

#include <cctype>

namespace json {
namespace {

bool isContinuation(uint8_t byte) { return (byte & 0xC0u) == 0x80u; }

bool hasUtf8Bom(const char* text, size_t length) {
  if (length < 3) return false;
  const auto* bytes = reinterpret_cast<const uint8_t*>(text);
  return bytes[0] == 0xEFu && bytes[1] == 0xBBu && bytes[2] == 0xBFu;
}

bool isValidUtf8(const char* text, size_t length) {
  const auto* bytes = reinterpret_cast<const uint8_t*>(text);
  size_t i = 0;
  while (i < length) {
    const uint8_t first = bytes[i++];
    if (first <= 0x7Fu) continue;
    if (first >= 0xC2u && first <= 0xDFu) {
      if (i >= length || !isContinuation(bytes[i])) return false;
      ++i;
      continue;
    }
    if (first >= 0xE0u && first <= 0xEFu) {
      if (i + 1 >= length || !isContinuation(bytes[i]) ||
          !isContinuation(bytes[i + 1])) {
        return false;
      }
      if ((first == 0xE0u && bytes[i] < 0xA0u) ||
          (first == 0xEDu && bytes[i] >= 0xA0u)) {
        return false;
      }
      i += 2;
      continue;
    }
    if (first >= 0xF0u && first <= 0xF4u) {
      if (i + 2 >= length || !isContinuation(bytes[i]) ||
          !isContinuation(bytes[i + 1]) || !isContinuation(bytes[i + 2])) {
        return false;
      }
      if ((first == 0xF0u && bytes[i] < 0x90u) ||
          (first == 0xF4u && bytes[i] >= 0x90u)) {
        return false;
      }
      i += 3;
      continue;
    }
    return false;
  }
  return true;
}

bool hasAcceptableNesting(const char* text, size_t length, size_t maxNesting) {
  size_t depth = 0;
  bool inString = false;
  bool escaped = false;
  for (size_t i = 0; i < length; ++i) {
    const char c = text[i];
    if (inString) {
      if (static_cast<unsigned char>(c) < 0x20u) return false;
      if (escaped) {
        escaped = false;
      } else if (c == '\\') {
        escaped = true;
      } else if (c == '"') {
        inString = false;
      }
      continue;
    }
    if (static_cast<unsigned char>(c) < 0x20u && c != '\t' && c != '\n' &&
        c != '\r') {
      return false;
    }
    if (c == '"') {
      inString = true;
    } else if (c == '{' || c == '[') {
      if (++depth > maxNesting) return false;
    } else if ((c == '}' || c == ']') && depth != 0) {
      --depth;
    }
  }
  return true;
}

}  // namespace

ObjectValidationResult validateObject(const char* text, size_t length,
                                      size_t maxLength, size_t maxNesting) {
  if (!text) return ObjectValidationResult::InvalidJson;
  if (length > maxLength) return ObjectValidationResult::TooLarge;
  // Metadata is embedded within larger JSON responses, where a BOM would not
  // be at the start of the document.
  if (hasUtf8Bom(text, length)) return ObjectValidationResult::InvalidJson;
  if (!isValidUtf8(text, length)) {
    return ObjectValidationResult::InvalidUtf8;
  }
  if (!hasAcceptableNesting(text, length, maxNesting)) {
    return ObjectValidationResult::InvalidJson;
  }

  const char* parseEnd = nullptr;
  cJSON* root = cJSON_ParseWithLengthOpts(text, length, &parseEnd, false);
  if (!root) return ObjectValidationResult::InvalidJson;
  while (parseEnd < text + length &&
         std::isspace(static_cast<unsigned char>(*parseEnd))) {
    ++parseEnd;
  }
  const bool consumed = parseEnd == text + length;
  const bool object = cJSON_IsObject(root);
  cJSON_Delete(root);
  if (!consumed) return ObjectValidationResult::InvalidJson;
  return object ? ObjectValidationResult::Valid
                : ObjectValidationResult::NotObject;
}

}  // namespace json
