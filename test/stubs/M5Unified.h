// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <Arduino.h>

#include <cstdint>

void testM5LogInfo(const char* format, ...);
void testM5LogWarning(const char* format, ...);
void testM5LogError(const char* format, ...);
void testDisplayPowerSaveOn();
void testDisplayPowerSaveOff();

struct TestM5Display {
  uint16_t brightness = 128;
  unsigned brightnessChanges = 0;

  uint16_t getBrightness() const { return brightness; }
  void setBrightness(uint16_t value) {
    brightness = value;
    ++brightnessChanges;
  }
  void powerSaveOn() { testDisplayPowerSaveOn(); }
  void powerSaveOff() { testDisplayPowerSaveOff(); }
};

// Enough of M5.Speaker for the codec lifecycle: which calls were made, and a
// playback flag the test drives. It models the API, not the hardware — the I2S
// DMA tail that makes a too-early release truncate a cue has no equivalent
// here, so that remains a hardware-only concern.
struct TestM5Speaker {
  bool beginSucceeds = true;
  bool playing = false;
  unsigned begins = 0;
  unsigned ends = 0;
  int volume = 0;

  bool begin() {
    ++begins;
    return beginSucceeds;
  }
  void end() { ++ends; }
  bool isPlaying() const { return playing; }
  void setVolume(int v) { volume = v; }
};

struct TestM5Power {
  unsigned shutdowns = 0;
  void powerOff() { ++shutdowns; }
};

struct TestM5 {
  TestM5Power Power;
  TestM5Display Display;
  TestM5Speaker Speaker;
};

extern TestM5 M5;

#define M5_LOGD(...)
#define M5_LOGI(...) testM5LogInfo(__VA_ARGS__)
#define M5_LOGW(...) testM5LogWarning(__VA_ARGS__)
#define M5_LOGE(...) testM5LogError(__VA_ARGS__)
