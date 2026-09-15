// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "http_request_validation.h"

#include <WebServer.h>

#include "http_response_util.h"

namespace http {

bool requireJsonRequestBody(WebServer& server, size_t maxBytes, String& body) {
  String contentType = server.header("Content-Type");
  const int parameter = contentType.indexOf(';');
  if (parameter >= 0) contentType.remove(parameter);
  contentType.trim();
  if (!contentType.equalsIgnoreCase("application/json")) {
    http::sendJsonError(server, 415, "Content-Type must be application/json");
    return false;
  }

  const int contentLength = server.clientContentLength();
  if (contentLength <= 0) {
    http::sendJsonError(server, 400, "invalid request body");
    return false;
  }
  if (static_cast<size_t>(contentLength) > maxBytes) {
    http::sendJsonError(server, 413, "request body too large");
    return false;
  }
  body = server.arg("plain");
  if (body.length() != static_cast<unsigned int>(contentLength)) {
    http::sendJsonError(server, 400, "invalid request body");
    return false;
  }
  return true;
}

bool requireIfMatch(WebServer& server, String& value) {
  value = server.header("If-Match");
  if (value.isEmpty()) {
    http::sendJsonError(server, 428, "If-Match is required");
    return false;
  }
  return true;
}

}  // namespace http
