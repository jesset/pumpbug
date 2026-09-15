// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>

class WebServer;
class String;

namespace http {

// Read a nonempty application/json body of at most maxBytes and verify its
// declared length. Oversized declarations receive 413 before copying the body;
// WebServer has already buffered the incoming request. Other invalid lengths
// receive 400, and unsupported content types receive 415.
// JSON syntax and field validation belong to the caller.
bool requireJsonRequestBody(WebServer& server, size_t maxBytes, String& body);

// Read a nonempty If-Match header, or send a JSON 428 response. The caller
// validates the token and evaluates the resource's precondition.
bool requireIfMatch(WebServer& server, String& value);

}  // namespace http
