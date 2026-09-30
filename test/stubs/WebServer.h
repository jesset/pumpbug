// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <string>

class String : public std::string {
 public:
  using std::string::string;
  String(const std::string& value) : std::string(value) {}

  int indexOf(char value) const {
    const auto position = find(value);
    return position == npos ? -1 : static_cast<int>(position);
  }
  void remove(size_t index) { erase(index); }
  void trim() {
    const auto first = find_first_not_of(" \t\r\n");
    if (first == npos)
      clear();
    else
      *this = substr(first, find_last_not_of(" \t\r\n") - first + 1);
  }
  bool equalsIgnoreCase(const char* value) const {
    const std::string other(value);
    return size() == other.size() &&
           std::equal(begin(), end(), other.begin(),
                      [](unsigned char a, unsigned char b) {
                        return std::tolower(a) == std::tolower(b);
                      });
  }
  bool isEmpty() const { return empty(); }
};

inline constexpr size_t CONTENT_LENGTH_UNKNOWN =
    std::numeric_limits<size_t>::max();

class WiFiClient {
 public:
  explicit WiFiClient(std::string& body) : _body(body) {}
  size_t write(const uint8_t* data, size_t size) {
    _body.append(reinterpret_cast<const char*>(data), size);
    return size;
  }
  void stop() {}

 private:
  std::string& _body;
};

// Captures HTTP inputs and output without a network connection. Routes and
// JSON/body validation use their production implementations.
class WebServer {
 public:
  std::map<std::string, std::string> arguments;
  std::map<std::string, std::string> requestHeaders;
  std::map<std::string, std::string> responseHeaders;
  int status = 0;
  size_t contentLength = 0;
  std::string contentType;
  std::string body;

  bool hasArg(const char* name) const { return arguments.count(name) != 0; }
  String arg(const char* name) const {
    const auto found = arguments.find(name);
    return found == arguments.end() ? String{} : String(found->second);
  }
  bool hasHeader(const char* name) const {
    return requestHeaders.count(name) != 0;
  }
  String header(const char* name) const {
    const auto found = requestHeaders.find(name);
    return found == requestHeaders.end() ? String{} : String(found->second);
  }
  int clientContentLength() const {
    return static_cast<int>(arg("plain").size());
  }
  void sendHeader(const char* name, const char* value) {
    responseHeaders[name] = value;
  }
  void setContentLength(size_t length) { contentLength = length; }
  void send(int code, const char* type, const char* content) {
    status = code;
    contentType = type;
    body = content;
  }
  void sendContent(const char* data) { body += data; }
  void sendContent(const char* data, size_t size) { body.append(data, size); }
  WiFiClient client() { return WiFiClient(body); }
};
