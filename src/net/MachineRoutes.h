// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

class HttpServer;
class LmMachineStore;

namespace lm {
class LmCloudClient;
}

// Registers the La Marzocco machine-provisioning routes under
// /app/machine/* (see docs/lamarzocco.md). All routes require pairing.
//
//   GET  /status       provisioning snapshot (address, identity, token)
//   POST /scan         arm the Bluetooth discovery scan (reuses the
//                      diagnostics scan's finite lease)
//   GET  /scan         discovered La Marzocco advertisers so far
//   POST /select       {address, name} — remember the chosen machine
//   POST /credentials  {username, password} — start the cloud run
//   GET  /cloud        cloud run state; machines list once fetched
//   POST /choose       {serial} — persist that machine's identity/token
//   POST /token        {token, serial} — manual token entry
//   POST /forget       wipe all machine data
void registerMachineRoutes(HttpServer& http, LmMachineStore& store,
                           lm::LmCloudClient& cloud);
