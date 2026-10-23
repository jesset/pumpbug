// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdint>

// Minimal allocation-free JSON scanning shared by the La Marzocco parsers.
//
// Not a general JSON library: it walks one object's members (or the elements
// of one top-level array) and hands the caller each member's key and the raw
// span of its value token. Unknown values — including nested objects and
// arrays — can be skipped. Strings are unescaped into caller buffers with a
// hard cap. The firmware's cJSON stays out of this so the same code runs in
// host tests.
namespace lm::json {

enum class Kind : uint8_t { String, Number, Bool, Null, Object, Array };

struct Member {
  const char* key;
  size_t keyLen;
  // Raw value span (inside the original document) and its detected kind.
  const char* value;
  size_t valueLen;
  Kind kind;
};

// A cursor over one JSON object or array. `doc` must stay valid while the
// cursor is used. Invalid documents make iteration stop early (next()
// returns false); callers treat truncation as a parse failure.
class Cursor {
 public:
  // `object` selects member iteration of {...}; otherwise elements of [...]
  // are iterated with an empty key.
  Cursor(const char* doc, size_t len, bool object);

  // Advance to the next member/element. False when exhausted or on malformed
  // input.
  bool next();

  const Member& member() const { return _m; }
  bool failed() const { return _failed; }

 private:
  void skipWs();
  bool skipValue();       // advance past one complete value
  bool readStringSpan(const char*& s, size_t& n);

  const char* _p;
  const char* _end;
  const char* _containerEnd = nullptr;  // NUL-terminated docs: '}' or ']'
  bool _object;
  bool _first = true;
  bool _failed = false;
  Member _m;
};

// Unescape a JSON string span (without quotes) into `out` (cap `outCap`,
// NUL-terminated). Returns false when the content does not fit.
bool unescapeInto(const char* s, size_t n, char* out, size_t outCap);

// Parse a number span as double. Returns false on malformed input.
bool parseNumber(const char* s, size_t n, double& out);

// Parse "true"/"false" spans. Returns false otherwise.
bool parseBool(const char* s, size_t n, bool& out);

}  // namespace lm::json
