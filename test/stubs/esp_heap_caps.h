// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstddef>
#include <cstdlib>

inline constexpr unsigned MALLOC_CAP_SPIRAM = 1U << 0;
inline constexpr unsigned MALLOC_CAP_INTERNAL = 1U << 1;
inline constexpr unsigned MALLOC_CAP_8BIT = 1U << 2;

inline void* heap_caps_malloc(size_t size, unsigned) {
  return std::malloc(size);
}

inline void heap_caps_free(void* data) { std::free(data); }
