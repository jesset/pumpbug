// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "json_validate.h"

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

// Only containers increase depth, which bounds the recursive calls.
class SyntaxParser {
 public:
  SyntaxParser(const char* text, size_t length, size_t maxNesting)
      : pos_(text), end_(text + length), maxNesting_(maxNesting) {}

  ObjectValidationResult parseDocument() {
    skipWhitespace();
    const bool object = pos_ != end_ && *pos_ == '{';
    if (!parseValue(0)) return ObjectValidationResult::InvalidJson;
    skipWhitespace();
    if (pos_ != end_) return ObjectValidationResult::InvalidJson;
    return object ? ObjectValidationResult::Valid
                  : ObjectValidationResult::NotObject;
  }

 private:
  static bool isDigit(char c) { return c >= '0' && c <= '9'; }

  static bool isHexDigit(char c) {
    return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  }

  bool consume(char c) {
    if (pos_ == end_ || *pos_ != c) return false;
    ++pos_;
    return true;
  }

  void skipWhitespace() {
    while (pos_ != end_) {
      switch (*pos_) {
        case ' ':
        case '\t':
        case '\n':
        case '\r':
          ++pos_;
          break;
        default:
          return;
      }
    }
  }

  bool readString() {
    if (!consume('"')) return false;
    while (pos_ != end_) {
      const auto c = static_cast<unsigned char>(*pos_++);
      if (c == '"') return true;
      if (c < 0x20u) return false;
      if (c != '\\') continue;
      if (pos_ == end_) return false;
      switch (*pos_++) {
        case '"':
        case '\\':
        case '/':
        case 'b':
        case 'f':
        case 'n':
        case 'r':
        case 't':
          break;
        case 'u':
          for (unsigned i = 0; i < 4; ++i) {
            if (pos_ == end_ || !isHexDigit(*pos_)) return false;
            ++pos_;
          }
          break;
        default:
          return false;
      }
    }
    return false;
  }

  bool readDigits() {
    const char* begin = pos_;
    while (pos_ != end_ && isDigit(*pos_)) ++pos_;
    return pos_ != begin;
  }

  // Check the spelling of numbers without conversion, so validation is
  // independent of numeric precision, floating-point range, and locale.
  bool readNumber() {
    consume('-');
    if (consume('0')) {
      if (pos_ != end_ && isDigit(*pos_)) return false;
    } else if (!readDigits()) {
      return false;
    }
    if (consume('.') && !readDigits()) return false;
    if (consume('e') || consume('E')) {
      if (!consume('+')) consume('-');
      if (!readDigits()) return false;
    }
    return true;
  }

  bool readKeyword(const char* keyword) {
    while (*keyword) {
      if (!consume(*keyword++)) return false;
    }
    return true;
  }

  // depth counts enclosing containers. Check the limit before descending
  // into another one; scalar values do not consume a level.
  bool parseValue(size_t depth) {
    skipWhitespace();
    if (pos_ == end_) return false;
    switch (*pos_) {
      case '{':
        return depth < maxNesting_ && parseObject(depth + 1);
      case '[':
        return depth < maxNesting_ && parseArray(depth + 1);
      case '"':
        return readString();
      case 't':
        return readKeyword("true");
      case 'f':
        return readKeyword("false");
      case 'n':
        return readKeyword("null");
      default:
        return (*pos_ == '-' || isDigit(*pos_)) && readNumber();
    }
  }

  bool parseObject(size_t depth) {
    ++pos_;
    skipWhitespace();
    if (consume('}')) return true;
    do {
      skipWhitespace();
      if (!readString()) return false;
      skipWhitespace();
      if (!consume(':') || !parseValue(depth)) return false;
      skipWhitespace();
      if (consume('}')) return true;
    } while (consume(','));
    return false;
  }

  bool parseArray(size_t depth) {
    ++pos_;
    skipWhitespace();
    if (consume(']')) return true;
    do {
      if (!parseValue(depth)) return false;
      skipWhitespace();
      if (consume(']')) return true;
    } while (consume(','));
    return false;
  }

  const char* pos_;
  const char* const end_;
  const size_t maxNesting_;
};

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
  return SyntaxParser(text, length, maxNesting).parseDocument();
}

}  // namespace json
