// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "storage_file_access.h"

#include <M5Unified.h>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>

#include "storage.h"

namespace storage {
namespace {

bool absolutePath(const char* volumePath, char* destination, size_t capacity) {
  const int length =
      std::snprintf(destination, capacity, "%s%s", kMountPath, volumePath);
  return length >= 0 && static_cast<size_t>(length) < capacity;
}

}  // namespace

DirectoryReader::~DirectoryReader() {
  if (_handle) ::closedir(static_cast<DIR*>(_handle));
}

DirectoryOpenResult DirectoryReader::open(const char* volumePath) {
  if (_handle) {
    ::closedir(static_cast<DIR*>(_handle));
    _handle = nullptr;
  }

  char path[64];
  if (!absolutePath(volumePath, path, sizeof(path))) {
    M5_LOGE("storage: filesystem path is too long: %s", volumePath);
    return DirectoryOpenResult::Error;
  }

  errno = 0;
  _handle = ::opendir(path);
  if (!_handle) {
    if (errno == ENOENT) return DirectoryOpenResult::Missing;
    M5_LOGE("storage: cannot open %s: errno=%d", volumePath, errno);
    return DirectoryOpenResult::Error;
  }
  return DirectoryOpenResult::Opened;
}

DirectoryReadResult DirectoryReader::next(const char*& name) {
  if (!_handle) return DirectoryReadResult::Error;

  errno = 0;
  while (dirent* entry = ::readdir(static_cast<DIR*>(_handle))) {
    if (entry->d_type != DT_REG && entry->d_type != DT_UNKNOWN) {
      continue;
    }
    name = entry->d_name;
    return DirectoryReadResult::Entry;
  }
  if (errno != 0) {
    M5_LOGE("storage: directory read failed: errno=%d", errno);
    return DirectoryReadResult::Error;
  }
  return DirectoryReadResult::End;
}

bool readFilePrefix(const char* volumePath, uint8_t* destination, size_t size) {
  char path[64];
  if (!absolutePath(volumePath, path, sizeof(path))) return false;

  const int file = ::open(path, O_RDONLY);
  if (file < 0) return false;

  size_t offset = 0;
  while (offset < size) {
    const ssize_t count = ::read(file, destination + offset, size - offset);
    if (count > 0) {
      offset += static_cast<size_t>(count);
    } else if (count == 0) {
      break;
    } else if (errno != EINTR) {
      break;
    }
  }
  ::close(file);
  return offset == size;
}

FileStatus fileStatus(const char* volumePath) {
  char path[64];
  if (!absolutePath(volumePath, path, sizeof(path))) return FileStatus::Error;

  struct stat info;
  if (::stat(path, &info) == 0) return FileStatus::Present;
  return errno == ENOENT ? FileStatus::Missing : FileStatus::Error;
}

}  // namespace storage
