// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "LmJson.h"

#include <cstdlib>
#include <cstring>

namespace lm::json {

namespace {

bool isWs(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

}  // namespace

Cursor::Cursor(const char* doc, size_t len, bool object)
    : _p(doc), _end(doc + len), _object(object) {
  skipWs();
  const char open = _object ? '{' : '[';
  const char close = _object ? '}' : ']';
  if (_p >= _end || *_p != open) {
    _failed = true;
    return;
  }
  ++_p;
  skipWs();
  if (_p < _end && *_p == close) {
    _containerEnd = _p;  // empty container; next() returns false
  }
}

void Cursor::skipWs() {
  while (_p < _end && isWs(*_p)) ++_p;
}

bool Cursor::readStringSpan(const char*& s, size_t& n) {
  if (_p >= _end || *_p != '"') return false;
  s = _p + 1;
  const char* q = s;
  while (q < _end) {
    if (*q == '\\') {
      q += 2;
      continue;
    }
    if (*q == '"') {
      n = static_cast<size_t>(q - s);
      _p = q + 1;
      return true;
    }
    ++q;
  }
  return false;
}

bool Cursor::skipValue() {
  skipWs();
  if (_p >= _end) return false;
  const char c = *_p;
  if (c == '"') {
    const char* s;
    size_t n;
    return readStringSpan(s, n);
  }
  if (c == '{' || c == '[') {
    const char close = c == '{' ? '}' : ']';
    int depth = 0;
    while (_p < _end) {
      const char d = *_p;
      if (d == '"') {  // skip strings so their braces/brackets do not count
        const char* s;
        size_t n;
        if (!readStringSpan(s, n)) return false;
        continue;
      }
      if (d == '{' || d == '[') ++depth;
      else if (d == '}' || d == ']') {
        --depth;
        if (depth == 0) {
          if (d != close) return false;
          ++_p;
          return true;
        }
      }
      ++_p;
    }
    return false;
  }
  // Number, bool, null: run to the next delimiter.
  while (_p < _end) {
    const char d = *_p;
    if (d == ',' || d == '}' || d == ']' || isWs(d)) break;
    ++_p;
  }
  return _p > _end - 1 ? false : true;
}

bool Cursor::next() {
  if (_failed || _containerEnd != nullptr) return false;
  skipWs();
  if (_p >= _end) {
    _failed = true;
    return false;
  }
  if (*_p == (_object ? '}' : ']')) {
    _containerEnd = _p;
    ++_p;
    return false;
  }
  if (!_first) {
    if (*_p != ',') {
      _failed = true;
      return false;
    }
    ++_p;
    skipWs();
    if (_p >= _end) {
      _failed = true;
      return false;
    }
  }
  _first = false;

  _m.key = "";
  _m.keyLen = 0;
  if (_object) {
    const char* k;
    size_t kn;
    if (!readStringSpan(k, kn)) {
      _failed = true;
      return false;
    }
    _m.key = k;
    _m.keyLen = kn;
    skipWs();
    if (_p >= _end || *_p != ':') {
      _failed = true;
      return false;
    }
    ++_p;
    skipWs();
  }

  const char* vStart = _p;
  if (!skipValue()) {
    _failed = true;
    return false;
  }
  _m.value = vStart;
  _m.valueLen = static_cast<size_t>(_p - vStart);
  switch (*vStart) {
    case '"':
      _m.kind = Kind::String;
      // Point at the unquoted content; consumers unescape this span.
      _m.value = vStart + 1;
      _m.valueLen -= 2;
      break;
    case '{': _m.kind = Kind::Object; break;
    case '[': _m.kind = Kind::Array; break;
    case 't':
    case 'f': _m.kind = Kind::Bool; break;
    case 'n': _m.kind = Kind::Null; break;
    default: _m.kind = Kind::Number; break;
  }
  return true;
}

bool unescapeInto(const char* s, size_t n, char* out, size_t outCap) {
  if (outCap == 0) return false;
  size_t o = 0;
  for (size_t i = 0; i < n; i++) {
    char c = s[i];
    if (c == '\\') {
      if (++i >= n) return false;
      switch (s[i]) {
        case '"': c = '"'; break;
        case '\\': c = '\\'; break;
        case '/': c = '/'; break;
        case 'b': c = '\b'; break;
        case 'f': c = '\f'; break;
        case 'n': c = '\n'; break;
        case 'r': c = '\r'; break;
        case 't': c = '\t'; break;
        case 'u': {
          // \uXXXX beyond the BMP round-trips as UTF-16 pairs; these
          // documents never contain them for the fields we read. Encode the
          // code point only when it fits the ASCII range we accept.
          if (i + 4 >= n) return false;
          unsigned cp = 0;
          for (int k = 1; k <= 4; k++) {
            const char h = s[i + k];
            cp <<= 4;
            if (h >= '0' && h <= '9') cp |= static_cast<unsigned>(h - '0');
            else if (h >= 'a' && h <= 'f') cp |= static_cast<unsigned>(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') cp |= static_cast<unsigned>(h - 'A' + 10);
            else return false;
          }
          if (cp > 0x7f) return false;  // non-ASCII fields are rejected
          c = static_cast<char>(cp);
          i += 4;
          break;
        }
        default: return false;
      }
    } else if (static_cast<unsigned char>(c) > 0x7f) {
      // UTF-8 passes through untouched (valid sequences stay valid).
    }
    if (o + 1 >= outCap) return false;
    out[o++] = c;
  }
  out[o] = '\0';
  return true;
}

bool parseNumber(const char* s, size_t n, double& out) {
  if (n == 0 || n >= 40) return false;
  char buf[40];
  memcpy(buf, s, n);
  buf[n] = '\0';
  char* endp = nullptr;
  out = std::strtod(buf, &endp);
  return endp == buf + n;
}

bool parseBool(const char* s, size_t n, bool& out) {
  if (n == 4 && memcmp(s, "true", 4) == 0) {
    out = true;
    return true;
  }
  if (n == 5 && memcmp(s, "false", 5) == 0) {
    out = false;
    return true;
  }
  return false;
}

}  // namespace lm::json
