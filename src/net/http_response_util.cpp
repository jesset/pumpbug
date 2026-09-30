// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "http_response_util.h"

#include <WebServer.h>

#include <string>

#include "net/JsonStream.h"

namespace http {

bool etagOr304(WebServer& s, const char* etag) {
  if (s.hasHeader("If-None-Match") && s.header("If-None-Match") == etag) {
    s.sendHeader("ETag", etag);
    s.send(304, "application/json", "");
    return true;
  }
  return false;
}

void sendJsonError(WebServer& server, int status, const char* message,
                   const char* reason) {
  std::string body = "{\"error\":\"";
  json::escapeAppend(body, message);
  body += "\"";
  if (reason) {
    body += ",\"reason\":\"";
    json::escapeAppend(body, reason);
    body += "\"";
  }
  body += "}";
  server.send(status, "application/json", body.c_str());
}

}  // namespace http
