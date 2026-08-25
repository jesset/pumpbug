// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdint>

namespace storage {

// File and directory access within the LittleFS volume mounted by storage.h.

enum class DirectoryOpenResult : uint8_t { Opened, Missing, Error };
enum class DirectoryReadResult : uint8_t { Entry, End, Error };
enum class FileOpenResult : uint8_t { Opened, Missing, Error };
enum class FileStatus : uint8_t { Present, Missing, Error };

class FileReader {
 public:
  FileReader() = default;
  ~FileReader();

  FileReader(const FileReader&) = delete;
  FileReader& operator=(const FileReader&) = delete;

  FileOpenResult open(const char* volumePath);
  size_t size() const;
  bool readExactly(uint8_t* destination, size_t size);
  bool seek(size_t offset);

 private:
  int _descriptor = -1;
  size_t _size = 0;
};

class FileWriter {
 public:
  FileWriter() = default;
  ~FileWriter();

  FileWriter(const FileWriter&) = delete;
  FileWriter& operator=(const FileWriter&) = delete;

  // Opens the file for writing, replacing any existing contents.
  bool open(const char* volumePath);
  bool writeExactly(const uint8_t* source, size_t size);
  // Reports close errors. Destruction also closes an open file but cannot
  // report whether that close succeeded.
  bool close();

 private:
  int _descriptor = -1;
};

// Iterates directory entry names. Entries known not to be regular files are
// skipped; entries with an unknown type are returned for caller filtering.
class DirectoryReader {
 public:
  DirectoryReader() = default;
  ~DirectoryReader();

  DirectoryReader(const DirectoryReader&) = delete;
  DirectoryReader& operator=(const DirectoryReader&) = delete;

  DirectoryOpenResult open(const char* volumePath);
  // On Entry, `name` remains valid until the next call to next() or open(), or
  // until this reader is destroyed.
  DirectoryReadResult next(const char*& name);

 private:
  void* _handle = nullptr;
};

bool readFilePrefix(const char* volumePath, uint8_t* destination, size_t size);

FileStatus fileStatus(const char* volumePath);

}  // namespace storage
