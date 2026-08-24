// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <FS.h>

#include <map>
#include <set>
#include <string>
#include <vector>

class TestLittleFS : public fs::FS {
 public:
  TestLittleFS() : _control(std::make_shared<TestFileControl>()) {}

  bool begin(bool, const char*, unsigned, const char*) {
    ++beginCalls;
    mounted = beginSucceeds;
    return mounted;
  }

  void end() {
    ++endCalls;
    mounted = false;
  }

  bool format() {
    ++formatCalls;
    if (!formatSucceeds) return false;
    files.clear();
    directoryExists = false;
    if (formatMakesMountable) beginSucceeds = true;
    return true;
  }

  bool exists(const char* path) const {
    const std::string key(path);
    if (key == "/shots") return directoryExists;
    return files.find(key) != files.end();
  }

  bool mkdir(const char* path) {
    if (std::string(path) != "/shots" || failMkdir) return false;
    directoryExists = true;
    return true;
  }

  File open(const char* path, const char* mode = "r") {
    const std::string key(path);
    if (key == "/shots") {
      ++directoryOpenCalls;
      if (!directoryExists || failDirectoryOpen) return {};
      std::vector<std::pair<std::string, File::Data>> entries;
      for (const auto& entry : files) {
        if (entry.first.rfind("/shots/", 0) == 0) entries.push_back(entry);
      }
      if (reverseDirectoryOrder) std::reverse(entries.begin(), entries.end());
      return File(std::move(entries), _control);
    }

    if (mode && mode[0] == 'w') {
      if (!directoryExists) return {};
      auto data = std::make_shared<std::vector<uint8_t>>();
      files[key] = data;
      return File(key, std::move(data), _control);
    }

    if (failFileOpen) return {};

    const auto found = files.find(key);
    if (found == files.end()) return {};
    return File(found->first, found->second, _control);
  }

  bool remove(const char* path) {
    const std::string key(path);
    if (failedRemovals.count(key) != 0) return false;
    return files.erase(key) == 1;
  }

  void reset() {
    beginSucceeds = true;
    formatSucceeds = true;
    formatMakesMountable = true;
    mounted = false;
    beginCalls = 0;
    endCalls = 0;
    formatCalls = 0;
    files.clear();
    failedRemovals.clear();
    directoryExists = false;
    failDirectoryOpen = false;
    failFileOpen = false;
    failMkdir = false;
    reverseDirectoryOrder = false;
    _control->failWrites = false;
    directoryOpenCalls = 0;
  }

  void addFile(const std::string& path, const std::vector<uint8_t>& data) {
    directoryExists = true;
    files[path] = std::make_shared<std::vector<uint8_t>>(data);
  }

  bool hasFile(const std::string& path) const {
    return files.find(path) != files.end();
  }

  void setFailWrites(bool fail) { _control->failWrites = fail; }

  bool beginSucceeds = true;
  bool formatSucceeds = true;
  bool formatMakesMountable = true;
  bool mounted = false;
  unsigned beginCalls = 0;
  unsigned endCalls = 0;
  unsigned formatCalls = 0;
  bool directoryExists = false;
  bool failDirectoryOpen = false;
  bool failFileOpen = false;
  bool failMkdir = false;
  bool reverseDirectoryOrder = false;
  unsigned directoryOpenCalls = 0;
  std::set<std::string> failedRemovals;

 private:
  std::map<std::string, File::Data> files;
  std::shared_ptr<TestFileControl> _control;
};

extern TestLittleFS LittleFS;
