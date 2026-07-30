// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { z } from "zod";
import type { TurnstileMode } from "../config/config";
import { TurnstileConfigError } from "../error/errors";

/**
 * One widget's secret. `key` is the value siteverify checks a token against; `lastRotatedAt` is
 * informational and exists so a future rotation can track and overlap secrets without a reshape (the
 * issue keeps rotation out of scope, but the storage must not preclude it).
 */
export const TurnstileSecretEntry = z
  .object({
    key: z.string().min(1).describe("The widget's secret key, used server-side at Cloudflare siteverify."),
    lastRotatedAt: z
      .string()
      .optional()
      .describe("ISO-8601 timestamp of the last rotation, if any. Informational; enables future rotation."),
  })
  .describe("One widget's secret key plus optional rotation metadata.");
export type TurnstileSecretEntry = z.infer<typeof TurnstileSecretEntry>;

/**
 * The decrypted value of the turnstile secret: each configured widget's secret, keyed by mode. One
 * secret serves one *or* both widgets, so adding the second never reshapes storage. The `secretsStore`
 * reader parses and validates this against the registry entry's `valueType: "json"` schema; the
 * middleware then selects the entry for the route's mode via {@link selectTurnstileSecret}.
 */
export const TurnstileSecrets = z
  .strictObject({
    visible: TurnstileSecretEntry.optional().describe("The visible (managed) widget's secret, if that widget is used."),
    invisible: TurnstileSecretEntry.optional().describe("The invisible widget's secret, if that widget is used."),
  })
  .describe("The turnstile secret value: each configured widget's secret, keyed by mode.");
export type TurnstileSecrets = z.infer<typeof TurnstileSecrets>;

/**
 * The registry name (D1 row key) the turnstile secret is stored under. The secret is a `d1`-backed,
 * per-environment, JSON value — read through the one `secretsStore` reader like every other secret
 * (CLAUDE.md §secrets), never off a raw binding.
 */
export const TURNSTILE_SECRET_NAME = "turnstile-secret-keys";

/** The minimal registry the turnstile middleware reads its secret through (mirrors email's signing-key registry). */
export const turnstileSecretsRegistry = defineSecretRegistry({
  [TURNSTILE_SECRET_NAME]: {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "json",
    schema: TurnstileSecrets,
  },
});

/**
 * Select the secret key for the route's widget from the resolved secrets object. With one widget
 * configured the only entry is used; with both, `mode` chooses. A missing/ambiguous selection is a
 * `turnstile/config` — the gate is misconfigured, never silently open.
 */
export function selectTurnstileSecret(secrets: TurnstileSecrets, mode?: TurnstileMode): string {
  const present = (Object.keys(secrets) as TurnstileMode[]).filter((m) => secrets[m]);
  if (present.length === 0) {
    throw new TurnstileConfigError({ detail: "The turnstile secret holds no widget secrets." });
  }
  if (!mode && present.length > 1) {
    throw new TurnstileConfigError({
      detail: "Two widgets are configured; pass turnstile({ mode }) to select which one this route gates.",
      action: 'Set mode to "visible" or "invisible" on the turnstile() middleware for this route.',
    });
  }
  const chosen = mode ?? present[0];
  const entry = chosen ? secrets[chosen] : undefined;
  if (!entry) {
    throw new TurnstileConfigError({ detail: `The turnstile secret has no "${chosen}" widget entry.` });
  }
  return entry.key;
}
