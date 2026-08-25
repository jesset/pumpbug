// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdint>

namespace pump_scale {

// Incremental CRC-32/ISO-HDLC.
class Crc32 {
 public:
  void update(const uint8_t* data, size_t size);
  uint32_t value() const { return _crc ^ 0xFFFFFFFFu; }

 private:
  uint32_t _crc = 0xFFFFFFFFu;
};

}  // namespace pump_scale
