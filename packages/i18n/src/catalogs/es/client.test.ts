// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { AUTH_CROSS_ORIGIN, AUTH_UNREACHABLE, AUTH_UNREADABLE, type AuthFailure } from "@pithy-sh/auth/src/client/api";
import { MessageKey } from "@pithy-sh/core/src/i18n/catalog";
import {
  PAYMENTS_NO_BROWSER,
  PAYMENTS_UNREACHABLE,
  PAYMENTS_UNREADABLE,
  type PaymentsFailure,
} from "@pithy-sh/payments/src/client/api";
import { describe, expect, test } from "vitest";
import { esScreens } from "./screens";

/**
 * **Every failure a client mints for itself is translated too.**
 *
 * `client/*` is the one domain with no capability behind it, so nothing else in this repository can see
 * it. `catalogCoverage.test.ts` derives its English side from the templates' baked blocks, from each
 * capability's `messages`, and from `KitErrorPayload.options` — and a client-minted sentinel is in none
 * of those three: it never crosses the wire, so it is not in the taxonomy, and it is declared as a
 * `const` in an SDK rather than contributed by a capability.
 *
 * That gap mattered more than its size suggests. **Offline is the single commonest failure a screen
 * renders**, so a Spanish page answering an offline phone in English is the first thing anybody would
 * notice — and the two gates #441 added were both structurally unable to see it. This file is the one
 * that can, because it reads the sentinels themselves.
 *
 * The English side is the exported constants, never a list here. A fourth sentinel added to either SDK
 * is a red build until somebody writes its Spanish, which is the whole property.
 */

/** Every sentinel the kit's two browser SDKs mint, as `{ code, message }`. Both shapes carry both. */
const SENTINELS: readonly (AuthFailure | PaymentsFailure)[] = [
  AUTH_UNREACHABLE,
  AUTH_UNREADABLE,
  AUTH_CROSS_ORIGIN,
  PAYMENTS_UNREACHABLE,
  PAYMENTS_UNREADABLE,
  PAYMENTS_NO_BROWSER,
];

describe("the client-minted failures speak the reader's language", () => {
  test("the sweep is reading the SDKs, not an empty list", () => {
    // Six today: three from auth, three from payments. Two codes are shared between them, so the key
    // set is four — which is itself the fact the catalog's comment argues about.
    expect(SENTINELS).toHaveLength(6);
    expect(new Set(SENTINELS.map((failure) => failure.code)).size).toBe(4);
  });

  test("every sentinel code has a Spanish entry", () => {
    const missing = SENTINELS.map((failure) => failure.code).filter((code) => !(code in esScreens));
    expect(missing, `these render English on a Spanish page:\n${missing.join("\n")}`).toEqual([]);
  });

  test("every sentinel code is a key a catalog can hold", () => {
    // `client` is a domain no capability owns, so nothing else ever checks that these parse. A code the
    // grammar refuses is a code an adopter could never override.
    for (const failure of SENTINELS) {
      expect(MessageKey.safeParse(failure.code).success, failure.code).toBe(true);
    }
  });

  test("no Spanish sentinel is still its English", () => {
    for (const failure of SENTINELS) {
      const spanish = esScreens[failure.code];
      expect(spanish, failure.code).toBeDefined();
      expect(spanish, failure.code).not.toBe(failure.message);
    }
  });

  test("the two SDKs really do collide on two codes, which is why one string serves both", () => {
    // Pinned rather than assumed: if either SDK renames its sentinel, the catalog comment explaining
    // why the Spanish names no noun stops being true, and this says so.
    expect(AUTH_UNREACHABLE.code).toBe(PAYMENTS_UNREACHABLE.code);
    expect(AUTH_UNREADABLE.code).toBe(PAYMENTS_UNREADABLE.code);
    expect(AUTH_UNREACHABLE.message).not.toBe(PAYMENTS_UNREACHABLE.message);
  });
});
