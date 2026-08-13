// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { DevSecretValue } from "@pithy-sh/core/src/capability/devSecret";

/** Bytes of entropy behind a minted value — 256 bits, the same budget as the master key. */
const RANDOM_BYTES = 32;

/**
 * A fresh random string: 32 bytes of CSPRNG entropy, base64url and unpadded.
 *
 * **`crypto.getRandomValues`, and it must stay that way.** This is the only source of key material the
 * kit generates — for local dev and for a deployed environment alike — so a substitution here that is
 * not cryptographically secure would silently weaken every session signature, every signed link, and
 * every key-encryption key the tool creates. There is no fallback path and there must not be one: on
 * Workers, Node 22 and Bun, `crypto` is global and this always resolves.
 *
 * base64url rather than base64 so the value survives every place a minted value is carried by hand — a
 * `.dev.vars` line, a shell export, a URL — without quoting or an `=` that reads as a second separator.
 */
function randomValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mint a value for a secret whose registry entry declares one may be minted.
 *
 * **For every environment, including production.** This was documented as local-dev-only, and named for
 * it, through four releases in which that was true. #321 made it the sole producer of key material
 * written into a real account's Secrets Store and into a deployed environment's secrets D1 — by
 * `pithy provision --env staging`, `--env prod`, `pithy secrets provision` and `pithy feature` — and
 * left the contract saying the opposite. A security requirement documented as applying to dev, on the
 * function that generates production keys, is a requirement nobody is checking. So the name and the
 * sentence now say what the function is for; see `randomValue` for the property that must hold.
 *
 * The declaration is what limits it, not the environment. An entry carries a mintable value only when
 * the value is *arbitrary* — a session signing key, a link signing key — and that is a fact about the
 * value rather than about where it runs: nothing outside the project validates one, in prod for exactly
 * the reason it does not on a laptop. A secret that must match something already issued carries no
 * declaration and nothing here invents one. See {@link isMintableSecret}.
 *
 * The switch is exhaustive on purpose. A second {@link DevSecretValue} kind that this cannot produce
 * fails the build here, rather than silently writing a random string where something else was meant.
 */
export function mintSecretValue(kind: DevSecretValue): string {
  switch (kind) {
    case "random":
      return randomValue();
  }
}
