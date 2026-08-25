// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "util/storage_file_access.h"

#include <LittleFS.h>

#include <map>
#include <utility>

struct TestDirectoryHandle {
  explicit TestDirectoryHandle(File directory)
      : directory(std::move(directory)) {}

  File directory;
  File current;
};

namespace {
int nextFileDescriptor = 0;
std::map<int, File> openFiles;
}  // namespace

namespace storage {

FileReader::~FileReader() { openFiles.erase(_descriptor); }

FileOpenResult FileReader::open(const char* volumePath) {
  openFiles.erase(_descriptor);
  _descriptor = -1;
  _size = 0;
  if (!LittleFS.exists(volumePath)) return FileOpenResult::Missing;

  File file = LittleFS.open(volumePath, "r");
  if (!file || file.isDirectory()) return FileOpenResult::Error;
  _descriptor = nextFileDescriptor++;
  _size = file.size();
  openFiles.emplace(_descriptor, std::move(file));
  return FileOpenResult::Opened;
}

size_t FileReader::size() const { return _size; }

bool FileReader::readExactly(uint8_t* destination, size_t size) {
  const auto found = openFiles.find(_descriptor);
  return found != openFiles.end() &&
         found->second.readBytes(reinterpret_cast<char*>(destination), size) ==
             size;
}

bool FileReader::seek(size_t offset) {
  const auto found = openFiles.find(_descriptor);
  return found != openFiles.end() && found->second.seek(offset);
}

FileWriter::~FileWriter() { openFiles.erase(_descriptor); }

bool FileWriter::open(const char* volumePath) {
  openFiles.erase(_descriptor);
  _descriptor = -1;

  File file = LittleFS.open(volumePath, "w");
  if (!file || file.isDirectory()) return false;
  _descriptor = nextFileDescriptor++;
  openFiles.emplace(_descriptor, std::move(file));
  return true;
}

bool FileWriter::writeExactly(const uint8_t* source, size_t size) {
  const auto found = openFiles.find(_descriptor);
  return found != openFiles.end() && found->second.write(source, size) == size;
}

bool FileWriter::close() {
  const auto found = openFiles.find(_descriptor);
  if (found != openFiles.end() && LittleFS.corruptNextWrittenFileOnClose) {
    LittleFS.corruptNextWrittenFileOnClose = false;
    LittleFS.xorFileByte(found->second.name(), 8, 1);
  }
  openFiles.erase(_descriptor);
  _descriptor = -1;
  return true;
}

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
  FileReader file;
  return file.open(volumePath) == FileOpenResult::Opened &&
         file.readExactly(destination, size);
}

FileStatus fileStatus(const char* volumePath) {
  return LittleFS.hasFile(volumePath) ? FileStatus::Present
                                      : FileStatus::Missing;
}

}  // namespace storage
