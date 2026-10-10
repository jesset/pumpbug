// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "ShotHistoryRoutes.h"

#include <WebServer.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "net/JsonStream.h"
#include "net/http_request_validation.h"
#include "net/http_response_util.h"
#include "util/storage.h"

namespace pump_scale {

namespace {

constexpr size_t kMaxListPageRows = 100;
constexpr size_t kMaxMetadataListPageRows = 20;
constexpr size_t kDefaultListPageRows = 20;

const char* metadataStateName(ShotUserMetadataState state) {
  switch (state) {
    case ShotUserMetadataState::Absent:
      return "absent";
    case ShotUserMetadataState::Active:
      return "active";
    case ShotUserMetadataState::Cleared:
      return "cleared";
    case ShotUserMetadataState::Corrupt:
      return "corrupt";
    case ShotUserMetadataState::Unsupported:
      return "unsupported";
  }
  return "corrupt";
}

bool metadataStateFromCode(char code, ShotUserMetadataState& state) {
  switch (code) {
    case 'a':
      state = ShotUserMetadataState::Absent;
      return true;
    case 'v':
      state = ShotUserMetadataState::Active;
      return true;
    case 'c':
      state = ShotUserMetadataState::Cleared;
      return true;
    case 'x':
      state = ShotUserMetadataState::Corrupt;
      return true;
    case 'u':
      state = ShotUserMetadataState::Unsupported;
      return true;
  }
  return false;
}

char metadataStateCode(ShotUserMetadataState state) {
  switch (state) {
    case ShotUserMetadataState::Absent:
      return 'a';
    case ShotUserMetadataState::Active:
      return 'v';
    case ShotUserMetadataState::Cleared:
      return 'c';
    case ShotUserMetadataState::Corrupt:
      return 'x';
    case ShotUserMetadataState::Unsupported:
      return 'u';
  }
  return 'x';
}

void makeMetadataEtag(char* out, size_t capacity, uint32_t nonce, uint32_t id,
                      const ShotUserMetadata& metadata) {
  std::snprintf(out, capacity, "\"shot-meta-%08lx-%08lx-%c-%08lx\"",
                static_cast<unsigned long>(nonce),
                static_cast<unsigned long>(id),
                metadataStateCode(metadata.state),
                static_cast<unsigned long>(metadata.crc32));
}

void makeShotListEtag(char* out, size_t capacity, uint32_t nonce,
                      uint32_t revision, uint32_t before, size_t limit,
                      bool includeMetadata) {
  std::snprintf(out, capacity, "W/\"shots-%08lx-%lu-%c-%lu-%lu\"",
                static_cast<unsigned long>(nonce),
                static_cast<unsigned long>(revision),
                includeMetadata ? 'm' : 'p', static_cast<unsigned long>(before),
                static_cast<unsigned long>(limit));
}

bool parseShotId(const String& s, uint32_t& out) {
  char* endp = nullptr;
  const unsigned long parsed = std::strtoul(s.c_str(), &endp, 10);
  if (endp == s.c_str() || *endp != '\0' || parsed == 0) return false;
  out = static_cast<uint32_t>(parsed);
  return true;
}

bool requireShotStorage(WebServer& server) {
  if (storage::mountState() == storage::MountState::Ready) return true;
  // An unavailable volume is neither empty history nor a missing record, so
  // report the recovery condition before emitting an ETag or reading a file.
  http::sendJsonError(server, 503, "shot history unavailable");
  return false;
}

void handleShotRecovery(WebServer& server, ShotStore& store, uint32_t id) {
  storage::FileSnapshot file;
  switch (store.readStoredFile(id, file)) {
    case ShotStoreReadResult::Missing:
      http::sendJsonError(server, 404, "not found");
      return;
    case ShotStoreReadResult::InvalidRecord:
    case ShotStoreReadResult::Error:
      http::sendJsonError(server, 500, "record recovery read failed");
      return;
    case ShotStoreReadResult::Ok:
      break;
  }

  server.sendHeader("Cache-Control", "no-store");
  server.setContentLength(file.size());
  server.send(200, "application/octet-stream", "");

  WiFiClient client = server.client();
  size_t offset = 0;
  while (offset != file.size()) {
    const size_t count = std::min(file.size() - offset, size_t{512});
    if (client.write(file.data() + offset, count) != count) {
      client.stop();
      return;
    }
    offset += count;
  }
}

void handleShotDetail(WebServer& server, ShotStore& store) {
  uint32_t id = 0;
  if (!parseShotId(server.arg("id"), id)) {
    http::sendJsonError(server, 400, "bad id");
    return;
  }
  if (!requireShotStorage(server)) return;

  if (server.hasArg("recovery") && server.arg("recovery") == "1") {
    handleShotRecovery(server, store, id);
    return;
  }

  // The extraction body is immutable for each nonce and shot ID; metadata
  // updates change only the file's tail.
  char detailEtag[40];
  std::snprintf(detailEtag, sizeof(detailEtag), "\"shot-%08lx-%lu\"",
                static_cast<unsigned long>(store.shotStoreNonce()),
                static_cast<unsigned long>(id));
  if (server.hasHeader("If-None-Match")) {
    // Check file access before returning 304: a matching cached ETag does not
    // establish that the file still exists or can be opened.
    switch (store.checkFileAccess(id)) {
      case storage::FileOpenResult::Missing:
        http::sendJsonError(server, 404, "not found");
        return;
      case storage::FileOpenResult::Error:
        http::sendJsonError(server, 500, "record read failed");
        return;
      case storage::FileOpenResult::Opened:
        break;
    }
    if (http::etagOr304(server, detailEtag)) return;
  }

  EncodedExtraction record;
  switch (store.readEncodedExtraction(id, record)) {
    case ShotStoreReadResult::Missing:
      http::sendJsonError(server, 404, "not found");
      return;
    case ShotStoreReadResult::InvalidRecord:
      http::sendJsonError(server, 422, "record unreadable");
      return;
    case ShotStoreReadResult::Error:
      http::sendJsonError(server, 500, "record read failed");
      return;
    case ShotStoreReadResult::Ok:
      break;
  }

  server.sendHeader("ETag", detailEtag);
  server.sendHeader("Cache-Control", "private, no-cache");
  server.setContentLength(record.size);
  server.send(200, "application/octet-stream", "");
  server.sendContent(reinterpret_cast<const char*>(record.data.get()),
                     record.size);
}

void writeShotRow(JsonStream& j, uint32_t id, const ShotSummary& summary,
                  bool includeMetadata, const ShotUserMetadata& userMetadata,
                  uint32_t nonce) {
  j.open().key("id").u(id);
  if (summary.available) {
    j.key("startUtcSec")
        .u(summary.startUtcSec)
        .key("beginMs")
        .u(summary.beginMs)
        .key("durationMs")
        .u(summary.durationMs)
        .key("yieldCg")
        .i(summary.yieldCg)
        .key("totalPumpOnMs")
        .u(summary.totalPumpOnMs);
  }
  if (includeMetadata) {
    j.key("userMetadataState")
        .str(userMetadata.available ? metadataStateName(userMetadata.state)
                                    : "unavailable");
    j.key("userMetadata");
    if (userMetadata.available &&
        userMetadata.state == ShotUserMetadataState::Active) {
      j.raw(userMetadata.json.data(), userMetadata.json.size());
    } else {
      j.null_();
    }
    if (userMetadata.available) {
      j.key("userMetadataCrc").u(userMetadata.crc32);
      char metadataEtag[64];
      makeMetadataEtag(metadataEtag, sizeof(metadataEtag), nonce, id,
                       userMetadata);
      j.key("userMetadataEtag").str(metadataEtag);
    }
  }
  j.close();
}

void handleShotList(WebServer& server, ShotStore& store) {
  if (!requireShotStorage(server)) return;

  // `before=N` returns records with IDs below N; zero starts at the newest
  // record. `limit` defaults to 20 and is capped at 100 for summaries and 20
  // when metadata is included.
  uint32_t before = 0;
  if (server.hasArg("before")) {
    before = static_cast<uint32_t>(
        std::strtoul(server.arg("before").c_str(), nullptr, 10));
  }
  const bool includeMetadata =
      server.hasArg("meta") && server.arg("meta") == "1";
  const size_t maximum =
      includeMetadata ? kMaxMetadataListPageRows : kMaxListPageRows;
  size_t limit = kDefaultListPageRows;
  if (server.hasArg("limit")) {
    const unsigned long l =
        std::strtoul(server.arg("limit").c_str(), nullptr, 10);
    limit = l < 1 ? 1 : static_cast<size_t>(l);
  }
  limit = std::min(limit, maximum);

  bool hasMore = false;
  size_t total = 0;
  uint32_t rev = 0;
  std::vector<uint32_t> ids;
  if (!store.page(before, limit, ids, &hasMore, &total, &rev)) {
    http::sendJsonError(server, 500, "shot history listing failed");
    return;
  }

  const uint32_t nonce = store.shotStoreNonce();
  char etag[80];
  makeShotListEtag(etag, sizeof(etag), store.bootNonce(), rev, before, limit,
                   includeMetadata);
  if (http::etagOr304(server, etag)) return;
  server.sendHeader("ETag", etag);

  // Send each row as it is read so memory use does not grow with the page. The
  // ETag must be set before JsonStream starts the response in its constructor.
  JsonStream j(server);
  j.open().key("shots").arrayOpen();
  bool first = true;
  for (const uint32_t id : ids) {
    if (!first) j.comma();
    first = false;
    // Even if a file cannot be read, we keep it in the response list.
    // This keeps the cursor for the next page and the totals consistent, and
    // lets the user see when entries have been corrupted and delete them if
    // desired.
    ShotHistoryEntry entry;
    bool read = false;
    if (includeMetadata) {
      read = store.readHistoryEntry(id, entry);
    } else {
      read = store.readSummary(id, entry.summary);
    }
    if (!read) entry = ShotHistoryEntry{};
    writeShotRow(j, id, entry.summary, includeMetadata, entry.userMetadata,
                 nonce);
  }
  j.arrayClose()
      .key("shotStoreNonce")
      .u(nonce)
      .key("hasMore")
      .boolean(hasMore)
      .key("total")
      .u(static_cast<uint32_t>(total))
      .close();
  j.finish();
}

bool requireShotId(WebServer& server, uint32_t& id) {
  if (!server.hasArg("id") || !parseShotId(server.arg("id"), id)) {
    http::sendJsonError(server, 400, "bad id");
    return false;
  }
  return requireShotStorage(server);
}

bool requireMetadataPrecondition(WebServer& server, const ShotStore& store,
                                 uint32_t id, ShotUserMetadata& expected) {
  String ifMatch;
  if (!http::requireIfMatch(server, ifMatch)) return false;
  const std::string value = ifMatch.c_str();
  unsigned long nonce = 0;
  unsigned long etagId = 0;
  unsigned long crc = 0;
  char stateCode = '\0';
  int consumed = 0;
  if (std::sscanf(value.c_str(), "\"shot-meta-%8lx-%8lx-%c-%8lx\"%n", &nonce,
                  &etagId, &stateCode, &crc, &consumed) != 4 ||
      consumed != static_cast<int>(value.size()) ||
      !metadataStateFromCode(stateCode, expected.state)) {
    http::sendJsonError(server, 400, "invalid If-Match");
    return false;
  }
  expected.available = true;
  expected.crc32 = static_cast<uint32_t>(crc);

  char canonical[64];
  makeMetadataEtag(canonical, sizeof(canonical), static_cast<uint32_t>(nonce),
                   static_cast<uint32_t>(etagId), expected);
  if (value != canonical) {
    http::sendJsonError(server, 400, "invalid If-Match");
    return false;
  }
  if (nonce != store.shotStoreNonce() || etagId != id) {
    server.sendHeader("X-Shot-Metadata-Conflict", "shot-identity");
    http::sendJsonError(server, 412,
                        "shot identity changed; reopen before saving");
    return false;
  }
  return true;
}

void setMetadataResponseHeaders(WebServer& server,
                                const ShotUserMetadata& metadata,
                                const char* etag) {
  server.sendHeader("ETag", etag);
  server.sendHeader("Cache-Control", "private, no-cache");
  server.sendHeader("X-Shot-Metadata-State", metadataStateName(metadata.state));
  char crc[16];
  std::snprintf(crc, sizeof(crc), "%lu",
                static_cast<unsigned long>(metadata.crc32));
  server.sendHeader("X-Shot-Metadata-Crc", crc);
}

bool sendReadableMetadata(WebServer& server, uint32_t id,
                          const ShotStore& store,
                          const ShotUserMetadata& metadata, bool allow304) {
  char etag[64];
  makeMetadataEtag(etag, sizeof(etag), store.shotStoreNonce(), id, metadata);

  if (metadata.state == ShotUserMetadataState::Corrupt) {
    setMetadataResponseHeaders(server, metadata, etag);
    http::sendJsonError(server, 409, "shot metadata is corrupt");
    return false;
  }
  if (metadata.state == ShotUserMetadataState::Unsupported) {
    setMetadataResponseHeaders(server, metadata, etag);
    http::sendJsonError(server, 409, "shot metadata version is unsupported");
    return false;
  }

  if (allow304 && http::etagOr304(server, etag)) return true;
  setMetadataResponseHeaders(server, metadata, etag);
  if (metadata.state == ShotUserMetadataState::Active) {
    server.send(200, "application/json", metadata.json.c_str());
  } else {
    server.send(200, "application/json", "{}");
  }
  return true;
}

void sendMetadataWriteError(WebServer& server,
                            ShotUserMetadataWriteResult result) {
  switch (result) {
    case ShotUserMetadataWriteResult::Missing:
      http::sendJsonError(server, 404, "not found");
      return;
    case ShotUserMetadataWriteResult::InvalidRecord:
      http::sendJsonError(server, 422, "record unreadable");
      return;
    case ShotUserMetadataWriteResult::InvalidJson:
      http::sendJsonError(server, 400, "invalid shot metadata JSON");
      return;
    case ShotUserMetadataWriteResult::NotObject:
      http::sendJsonError(server, 400, "shot metadata must be a JSON object");
      return;
    case ShotUserMetadataWriteResult::Unsupported:
      http::sendJsonError(server, 409, "shot metadata version is unsupported");
      return;
    case ShotUserMetadataWriteResult::Conflict:
      server.sendHeader("X-Shot-Metadata-Conflict", "metadata");
      http::sendJsonError(server, 412,
                          "shot metadata changed; reload before saving");
      return;
    case ShotUserMetadataWriteResult::CannotRepair:
      http::sendJsonError(server, 409,
                          "damaged shot metadata cannot be replaced");
      return;
    case ShotUserMetadataWriteResult::TooLarge:
      http::sendJsonError(server, 413, "shot metadata is too large");
      return;
    case ShotUserMetadataWriteResult::Error:
      http::sendJsonError(server, 500, "could not update shot metadata");
      return;
    case ShotUserMetadataWriteResult::Ok:
      return;
  }
}

}  // namespace

void handleShotHistory(WebServer& server, ShotStore& store) {
  if (server.hasArg("id")) {
    handleShotDetail(server, store);
  } else {
    handleShotList(server, store);
  }
}

void handleShotMetadataGet(WebServer& server, ShotStore& store) {
  uint32_t id = 0;
  if (!requireShotId(server, id)) return;

  ShotUserMetadata metadata;
  switch (store.readUserMetadata(id, metadata)) {
    case ShotStoreReadResult::Missing:
      http::sendJsonError(server, 404, "not found");
      return;
    case ShotStoreReadResult::InvalidRecord:
      http::sendJsonError(server, 422, "record unreadable");
      return;
    case ShotStoreReadResult::Error:
      http::sendJsonError(server, 500, "shot metadata read failed");
      return;
    case ShotStoreReadResult::Ok:
      break;
  }
  sendReadableMetadata(server, id, store, metadata, true);
}

void handleShotMetadataInitialize(WebServer& server, ShotStore& store,
                                  uint32_t eligibleShotId) {
  uint32_t id = 0;
  if (!requireShotId(server, id)) return;
  String body;
  if (!http::requireJsonRequestBody(server, kMaxShotMetadataJsonBytes, body))
    return;
  if (id != eligibleShotId) {
    http::sendJsonError(
        server, 409,
        "shot is not eligible for automatic metadata initialization",
        "shot_not_eligible");
    return;
  }

  ShotUserMetadata saved;
  const auto result = store.initializeUserMetadata(
      id, reinterpret_cast<const uint8_t*>(body.c_str()), body.length(), saved);
  if (result == ShotUserMetadataWriteResult::Conflict) {
    http::sendJsonError(server, 409,
                        "shot metadata has already been set or cleared",
                        "metadata_not_absent");
    return;
  }
  if (result != ShotUserMetadataWriteResult::Ok) {
    sendMetadataWriteError(server, result);
    return;
  }
  sendReadableMetadata(server, id, store, saved, false);
}

void handleShotMetadataPut(WebServer& server, ShotStore& store) {
  uint32_t id = 0;
  if (!requireShotId(server, id)) return;
  String body;
  if (!http::requireJsonRequestBody(server, kMaxShotMetadataJsonBytes, body))
    return;
  ShotUserMetadata expected;
  if (!requireMetadataPrecondition(server, store, id, expected)) return;

  ShotUserMetadata saved;
  const auto result = store.writeUserMetadata(
      id, reinterpret_cast<const uint8_t*>(body.c_str()), body.length(),
      expected, saved);
  if (result != ShotUserMetadataWriteResult::Ok) {
    sendMetadataWriteError(server, result);
    return;
  }
  sendReadableMetadata(server, id, store, saved, false);
}

void handleShotMetadataDelete(WebServer& server, ShotStore& store) {
  uint32_t id = 0;
  if (!requireShotId(server, id)) return;
  ShotUserMetadata expected;
  if (!requireMetadataPrecondition(server, store, id, expected)) return;

  ShotUserMetadata saved;
  const auto result = store.clearUserMetadata(id, expected, saved);
  if (result != ShotUserMetadataWriteResult::Ok) {
    sendMetadataWriteError(server, result);
    return;
  }
  sendReadableMetadata(server, id, store, saved, false);
}

}  // namespace pump_scale
