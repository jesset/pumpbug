// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include "ShotStore.h"

class WebServer;

namespace pump_scale {

// Handles shot-history and user-metadata HTTP requests. ShotStore owns file
// access, pagination, and metadata updates; these functions parse HTTP inputs,
// enforce HTTP preconditions, and build responses.
void handleShotHistory(WebServer& server, ShotStore& store);
void handleShotMetadataGet(WebServer& server, ShotStore& store);
void handleShotMetadataInitialize(WebServer& server, ShotStore& store,
                                  uint32_t eligibleShotId);
void handleShotMetadataPut(WebServer& server, ShotStore& store);
void handleShotMetadataDelete(WebServer& server, ShotStore& store);

}  // namespace pump_scale
