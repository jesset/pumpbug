#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 ludable
# SPDX-License-Identifier: AGPL-3.0-only

"""Fetch the La Marzocco Bluetooth token for Pump Bug provisioning.

Runs the same cloud handshake as the Pump Bug device / Home Assistant, but
from this computer — for when the device's Wi-Fi link is too unreliable for
the one-time provisioning.

Usage:
    python3 scripts/fetch_lm_token.py <username> <password>

Prints the machine's serial and bleAuthToken; paste both into the Pump Bug
web interface (La Marzocco -> Enter a token manually). Credentials are used
only for this run and never stored or printed.
"""

import asyncio
import sys
import uuid

from pylamarzocco import LaMarzoccoCloudClient
from pylamarzocco.util import generate_installation_key


async def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    username, password = sys.argv[1], sys.argv[2]

    installation_key = generate_installation_key(str(uuid.uuid4()).lower())
    client = LaMarzoccoCloudClient(
        username=username,
        password=password,
        installation_key=installation_key,
    )

    await client.async_register_client()
    things = await client.list_things()
    machines = [t for t in things if t.type.value == "CoffeeMachine"]
    if not machines:
        print("No coffee machine found on this account.")
        return 1

    for thing in machines:
        settings = await client.get_thing_settings(thing.serial_number)
        token = settings.ble_auth_token
        print(f"serial:  {thing.serial_number}")
        print(f"model:   {thing.model_name}")
        print(f"token:   {token if token else '(null — see notes in docs/lamarzocco.md)'}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
