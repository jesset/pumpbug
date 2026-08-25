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

bool readExactly(int descriptor, uint8_t* destination, size_t size) {
  if (!destination && size != 0) return false;
  size_t offset = 0;
  while (offset < size) {
    const ssize_t count =
        ::read(descriptor, destination + offset, size - offset);
    if (count > 0) {
      offset += static_cast<size_t>(count);
    } else if (count == 0) {
      return false;
    } else if (errno != EINTR) {
      return false;
    }
  }
  return true;
}

bool writeExactly(int descriptor, const uint8_t* source, size_t size) {
  if (!source && size != 0) return false;
  size_t offset = 0;
  while (offset < size) {
    const ssize_t count = ::write(descriptor, source + offset, size - offset);
    if (count > 0) {
      offset += static_cast<size_t>(count);
    } else if (count == 0) {
      return false;
    } else if (errno != EINTR) {
      return false;
    }
  }
  return true;
}

}  // namespace

FileReader::~FileReader() {
  if (_descriptor >= 0) ::close(_descriptor);
}

FileOpenResult FileReader::open(const char* volumePath) {
  if (_descriptor >= 0) {
    ::close(_descriptor);
    _descriptor = -1;
    _size = 0;
  }

  char path[64];
  if (!absolutePath(volumePath, path, sizeof(path))) {
    return FileOpenResult::Error;
  }

  errno = 0;
  const int descriptor = ::open(path, O_RDONLY);
  if (descriptor < 0) {
    return errno == ENOENT ? FileOpenResult::Missing : FileOpenResult::Error;
  }

  struct stat info;
  if (::fstat(descriptor, &info) != 0 || info.st_size < 0) {
    ::close(descriptor);
    return FileOpenResult::Error;
  }

  _descriptor = descriptor;
  _size = static_cast<size_t>(info.st_size);
  return FileOpenResult::Opened;
}

size_t FileReader::size() const { return _size; }

bool FileReader::readExactly(uint8_t* destination, size_t size) {
  return _descriptor >= 0 &&
         storage::readExactly(_descriptor, destination, size);
}

bool FileReader::seek(size_t offset) {
  if (_descriptor < 0 || offset > _size) return false;
  return ::lseek(_descriptor, static_cast<off_t>(offset), SEEK_SET) >= 0;
}

FileWriter::~FileWriter() {
  if (_descriptor >= 0) ::close(_descriptor);
}

bool FileWriter::open(const char* volumePath) {
  if (_descriptor >= 0 && !close()) return false;

  char path[64];
  if (!absolutePath(volumePath, path, sizeof(path))) return false;

  _descriptor = ::open(path, O_WRONLY | O_CREAT | O_TRUNC, 0666);
  return _descriptor >= 0;
}

bool FileWriter::writeExactly(const uint8_t* source, size_t size) {
  return _descriptor >= 0 && storage::writeExactly(_descriptor, source, size);
}

bool FileWriter::close() {
  if (_descriptor < 0) return true;
  const int descriptor = _descriptor;
  _descriptor = -1;
  return ::close(descriptor) == 0;
}

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

  const int descriptor = ::open(path, O_RDONLY);
  if (descriptor < 0) return false;
  const bool read = readExactly(descriptor, destination, size);
  ::close(descriptor);
  return read;
}

FileStatus fileStatus(const char* volumePath) {
  char path[64];
  if (!absolutePath(volumePath, path, sizeof(path))) return FileStatus::Error;

  struct stat info;
  if (::stat(path, &info) == 0) return FileStatus::Present;
  return errno == ENOENT ? FileStatus::Missing : FileStatus::Error;
}

}  // namespace storage
