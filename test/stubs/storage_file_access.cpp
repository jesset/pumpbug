// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "util/storage_file_access.h"

#include <LittleFS.h>

#include <utility>

struct TestDirectoryHandle {
  explicit TestDirectoryHandle(File directory)
      : directory(std::move(directory)) {}

  File directory;
  File current;
};

namespace storage {

DirectoryReader::~DirectoryReader() {
  delete static_cast<TestDirectoryHandle*>(_handle);
}

DirectoryOpenResult DirectoryReader::open(const char* volumePath) {
  delete static_cast<TestDirectoryHandle*>(_handle);
  _handle = nullptr;
  if (!LittleFS.exists(volumePath)) return DirectoryOpenResult::Missing;

  File directory = LittleFS.open(volumePath);
  if (!directory || !directory.isDirectory()) return DirectoryOpenResult::Error;
  _handle = new TestDirectoryHandle(std::move(directory));
  return DirectoryOpenResult::Opened;
}

DirectoryReadResult DirectoryReader::next(const char*& name) {
  auto* handle = static_cast<TestDirectoryHandle*>(_handle);
  if (!handle) return DirectoryReadResult::Error;
  do {
    handle->current = handle->directory.openNextFile();
  } while (handle->current && handle->current.isDirectory());
  if (!handle->current) return DirectoryReadResult::End;
  name = handle->current.name();
  return DirectoryReadResult::Entry;
}

bool readFilePrefix(const char* volumePath, uint8_t* destination, size_t size) {
  File file = LittleFS.open(volumePath, "r");
  if (!file) return false;
  return file.readBytes(reinterpret_cast<char*>(destination), size) == size;
}

FileStatus fileStatus(const char* volumePath) {
  return LittleFS.hasFile(volumePath) ? FileStatus::Present
                                      : FileStatus::Missing;
}

}  // namespace storage
