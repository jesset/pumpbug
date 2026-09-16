// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <cstdint>
#include <cstdio>
#include <string>

#include "Extraction.h"

namespace pump_scale {

struct TargetSettings {
  uint16_t targetCg = 0;
  bool armed = false;
  bool available = false;

  bool sameValues(const TargetSettings& other) const {
    return targetCg == other.targetCg && armed == other.armed;
  }
  static constexpr size_t kEtagBufferSize = 24;

  // Validator for target weight and enablement, independent of availability.
  std::string etag() const {
    char token[kEtagBufferSize];
    std::snprintf(token, sizeof(token), "\"target-%u-%u\"",
                  static_cast<unsigned>(targetCg), armed ? 1u : 0u);
    return token;
  }
  TargetCoeffs coeffs() const {
    TargetCoeffs out;
    out.targetCg = static_cast<int16_t>(targetCg);
    out.armed = armed;
    return out;
  }
  static bool valid(uint16_t target, bool enabled) {
    return target == 0 ? !enabled
                       : target >= kMinTargetCg && target <= kMaxTargetCg &&
                             target % kTargetStepCg == 0;
  }
};

}  // namespace pump_scale
