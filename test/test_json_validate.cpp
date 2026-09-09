// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include <cassert>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <string_view>

#include "util/json_validate.h"

namespace {

using Result = json::ObjectValidationResult;

void expect(std::string_view text, Result expected, size_t maxNesting = 16) {
  const auto result =
      json::validateObject(text.data(), text.size(), text.size(), maxNesting);
  if (result != expected) {
    std::fprintf(stderr,
                 "Unexpected validation result %u (expected %u): %.*s\n",
                 static_cast<unsigned>(result), static_cast<unsigned>(expected),
                 static_cast<int>(text.size()), text.data());
  }
  assert(result == expected);
}

void testObjectsAndValues() {
  for (const std::string_view text : {
           R"({})",
           " \t\r\n { \"a\" : [true, false, null, {}, []] } \n",
           R"({"s":"\"\\\/\b\f\n\r\t\u0000\uD834\uDD1E"})",
           R"({"s":"\uD800","t":"\uDC00"})",
           R"({"":"","same":1,"same":2})",
           R"({"coffee":"café ☕","notes":"[[{{}}]]"})",
       }) {
    expect(text, Result::Valid);
  }

  for (const std::string_view text : {"null", "true", "false", "\"text\"", "[]",
                                      "[{},1]", "0", "-12", "1e2"}) {
    expect(text, Result::NotObject);
  }
  expect("null", Result::NotObject, 0);
  expect("{}", Result::InvalidJson, 0);
  expect("[]", Result::InvalidJson, 0);
}

void testNumbers() {
  for (const std::string_view number : {
           "0",
           "-0",
           "1",
           "-123",
           "0.1",
           "-0.1",
           "1.0",
           "1e2",
           "1E+2",
           "-1e-2",
           "1.25E-2",
           "0e0",
           "0e+01",
           "1e9999",
           "1e-9999",
           "1234567890123456789012345678901234567890",
       }) {
    expect(number, Result::NotObject);
    expect("{\"n\":" + std::string(number) + "}", Result::Valid);
  }
  for (const std::string_view number :
       {"01",  "-01",  "00",  "1.",       "1.e2",      ".1",   "-.1",
        "-",   "+1",   "1e",  "1e+",      "1e-",       "1ee2", "1e+-2",
        "--1", "0x10", "NaN", "Infinity", "-Infinity", "1 2"}) {
    expect(number, Result::InvalidJson);
    expect("{\"n\":" + std::string(number) + "}", Result::InvalidJson);
  }
}

void testMalformedSyntax() {
  for (const std::string_view text : {
           "",
           " ",
           R"({"rating":1,})",
           R"({"tags":["a",]})",
           "{,}",
           "[,]",
           R"({"a":1,,"b":2})",
           "[1,,2]",
           R"({a:1})",
           "{'a':1}",
           R"({"a" 1})",
           R"({"a":})",
           R"({"a":truefalse})",
           R"({"a":1 "b":2})",
           R"({"a":tru})",
           R"({"a":nul})",
           R"({"a":undefined})",
           R"({"a":"\x00"})",
           R"({"a":"\q"})",
           R"({"a":"\u123"})",
           R"({"a":"\u123x"})",
           R"({"a":"unterminated})",
           R"({"a":[1,2}})",
           R"({"a":1])",
           "{}{}",
           "{}x",
           "{}//comment",
           "{/*comment*/}",
           "[1 2]",
       }) {
    expect(text, Result::InvalidJson);
  }

  // Every proper prefix is incomplete, including a cut inside an escape or
  // immediately after a number, keyword, or closing nested container.
  const std::string complete =
      R"({"a":[true,false,null,-1.25e+2,{"s":"\u1234"}]})";
  for (size_t length = 0; length < complete.size(); ++length) {
    expect(std::string_view(complete.data(), length), Result::InvalidJson);
  }
  expect(complete, Result::Valid);
}

void testControlCharactersAndEndOfInput() {
  for (unsigned c = 0; c < 32; ++c) {
    const std::string control(1, static_cast<char>(c));
    expect("{\"s\":\"" + control + "\"}", Result::InvalidJson);
    const auto whitespaceResult = c == '\t' || c == '\r' || c == '\n'
                                      ? Result::Valid
                                      : Result::InvalidJson;
    expect("{" + control + "}", whitespaceResult);
    expect("{}" + control, whitespaceResult);
  }
  expect(std::string("{}\0garbage", 10), Result::InvalidJson);
  expect(std::string("\0{}", 3), Result::InvalidJson);
  expect(std::string("\xEF\xBB\xBF") + "{}", Result::InvalidJson);
  expect("{\"s\":\"\xEF\xBB\xBF\"}", Result::Valid);

  const char bounded[] = {'{', '}', 'x'};
  assert(json::validateObject(bounded, 2, 2, 1) == Result::Valid);
  assert(json::validateObject(nullptr, 0, 0, 0) == Result::InvalidJson);

  // Exact allocations leave no terminating NUL beyond the declared span.
  // When run under sanitizers, these buffers expose reads past that span.
  const struct {
    std::string_view text;
    Result expected;
  } cases[] = {
      {R"({"a":"x"})", Result::Valid},
      {R"({"a":"x")", Result::InvalidJson},
      {R"({"a":"x\)", Result::InvalidJson},
      {"0", Result::NotObject},
      {"1e", Result::InvalidJson},
      {"false", Result::NotObject},
      {"[", Result::InvalidJson},
  };
  for (const auto& item : cases) {
    auto bytes = std::make_unique<char[]>(item.text.size());
    std::memcpy(bytes.get(), item.text.data(), item.text.size());
    assert(json::validateObject(bytes.get(), item.text.size(), item.text.size(),
                                16) == item.expected);
  }
}

void testUtf8() {
  for (const std::string_view bytes :
       {"\xC2\x80", "\xDF\xBF", "\xE0\xA0\x80", "\xED\x9F\xBF", "\xEE\x80\x80",
        "\xEF\xBF\xBF", "\xF0\x90\x80\x80", "\xF4\x8F\xBF\xBF"}) {
    expect("{\"s\":\"" + std::string(bytes) + "\"}", Result::Valid);
  }
  for (const std::string_view bytes :
       {"\x80", "\xC0\x80", "\xC1\xBF", "\xC2", "\xC2\x20", "\xE0\x9F\xBF",
        "\xED\xA0\x80", "\xE1\x80", "\xF0\x8F\xBF\xBF", "\xF4\x90\x80\x80",
        "\xF5\x80\x80\x80", "\xF0\x90\x80", "\xFF"}) {
    expect("{\"s\":\"" + std::string(bytes) + "\"}", Result::InvalidUtf8);
  }
}

std::string nestedObject(size_t depth, unsigned shape) {
  std::string text = "0";
  for (size_t level = depth; level > 0; --level) {
    const bool object =
        level == 1 || shape == 0 || (shape == 2 && level % 2 == 1);
    text = object ? "{\"v\":" + text + "}" : "[" + text + "]";
  }
  return text;
}

void testLimitsAndInputPreservation() {
  for (unsigned shape = 0; shape < 3; ++shape) {
    for (size_t limit : {size_t(1), size_t(2), size_t(16)}) {
      expect(nestedObject(limit, shape), Result::Valid, limit);
      expect(nestedObject(limit + 1, shape), Result::InvalidJson, limit);
    }
    expect(nestedObject(512, shape), Result::InvalidJson);
  }
  expect(R"({"a":[],"b":{},"c":[1,2,3]})", Result::Valid, 2);
  expect(R"({"s":"[[{{}}]]"})", Result::Valid, 1);

  const std::string prefix = R"({"notes":")";
  const std::string suffix = R"("})";
  const std::string atLimit =
      prefix + std::string(1536 - prefix.size() - suffix.size(), 'x') + suffix;
  assert(json::validateObject(atLimit.data(), atLimit.size(), atLimit.size(),
                              16) == Result::Valid);
  assert(json::validateObject(atLimit.data(), atLimit.size(),
                              atLimit.size() - 1, 16) == Result::TooLarge);

  std::string original =
      R"( { "future": [123456789012345678901234567890, 1.2300e+004, "\u0061"] } )";
  const std::string before = original;
  expect(original, Result::Valid);
  assert(original == before);
}

}  // namespace

int main() {
  testObjectsAndValues();
  testNumbers();
  testMalformedSyntax();
  testControlCharactersAndEndOfInput();
  testUtf8();
  testLimitsAndInputPreservation();
  std::puts("OK: strict JSON object validation");
}
