// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

class WebServer;

namespace http {

// Send an application/json response with an escaped message in the error field.
// A non-null reason adds a machine-readable reason field, also escaped.
void sendJsonError(WebServer& server, int status, const char* message,
                   const char* reason = nullptr);

}  // namespace http
