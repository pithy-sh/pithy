// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { defineSecretRegistry, type SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { AuditSinks } from "./sinks";

/**
 * **Each sink's token, declared where every secret is (#824).**
 *
 * A sink names the `@pithy-sh/secrets` name its token lives under, and this declares it: a per-environment `d1`
 * secret, `text`, obtained from the receiver's own console and replaced there by hand. Declared on audit's
 * `secretRegistry`, so `pithy secrets create` knows the name, `pithy doctor` can say whether it is set, and the
 * consumer reads it through the one `secretsStore` reader like every other secret. Two sinks may share one token by
 * naming the same secret; it is declared once.
 *
 * Nothing here is a Cloudflare API token, so nothing joins the application's runtime token.
 */

/** Where an operator is told to look for the token, whichever receiver issues it. */
const SINK_TOKEN_DOCUMENTATION =
  "https://github.com/pithy-sh/pithy/blob/main/packages/audit/README.md#shipping-the-trail";

/** The registry slice for every sink's token. Empty when no sink is declared. */
export function sinkSecretsRegistry(sinks: AuditSinks): SecretRegistry {
  const names = [...new Set(Object.values(sinks).map((sink) => sink.secret))];
  return defineSecretRegistry(
    Object.fromEntries(
      names.map((name) => [
        name,
        {
          backend: "d1",
          scope: "environment",
          rotatable: false,
          valueType: "text",
          origin: { kind: "obtained", issuer: "other", documentation: SINK_TOKEN_DOCUMENTATION },
          rotation: { kind: "manual", issuer: "other", documentation: SINK_TOKEN_DOCUMENTATION },
          notes: "An audit sink's token: the Splunk HEC token, the Datadog API key, or the webhook's bearer token.",
        } as const,
      ]),
    ),
  );
}
