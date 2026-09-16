// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

class HttpServer;
class TargetStore;

namespace pump_scale {

void registerTargetRoutes(HttpServer& http, TargetStore& store);

}  // namespace pump_scale
