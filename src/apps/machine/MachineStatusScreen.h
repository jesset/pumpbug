// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#pragma once

#include <M5Unified.h>

#include "ble/lamarzocco/LmMachineStore.h"
#include "ui/Screen.h"
#include "ui/button.h"

// Read-only status screen for the La Marzocco machine link. Setup itself
// happens in the browser (Pairing & Wi-Fi → La Marzocco); this screen shows
// what the device currently knows and offers to forget it.
class MachineStatusScreen : public Screen {
 public:
  explicit MachineStatusScreen(LmMachineStore& store) : _store(store) {}

  void onEnter() override;
  ScreenResult onEvent(button::Gesture event) override;
  bool onDraw(LGFX_Sprite* canvas) override;
  ButtonHints buttonHints() const override;

 private:
  LmMachineStore& _store;
  bool _confirmForget = false;
};
