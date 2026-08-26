// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "util/storage_file_access.h"

#include <LittleFS.h>
#include <esp_heap_caps.h>

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

void FileSnapshot::BufferDeleter::operator()(uint8_t* data) const {
  heap_caps_free(data);
}

bool FileSnapshot::read(FileReader& file, size_t maximumSize) {
  _data.reset();
  _size = 0;

  const size_t fileSize = file.size();
  if (fileSize > maximumSize) return false;
  if (fileSize == 0) return true;
  if (!file.seek(0)) return false;

  std::unique_ptr<uint8_t[], BufferDeleter> data(
      static_cast<uint8_t*>(heap_caps_malloc(fileSize, MALLOC_CAP_8BIT)));
  if (!data || !file.readExactly(data.get(), fileSize)) return false;

  _data = std::move(data);
  _size = fileSize;
  return true;
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

bool FileWriter::openForUpdate(const char* volumePath) {
  openFiles.erase(_descriptor);
  _descriptor = -1;

  File file = LittleFS.open(volumePath, "r+");
  if (!file || file.isDirectory()) return false;
  _descriptor = nextFileDescriptor++;
  openFiles.emplace(_descriptor, std::move(file));
  return true;
}

bool FileWriter::seek(size_t offset) {
  const auto found = openFiles.find(_descriptor);
  return found != openFiles.end() && found->second.seek(offset);
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

FileStatus fileStatus(const char* volumePath) {
  return LittleFS.hasFile(volumePath) ? FileStatus::Present
                                      : FileStatus::Missing;
}

}  // namespace storage
