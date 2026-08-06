// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DevSecretValue } from "@pithy-sh/core/src/capability/devSecret";

/** Bytes of entropy behind a minted value — 256 bits, the same budget as the master key. */
const RANDOM_BYTES = 32;

/**
 * A fresh random string: 32 bytes of CSPRNG entropy, base64url and unpadded.
 *
 * base64url rather than base64 so the value survives every place a dev value is carried by hand — a
 * `.dev.vars` line, a shell export, a URL — without quoting or an `=` that reads as a second separator.
 */
function randomValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a **local dev** value for a secret whose registry entry declares one may be minted.
 *
 * Never for a deployed environment: those values are written through `pithy secrets create`, into the
 * environment's encrypted store, and are the adopter's to keep. This exists so `pithy add` can leave a
 * project that runs — the alternative is an app that boots healthy and fails at the first read, on a
 * secret the adopter has never heard of.
 *
 * The switch is exhaustive on purpose. A second {@link DevSecretValue} kind that this cannot produce
 * fails the build here, rather than silently writing a random string where something else was meant.
 */
export function mintDevValue(kind: DevSecretValue): string {
  switch (kind) {
    case "random":
      return randomValue();
  }
}
