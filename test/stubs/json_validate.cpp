// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "util/json_validate.h"

#include <cctype>

namespace json {

ObjectValidationResult validateObject(const char* text, size_t length,
                                      size_t maxLength, size_t) {
  if (!text) return ObjectValidationResult::InvalidJson;
  if (length > maxLength) return ObjectValidationResult::TooLarge;
  if (length >= 3 && static_cast<unsigned char>(text[0]) == 0xEFu &&
      static_cast<unsigned char>(text[1]) == 0xBBu &&
      static_cast<unsigned char>(text[2]) == 0xBFu) {
    return ObjectValidationResult::InvalidJson;
  }
  size_t begin = 0;
  while (begin < length &&
         std::isspace(static_cast<unsigned char>(text[begin]))) {
    ++begin;
  }
  size_t end = length;
  while (end > begin &&
         std::isspace(static_cast<unsigned char>(text[end - 1]))) {
    --end;
  }
  if (begin == end) return ObjectValidationResult::InvalidJson;
  if (text[begin] == '[') return ObjectValidationResult::NotObject;
  return text[begin] == '{' && text[end - 1] == '}'
             ? ObjectValidationResult::Valid
             : ObjectValidationResult::InvalidJson;
}

}  // namespace json
