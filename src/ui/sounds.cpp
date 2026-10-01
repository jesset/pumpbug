// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "ui/sounds.h"

#include <M5Unified.h>

#include <algorithm>

#include "power/SpeakerCodec.h"

namespace sounds {
namespace {

constexpr int kUiChannel = 6;
constexpr int kTargetChannel = 7;
constexpr int kBackflushChannel = 5;
constexpr int kShotCompleteChannel = 4;
constexpr uint16_t kCountdownFrequencies[] = {2100, 2181, 2264, 2351, 2440};
constexpr uint16_t kCountdownFreqEndHz = kCountdownFrequencies[4];
constexpr uint16_t kShotCompleteFrequenciesHz[] = {1400, 1867};
constexpr uint32_t kShotCompleteNoteDurationMs = 90;
constexpr uint8_t kShotCompleteVolume = 200;

// Keep the amplifier active across a normal cluster of interactions. Hardware
// tests have occasionally produced a distorted cue when the StickS3 amplifier
// was restarted only milliseconds after release. Five seconds reduces those
// rapid off/on transitions; it is a mitigation, not a measured settling-time
// requirement.
constexpr uint32_t kCueKeepAliveMs = 5000;

bool ensurePowered() {
  return power::speakerCodec.keepUntil(millis() + kCueKeepAliveMs);
}

void playCue(int channel, uint8_t volume, uint16_t freqHz,
             uint32_t durationMs) {
  if (!ensurePowered()) return;
  M5.Speaker.setChannelVolume(channel, volume);
  M5.Speaker.tone(freqHz, durationMs, channel, true);
}

}  // namespace

void warmUpSpeaker() { ensurePowered(); }

void buttonPress() { playCue(kUiChannel, 64, 1200, 25); }

void buttonHold() { playCue(kUiChannel, 128, 1500, 100); }

void buttonDoublePress() { playCue(kUiChannel, 128, 1800, 100); }

uint16_t countdownBeepFreq(int bucket) {
  // bucket 1..5 maps to array index 0..4 (bucket 1 -> final pitch).
  const int index = std::max(0, std::min(4, 5 - bucket));
  return kCountdownFrequencies[index];
}

// Powers the codec at the start of the alert so the first beep isn't clipped by
// speaker-init latency. The keep-alive is re-extended by each beep below,
// holding the codec across the whole countdown.
void prepareTargetAlert() { ensurePowered(); }

// The target cues share one dedicated channel so a re-issued tone replaces the
// previous one rather than stacking (the default tone() path auto-allocates a
// channel each call). Perceptually spaced countdown pitches (5 s -> 1 s) give a
// gentle ~65 cent rise per step; cadence remains the primary cue.
void targetApproach(uint16_t freqHz) {
  playCue(kTargetChannel, 200, freqHz, 50);
}

// Sustained cut-now tone. Reuses the final countdown pitch so the cut never
// drifts from the end of the countdown sequence.
void targetCut() { playCue(kTargetChannel, 220, kCountdownFreqEndHz, 500); }

void targetSilence() {
  if (power::speakerCodec.isSpeakerRunning()) M5.Speaker.stop(kTargetChannel);
}

void shotComplete() {
  if (!ensurePowered()) return;
  M5.Speaker.setChannelVolume(kShotCompleteChannel, kShotCompleteVolume);
  M5.Speaker.tone(kShotCompleteFrequenciesHz[0], kShotCompleteNoteDurationMs,
                  kShotCompleteChannel, true);
  // Queue the second note on the same channel so it follows without a gap.
  M5.Speaker.tone(kShotCompleteFrequenciesHz[1], kShotCompleteNoteDurationMs,
                  kShotCompleteChannel, false);
}

// Uses a short, quiet cue on the backflush channel. The caller chooses the
// pitch so the countdown schedule remains with the routine that owns it.
void backflushCountdown(uint16_t freqHz) {
  playCue(kBackflushChannel, 180, freqHz, 60);
}

void backflushStartPump() { playCue(kBackflushChannel, 200, 1900, 220); }

void backflushStopPump() { playCue(kBackflushChannel, 220, 1100, 400); }

void backflushComplete() { playCue(kBackflushChannel, 220, 2300, 600); }

void backflushSilence() {
  if (power::speakerCodec.isSpeakerRunning())
    M5.Speaker.stop(kBackflushChannel);
}

}  // namespace sounds
