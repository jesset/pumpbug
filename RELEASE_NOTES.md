# Release Notes

## Unreleased

Add the La Marzocco machine link: Pump Bug can now read the espresso
machine's own brew events over Bluetooth for exact shot timing instead of
inferring the pump window from vibration. Verified end-to-end on a Linea
Mini with gateway firmware v7.4.2.

The gateway exposes two Bluetooth services: an operational service
(token-gated notifications) and a connection service (open notifications).
Pump Bug tries both, so it works in either mode. On firmware that removed
token issuance (v7.4.x era), the connection service — entered by holding
the brew paddle left while powering on — delivers the full brew event
stream (start, per-second timer updates, stop with reason) without any
token or authentication.

Setup runs from the new La Marzocco page in the web interface: a Bluetooth
scan finds the machine, and a one-time sign-in to the La Marzocco cloud
fetches its identity (account credentials are never stored on the device).
The device menu gains a La Marzocco status screen showing the link state
and whether machine timing or vibration fallback is active.

When the machine link is live, the recorder uses the machine's own brew
timer for exact pump start/stop instead of the accelerometer's 0.3–0.5 s
detection window. If the link drops mid-shot, the recorder falls back to
vibration within the same tick. The vibration path remains the default for
machines without a Bluetooth gateway or when the link is inactive.


## v0.3.0

With v0.3.0, your shot history can include how each shot was prepared and how
it tasted, alongside its measured yield and timing. You can add coffee and
preparation details, compare shots made with the same coffee, and reuse a saved
recipe for the next shot.

This version also includes a much enhanced web experience and many reliability
improvements.

### Prepare the next shot

Using the web interface, you can now enter the coffee details and preparation
for your next shot, or reuse a previous shot's recipe. Set the grind, dose and
target yield, and apply the recipe's target to the device's yield alert.

If the browser is connected while brewing, the recipe selected at the start
is attached to the completed shot.

### Record the results

After brewing, add a rating, tasting notes or tags to keep what you tasted
with what you measured. You can also edit the coffee and preparation details,
or add them to shots already in your history.

If you measure TDS, enter it with the dose to calculate extraction yield from
the recorded beverage weight.

### Browse history by coffee

You can now group shots with the same coffee (name, roaster and roast date
must match). Open a stack to compare shots made with that coffee, then return
to the grouped view. Stacks include the shots loaded in the browser; loading
older history can add more shots to a coffee's stack.

There's also a new refresh button to pick up details changed in another
browser.

### Redesigned web experience

The revamped Live dashboard puts current readings first, with the next-shot
recipe and last-shot results below. Chart legends identify the plotted lines
and pump events.

Coffee, recipe and shot editors bring the related fields together, scroll
independently on phones, and keep keyboard focus in place while the dashboard
updates.

The main menu, pairing, Wi-Fi settings and logs share the dashboard's visual
design. Pump Bug also has an icon for browser tabs and Home Screen shortcuts.

### Device usability

- A completion tone signals that shot measurement has finished and the cup
  can be removed.
- Holding A while `LIVE` is idle tares the scale, including after a shot.
- After a flush, the idle timer returns to the last shot's duration.
- Opening saved shots, saving details and applying targets from the browser
  postpone automatic sleep.

### Reliability

- Brief scale disturbances when lifting the cup after the pump stops are less
  likely to throw off the recovered final yield.
- Newly recorded shots are verified after saving and include integrity checks
  to help detect damaged recordings.
- Shot-details drafts stay editable while the device sleeps and can be saved
  after it wakes or restarts. If another browser changes the saved details,
  you can review both versions before choosing which to keep.
- If Pump Bug can't join the saved Wi-Fi network at startup, you can now retry
  from the device without restarting it or repeating setup.

## v0.2.0

Settings will now survive subsequent updates. Until now, every M5Burner
installation wiped Wi-Fi details, browser pairing, target weight, and shot
counter. Pump Bug now keeps them in a part of the device that updates don't
touch.

### New

- Guided backflush: a timer that paces five 10-second pump bursts with
  10-second rests, following the pump so the steps stay in sync.
- The live screen shows when the pump is winding down, before it is confirmed
  off, and saved shot charts mark the same moment.

### Improved reliability

- Saved shots are protected if device settings are cleared or lost, with the
  option to retry, erase, or carry on without recording.
- Shot weight is recovered if the scale tares mid-extraction, instead of
  reporting a yield that looks too low.

### Updating from 0.1.x

Install without erasing the whole flash: press Start without Erase, or clear
"Erase whole flash before burning" in web M5Burner. Saved shots carry over,
but settings reset once on this update — set your Wi-Fi, pairing, and target
again afterwards. From here on, updates keep both. A full-chip erase still
deletes everything, so download any shots you want to keep first.

