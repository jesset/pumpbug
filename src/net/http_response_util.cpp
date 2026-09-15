// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "http_response_util.h"

#include <WebServer.h>

#include <string>

#include "net/JsonStream.h"

namespace http {

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
