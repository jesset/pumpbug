// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "crc32.h"

#include <cassert>

namespace pump_scale {

void Crc32::update(const uint8_t* data, size_t size) {
  assert(data || size == 0);
  if (!data) return;
  for (size_t index = 0; index < size; ++index) {
    _crc ^= data[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      const uint32_t mask = 0u - (_crc & 1u);
      _crc = (_crc >> 1) ^ (0xEDB88320u & mask);
    }
  }
}

}  // namespace pump_scale
