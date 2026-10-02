// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

// Host stub for the FreeRTOS types used by single-threaded tests.

#include <cassert>
#include <cstdint>

#define configASSERT(value) assert(value)

using TickType_t = uint32_t;
using portMUX_TYPE = int;

#define portMAX_DELAY 0xFFFFFFFFU
#define pdTRUE 1
#define pdFALSE 0
#define pdMS_TO_TICKS(ms) (static_cast<TickType_t>(ms))
#define portMUX_INITIALIZER_UNLOCKED 0

inline void portENTER_CRITICAL(portMUX_TYPE*) {}
inline void portEXIT_CRITICAL(portMUX_TYPE*) {}
