// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { resolveWriteTargets } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import { PAYMENTS_RAILS } from "../data/rail";
import { PaymentsRailNotConfiguredError } from "../error/errors";
import {
  PAYMENTS_CREDENTIALS_PAGE,
  PAYMENTS_PROVIDER_SECRET,
  PAYMENTS_RAIL_CONSOLES,
  PaymentsProviderCredentials,
  paymentsSecretsRegistry,
  railCredentials,
} from "./registry";

const APPLE = {
  bundleId: "com.acme.app",
  keyId: "2X9R4HXF34",
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
  privateKey: "-----BEGIN PRIVATE KEY-----\nMIG…\n-----END PRIVATE KEY-----",
};
const STRIPE = { secretKey: "sk_test_51Abc", webhookSecret: "whsec_test_51Abc" };

describe("paymentsSecretsRegistry", () => {
  test("declares exactly one secret — every rail's credentials live in it", () => {
    // One entry is the design, not an accident: a per-rail secret would mean a storage change and a
    // provisioning step every time a rail is added.
    expect(Object.keys(paymentsSecretsRegistry)).toEqual([PAYMENTS_PROVIDER_SECRET]);
  });

  test("declares the axes the reader routes on", () => {
    const entry = paymentsSecretsRegistry[PAYMENTS_PROVIDER_SECRET];
    expect(entry).toMatchObject({
      // An encrypted D1 row — no wrangler template binds this bundle from the Cloudflare Secrets
      // Store, and the read seam routes strictly on this field.
      backend: "d1",
      scope: "environment",
      rotatable: true,
      valueType: "json",
    });
    // The schema is what the reader validates the decrypted value against, so a `json` entry without one
    // would resolve unvalidated credentials.
    expect(entry?.valueType === "json" && entry.schema).toBe(PaymentsProviderCredentials);
  });

  test("a write still targets exactly the requested environment", () => {
    // The backend correction (`cf-secrets-store` → `d1`) is a declaration fix, not a routing change:
    // `environment` scope means one target either way. It would only fan out if the scope changed too.
    const entry = paymentsSecretsRegistry[PAYMENTS_PROVIDER_SECRET];
    if (!entry) throw new Error("the registry entry must exist");
    expect(resolveWriteTargets(entry.backend, entry.scope, "staging", DEFAULT_ENVIRONMENTS)).toEqual(["staging"]);
    expect(resolveWriteTargets(entry.backend, entry.scope, "prod", DEFAULT_ENVIRONMENTS)).toEqual(["prod"]);
  });
});

/**
 * The page `documentation` names, read off disk from the URL itself — so a value edited to point
 * somewhere else fails here rather than passing against a path this test happened to hardcode.
 */
function documentationPage(url: string): { path: string; body: string; fragment: string } {
  const [base, fragment = ""] = url.split("#");
  const relative = base?.split("/blob/main/")[1];
  if (!relative) throw new Error(`${url} is not a path inside this repository`);
  const path = fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));
  return { path, body: readFileSync(path, "utf8"), fragment };
}

/** GitHub's heading-anchor slug: lowercased, punctuation dropped, spaces hyphenated. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]+/g, "")
    .replace(/ /g, "-");
}

describe("credential documentation", () => {
  test("every rail names a console, and no two rails share one", () => {
    // The rails come from `data/rail.ts`, the consoles from the registry. A sixth rail added there and
    // forgotten here fails on this line — which is the run before an operator is handed a link to
    // somebody else's console. Distinct hosts is the whole reason one URL cannot serve the entry.
    expect(Object.keys(PAYMENTS_RAIL_CONSOLES).sort()).toEqual([...PAYMENTS_RAILS].sort());
    const hosts = Object.values(PAYMENTS_RAIL_CONSOLES).map((url) => new URL(url).host);
    expect(new Set(hosts).size).toBe(PAYMENTS_RAILS.length);
  });

  test("the page `documentation` points at names every one of those consoles", () => {
    // #332, exactly: the entry claimed one page named all of them, and the page named none. An operator
    // holding a ninety-day-old credential clicked, read, and was back where they started.
    const { body, path } = documentationPage(PAYMENTS_CREDENTIALS_PAGE);
    for (const rail of PAYMENTS_RAILS) {
      expect(body, `${rail}'s console is missing from ${path}`).toContain(PAYMENTS_RAIL_CONSOLES[rail]);
    }
  });

  test("the link's fragment is a heading that page actually has", () => {
    // A fragment GitHub cannot resolve silently lands at the top of a long page, which is the same
    // wasted click by another route.
    const { body, fragment } = documentationPage(PAYMENTS_CREDENTIALS_PAGE);
    const headings = [...body.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1] ?? ""));
    expect(headings).toContain(fragment);
  });
});

describe("PaymentsProviderCredentials", () => {
  test("accepts one rail on its own", () => {
    expect(PaymentsProviderCredentials.parse({ apple: APPLE }).apple?.bundleId).toBe("com.acme.app");
  });

  test("accepts every rail at once", () => {
    const parsed = PaymentsProviderCredentials.parse({
      apple: APPLE,
      stripe: STRIPE,
      google: {
        packageName: "com.acme.app",
        serviceAccountEmail: "play@acme.iam.gserviceaccount.com",
        privateKey: "-----BEGIN PRIVATE KEY-----\nMIIE…\n-----END PRIVATE KEY-----",
        pubsubAudience: "https://api.acme.test/payments/webhooks/google",
      },
    });
    expect(Object.keys(parsed).sort()).toEqual(["apple", "google", "stripe"]);
  });

  test("accepts none — a project can compose payments before provisioning any rail", () => {
    expect(PaymentsProviderCredentials.parse({})).toEqual({});
  });

  test("refuses a partial rail credential", () => {
    // The case this guards: half of Stripe's pair provisioned, so the key works and every webhook signature
    // silently fails. Refusing at the read makes it a loud `secrets/invalid_value` instead.
    expect(() => PaymentsProviderCredentials.parse({ stripe: { secretKey: "sk_test_51Abc" } })).toThrow();
    expect(() => PaymentsProviderCredentials.parse({ apple: { bundleId: "com.acme.app" } })).toThrow();
    const { privateKey: _dropped, ...missingKey } = APPLE;
    expect(() => PaymentsProviderCredentials.parse({ apple: missingKey })).toThrow();
  });

  test("refuses an empty string where a credential is required", () => {
    expect(() => PaymentsProviderCredentials.parse({ stripe: { ...STRIPE, webhookSecret: "" } })).toThrow();
  });

  test("refuses an unknown rail, and an unknown field inside a rail", () => {
    // Strict on both levels: a typo'd rail name would otherwise provision credentials nothing ever reads,
    // and the operator would be left looking at a secret that exists and a rail that denies.
    expect(() => PaymentsProviderCredentials.parse({ amazon: { secretKey: "x" } })).toThrow();
    expect(() => PaymentsProviderCredentials.parse({ stripe: { ...STRIPE, publishableKey: "pk_test" } })).toThrow();
  });
});

describe("railCredentials", () => {
  test("returns the block for a provisioned rail", () => {
    const credentials = PaymentsProviderCredentials.parse({ apple: APPLE, stripe: STRIPE });
    expect(railCredentials(credentials, "apple").bundleId).toBe("com.acme.app");
    expect(railCredentials(credentials, "stripe").webhookSecret).toBe("whsec_test_51Abc");
  });

  test("a rail with no credentials is a 404, not a 500", async () => {
    const credentials = PaymentsProviderCredentials.parse({ apple: APPLE });
    expect(() => railCredentials(credentials, "google")).toThrow(PaymentsRailNotConfiguredError);
    try {
      railCredentials(credentials, "google");
    } catch (error) {
      const thrown = error as PaymentsRailNotConfiguredError;
      expect(thrown.payload.status).toBe(404);
      // The operator is told which of config and provisioning is missing; the client is told neither.
      expect(thrown.payload.detail).toContain(PAYMENTS_PROVIDER_SECRET);
      expect(thrown.payload.message).not.toContain(PAYMENTS_PROVIDER_SECRET);
    }
  });

  test("the refusal names the console the missing rail's credentials come from", () => {
    // `action` is the operator's copy of the answer, and it needs no network and no rendered anchor.
    // The rail is known here, so the one console out of five that applies is known too.
    expect.assertions(2);
    const credentials = PaymentsProviderCredentials.parse({ apple: APPLE });
    try {
      railCredentials(credentials, "paddle");
    } catch (error) {
      const { action } = (error as PaymentsRailNotConfiguredError).payload;
      expect(action).toContain(PAYMENTS_RAIL_CONSOLES.paddle);
      expect(action).not.toContain(PAYMENTS_RAIL_CONSOLES.stripe);
    }
  });

  test("never puts a credential value in the refusal", async () => {
    const credentials = PaymentsProviderCredentials.parse({ stripe: STRIPE });
    try {
      railCredentials(credentials, "apple");
    } catch (error) {
      const rendered = JSON.stringify((error as PaymentsRailNotConfiguredError).payload);
      expect(rendered).not.toContain(STRIPE.secretKey);
      expect(rendered).not.toContain(STRIPE.webhookSecret);
    }
  });
});
