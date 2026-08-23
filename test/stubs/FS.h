// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>

struct TestFileControl {
  bool failWrites = false;
};

class File {
 public:
  File() = default;

  explicit operator bool() const { return _valid; }
  bool isDirectory() const { return _directory; }
  const char* name() const { return _name.c_str(); }
  size_t size() const { return _data ? _data->size() : 0; }

  size_t readBytes(char* destination, size_t length) {
    if (!_valid || _directory || !_data) return 0;
    const size_t available = _data->size() - std::min(_position, _data->size());
    const size_t count = std::min(length, available);
    if (count != 0) {
      std::memcpy(destination, _data->data() + _position, count);
      _position += count;
    }
    return count;
  }

  size_t write(const uint8_t* source, size_t length) {
    if (!_valid || _directory || !_data || (_control && _control->failWrites)) {
      return 0;
    }
    _data->insert(_data->end(), source, source + length);
    _position += length;
    return length;
  }

  File openNextFile() {
    if (!_valid || !_directory || _directoryPosition >= _entries.size()) {
      return {};
    }
    const auto& entry = _entries[_directoryPosition++];
    return File(entry.first, entry.second, _control);
  }

  void close() {}

 private:
  using Data = std::shared_ptr<std::vector<uint8_t>>;

  File(std::string name, Data data, std::shared_ptr<TestFileControl> control)
      : _valid(true),
        _name(std::move(name)),
        _data(std::move(data)),
        _control(std::move(control)) {}

  File(std::vector<std::pair<std::string, Data>> entries,
       std::shared_ptr<TestFileControl> control)
      : _valid(true),
        _directory(true),
        _entries(std::move(entries)),
        _control(std::move(control)) {}

  bool _valid = false;
  bool _directory = false;
  std::string _name;
  Data _data;
  size_t _position = 0;
  std::vector<std::pair<std::string, Data>> _entries;
  size_t _directoryPosition = 0;
  std::shared_ptr<TestFileControl> _control;

  friend class TestLittleFS;
};

namespace fs {
class FS {};
}  // namespace fs
