// SPDX-FileCopyrightText: 2026 ludable
// SPDX-License-Identifier: AGPL-3.0-only

#include "MachineStatusScreen.h"

#include "ble/BleScaleService.h"
#include "ui/blocks.h"
#include "ui/chrome/ChromeContent.h"
#include "ui/theme.h"

void MachineStatusScreen::onEnter() {
  _confirmForget = false;
  requestDraw();
}

ButtonHints MachineStatusScreen::buttonHints() const {
  ButtonHints h{};
  h.b.tap = Hint{HintGlyph::Back, nullptr};
  h.a.hold = Hint{HintGlyph::Trash, _confirmForget ? "Confirm" : "Forget"};
  return h;
}

ScreenResult MachineStatusScreen::onEvent(button::Gesture event) {
  switch (event) {
    case button::Gesture::B_SHORT:
      return exit();
    case button::Gesture::A_LONG: {
      // Two-stage confirm, mirroring EraseDataScreen's idiom.
      if (!_confirmForget) {
        if (!_store.snapshot().provisioned) return ignored();
        _confirmForget = true;
        requestDraw();
        return stay();
      }
      _store.clear();
      _confirmForget = false;
      requestDraw();
      return stay();
    }
    default:
      return ignored();
  }
}

bool MachineStatusScreen::onDraw(LGFX_Sprite* c) {
  const LmMachineStore::Machine m = _store.snapshot();
  const BleScaleService::MachineSnapshot link = bleScale.machineSnapshot();
  using L = BleScaleService::MachineSnapshot::Link;
  const bool live = link.link == L::Subscribed;
  const char* linkText = live       ? "connected"
                         : link.link == L::Backoff ? "retrying"
                         : link.link == L::Idle    ? "waiting"
                                                    : "off";
  const int headerH = ui::drawViewHeader(
      c, "LA MARZOCCO", theme::fg(), live ? "LIVE" : nullptr,
      live ? theme::ok() : theme::dim());

  if (!m.provisioned) {
    ui::InfoBlock blocks[] = {
        {"", "Set up in the browser:", theme::fg()},
        {"", "Wi-Fi \xE2\x86\x92 La Marzocco", theme::accent()},
    };
    ui::drawInfoScreen(c, headerH,
                       "The machine link reads the espresso machine's own "
                       "brew events over Bluetooth for exact shot timing. "
                       "Provision it from the web interface.",
                       "Use the web interface to set up.", blocks, 2,
                       theme::bg(), nullptr);
    return true;
  }

  const bool confirming = _confirmForget;
  // Four rows: practical operational info, not diagnostics. The address
  // and serial are visible in the web interface when needed.
  ui::InfoBlock blocks[] = {
      {"Machine", m.bleName[0] != '\0' ? m.bleName : "-", theme::fg()},
      {"Model", m.model[0] != '\0' ? m.model : "-", theme::fg()},
      {"Link", linkText, live ? theme::ok() : theme::dim()},
      {"Events", live ? "machine timing" : "vibration fallback",
       live ? theme::ok() : theme::dim()},
  };
  ui::drawInfoScreen(c, headerH,
                     confirming
                         ? "Hold A again to erase the machine link."
                         : "Hold A to forget this machine.",
                     nullptr, blocks, 4, theme::bg(), nullptr);
  return true;
}
