// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

class WebServer;

namespace http {

// Conditional-GET helper for ETag validators. If the client's If-None-Match
// equals `etag`, sets the ETag response header, sends a 304, and returns true.
// On a miss it sets nothing and returns false — the caller emits its own ETag
// header before the 200 body, so the validator on a 200 always describes the
// body that's actually streamed. (Used by the runtime event logs and shot
// history.)
bool etagOr304(WebServer& s, const char* etag);

// Send an application/json response with an escaped message in the error field.
// A non-null reason adds a machine-readable reason field, also escaped.
void sendJsonError(WebServer& server, int status, const char* message,
                   const char* reason = nullptr);

}  // namespace http
