// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdint>

namespace storage {

enum class DirectoryOpenResult : uint8_t { Opened, Missing, Error };
enum class DirectoryReadResult : uint8_t { Entry, End, Error };
enum class FileStatus : uint8_t { Present, Missing, Error };

// Iterates directory entry names. Entries known not to be regular files are
// skipped; entries with an unknown type are returned for caller filtering.
class DirectoryReader {
 public:
  DirectoryReader() = default;
  ~DirectoryReader();

  DirectoryReader(const DirectoryReader&) = delete;
  DirectoryReader& operator=(const DirectoryReader&) = delete;

  // `volumePath` starts at the mounted volume's root, for example `/shots`.
  DirectoryOpenResult open(const char* volumePath);
  // On Entry, `name` remains valid until the next call to next() or open(), or
  // until this reader is destroyed.
  DirectoryReadResult next(const char*& name);

 private:
  void* _handle = nullptr;
};

// Reads exactly `size` bytes from the beginning of a mounted LittleFS file.
// `volumePath` starts at the mounted volume's root.
bool readFilePrefix(const char* volumePath, uint8_t* destination, size_t size);

// Reports whether a mounted LittleFS path exists.
FileStatus fileStatus(const char* volumePath);

}  // namespace storage
