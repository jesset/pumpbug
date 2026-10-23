# La Marzocco machine link

Pump Bug can read exact brew events from a La Marzocco espresso machine with
the connected (IoT) gateway module — Linea Mini, Linea Micra, GS3, and
related models. This page documents the protocol Pump Bug speaks and the
provisioning flow implemented so far.

## Why a machine link

Shot detection normally starts from pump vibration detected by the
accelerometer. That signal is universal but approximate: the window opens
0.3–0.5 s after the pump actually starts (FFT frame batching plus a two-frame
confirm), a pump restart must be heuristically joined to the same shot, and a
flush is only distinguished from a shot by weight evidence afterwards.

The machine's own Bluetooth notifications carry the exact timing: a
`BrewingStarted` event, the machine's internal brew timer at ~1 Hz, and a
`BrewingStopped` event with stop reason and final duration. Used as the
authoritative start/stop signal, this removes the estimation entirely. The
scale remains the source of truth for weight and yield; the machine link
only sharpens timing and labels events (shot vs flush vs backflush).

## Protocol reference

Sources: the open-source [`pylamarzocco`](https://github.com/zweckj/pylamarzocco)
client used by Home Assistant, and captures of a Linea Micra (see
`test/test_lm_notification.cpp` for real payloads; the Linea Mini uses the
same Group1 format).

### GATT service

All characteristics live under service
`d30a7847-e12b-09a8-b04b-8e0922a9abab`:

| Characteristic | Purpose |
|---|---|
| `0a0b7847-…` | read requests (settings, mode) |
| `0b0b7847-…` | write commands (JSON, NUL-terminated) |
| `0c0b7847-…` | token exchange |
| `0d0b7847-…` | authentication (write token, read `0x01`) |
| `0e0b7847-…` | shot counter notifications (this link's data source) |

Authentication: write the `bleAuthToken` string to `0d0b…`, then read the
same characteristic up to 10 times at 50 ms intervals; `0x01` means accepted.
The machine serves **one** Bluetooth client at a time — the phone app and
Home Assistant must be disconnected for Pump Bug to connect.

The gateway advertises as `MINI_<n>`, `MICRA_<n>`, `LINEA_<n>`, `GS3<n>`, …
(see the name prefixes in Home Assistant's `lamarzocco` manifest). While
another client holds the connection, the gateway does not advertise.

### Shot counter notifications

Small flat JSON objects, NUL-padded. Brewing keys:

```json
{"BrewingStartedGroup1DoseIndex":"ContinuousDose"}
{"BrewingUpdateGroup1Time":5.479,"BrewingUpdateGroup1Ev":true,
 "BrewingUpdateGroup1Backflush":false}
{"BrewingStoppedGroup1StopType":"Continuous",
 "BrewingStoppedGroup1StopReason":"Manual",
 "BrewingStoppedGroup1Time":12.727}
{"FlushStoppedGroup1DoseIndex":"ContinuousDose","FlushStoppedGroup1Time":1.891}
```

Telemetry keys ride along in the same characteristic:
`SteamBoilerUpdateTemperature`, `CoffeeBoiler1UpdateTemperature`,
`MachineMode`, `MachineStatistics`, … — Pump Bug ignores everything except
the machine mode.

Two behaviors must be mirrored from `pylamarzocco`'s `_BrewingTracker`
(`src/ble/lamarzocco/LmNotification.{h,cpp}` ports it, host-tested):

* On subscribing, the machine **replays its last notification**, which can be
  hours old. The first notification after a subscribe must be dropped.
* Notifications merge field-wise until a state derives: stop keys win, then
  flush keys, then backflush, then a start/timer pair; a derived Flushed or
  BrewingStopped state is emitted once and the pending data resets.

### Cloud credential exchange

The `bleAuthToken` is issued per machine by the La Marzocco cloud
(`lion.lamarzocco.io`, chain rooted at Amazon Root CA 1). Pump Bug's
provisioning (`src/ble/lamarzocco/LmCloudClient.cpp`) performs the same
exchange as the official client:

1. Generate a per-run installation identity: a P-256 keypair plus a 32-byte
   secret derived from the installation UUID (`Y5.e` scheme; the proof
   algorithm is ported byte-exactly in `LmCrypto.{h,cpp}` and pinned to
   reference vectors in `test/test_lm_crypto.cpp`).
2. `POST /auth/init` with the public key — registers the installation.
3. `POST /auth/signin` with username/password and ECDSA-signed headers —
   returns access/refresh tokens.
4. `GET /things` — the account's machines, including `bleAuthToken` per
   machine.

Account credentials exist only for the duration of one provisioning run (a
background task) and are wiped from RAM afterwards; only the machine's
token, serial, and Bluetooth address are persisted in NVS
(`LmMachineStore`). The cloud is not contacted again afterwards.

## Setup flow (implemented)

1. **Discover** — `/machine/` in the browser (or the device menu) triggers a
   Bluetooth discovery scan (reusing the diagnostics scan's finite lease;
   it yields to an in-use scale connection) and lists `MINI_*`-style
   advertisers with RSSI. Picking one stores its address.
2. **Sign in** — the browser posts La Marzocco account credentials to the
   device; the device performs the cloud exchange above and lists the
   account's machines. Picking one stores its serial, model, and token.
   A manual token paste (`/app/machine/token`) works without cloud access.
3. **Forget** — erases address, serial, and token. Saved shots are not
   affected.

Routes live under `/app/machine/*` (`src/net/MachineRoutes.cpp`), all
requiring browser pairing. The device menu shows the same status and offers
the two-stage forget.

## Gateway firmware eras (verified 2026-10)

The protocol surface depends heavily on the gateway firmware generation:

| Era | Cloud token | `0D0B` auth char | Shot-counter notifications |
|---|---|---|---|
| ≤ v5.0.8 (pre-2025-04) | issued via `/things` | present | after token auth |
| v5.0.9 – 5.0.10 | LM broke local API + old cloud endpoints; HA forced a rewrite; "officially only the Micra and the Mini R retained some Bluetooth functionality" | varies | varies |
| **v7.4.2 (user's Linea Mini, verified by hand)** | **`bleAuthToken: null`** for every client — issuance removed | absent in operational mode (`d30a` service); **present in connection mode (`d10a` service) but reads N/A** | **open in connection mode (`d10a` service, paddle-left boot) — no auth needed, full event stream flows; token-gated in operational mode (`d30a`)** |

Practical consequence: on current gateway firmware the cloud provisioning
path is dead for the original Linea Mini, and unnecessary everywhere else —
the link needs only the machine's Bluetooth address. The token machinery in
this codebase stays for older gateways and for Micra / Mini R machines whose
clouds still issue tokens.

## The two-service discovery (v7.4.2)

The gateway exposes one of two GATT services depending on its mode — the
entire token mystery resolved to a single nibble in the service UUID:

| | Operational (`d30a…`) | Connection/pairing (`d10a…`) |
|---|---|---|
| Entered by | normal boot (claimed by app/cloud) | paddle-left boot |
| Auth characteristic `0D0B` | present, reads `0x00` (locked) | **absent** |
| Token characteristic `0C0B` | **absent** | present, reads N/A |
| Shot counter `0E0B` | subscribable but **silent** (auth-gated) | **fully open** — complete event stream |
| Extra characteristics | — | `D6`–`D9`, `DC0A` (undocumented) |

The machine link tries both service UUIDs in order, so it works in either
mode. In connection mode, notifications flow without any token, bond, or
authentication handshake.

## Live link (implemented)

* `BleScaleService` hosts a second central client for the machine (all
  NimBLE work stays on its single manager task). It connects by the
  provisioned address — no scanning — subscribes the shot counter, drops the
  first (replayed) notification after each subscribe, and reconnects with
  exponential backoff (1 s → 60 s). It never initiates while the scale
  state machine is scanning or connecting; established connections coexist.
* Notifications parse on the BLE host task through `LmBrewingTracker`
  (single-writer) and publish a small snapshot under the service mutex.
* `BrewSignalMux` + `MachineLinkDeriver` (pure, host-tested) turn the
  snapshot into the recorder's `PumpSignalObservation`: machine-authoritative
  while fresh (20 s horizon covers idle telemetry gaps), vibration fallback
  otherwise, machine stop events backfilled through the recorder's existing
  `acceptedDecayOnsetMs` channel. The link follows the scale's radio
  lifecycle (wanted while the LIVE screen holds the foreground).

Status is visible on the device menu (Link: off/waiting/retrying/connected)
and in `GET /app/machine/status` (`link` object), alongside the firmware
version.
