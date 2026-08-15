// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError, PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  NO_SOCIAL_PROVIDERS,
  PROVIDER_DISABLED,
  providerUnavailable,
  type ResolvedProviders,
  resolveProvider,
  SOCIAL_PROVIDER_IDS,
  unavailableProviderFor,
} from "./providers";

const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

/** The providers a case describes, over an all-disabled base. */
function providers(slice: Partial<ResolvedProviders>): ResolvedProviders {
  return { ...NO_SOCIAL_PROVIDERS, ...slice };
}

describe("resolveProvider — three states, on the value", () => {
  test("a disabled provider never calls its reader", async () => {
    let called = false;
    const state = await resolveProvider(false, async () => {
      called = true;
      return CREDENTIALS;
    });
    expect(state).toEqual(PROVIDER_DISABLED);
    expect(called).toBe(false);
  });

  test("an enabled provider that reads is `ready`, with its credentials behind the state", async () => {
    const state = await resolveProvider(true, async () => CREDENTIALS);
    expect(state.state).toBe("ready");
    // The narrowing is the point: `credentials` is unreachable until `state` has been established.
    expect(state.state === "ready" ? state.credentials : undefined).toEqual(CREDENTIALS);
  });

  test("a rejected read is `unresolvable`, not a rejection", async () => {
    const state = await resolveProvider(true, async () => {
      throw new InternalError({ message: "no row", detail: "auth-github-credentials has no row" });
    });
    expect(state).toEqual({ state: "unresolvable" });
  });

  /**
   * The #371 plant, kept as a permanent case rather than as a memory.
   *
   * `resolveProvider` calls `read()` **inside** the `try`. Written as `read().catch(...)` it would guard
   * a rejected promise and nothing else, and a seam that throws before it ever returns one — a registry
   * lookup, a binding read, an accessor built from an env that is not there — would walk straight
   * through the guard and out of the `Promise.all` that #381 exists to keep intact. That is exactly how
   * the first guards written for `#371` failed, so the shape is asserted rather than assumed.
   */
  test("a reader that throws synchronously — before any promise exists — is caught too", async () => {
    const state = await resolveProvider(true, (): Promise<typeof CREDENTIALS> => {
      throw new InternalError({ message: "thrown before a promise existed", detail: "synchronous plant" });
    });
    expect(state).toEqual({ state: "unresolvable" });
  });

  test("nothing from the caught failure survives — the state carries no fields at all", async () => {
    const state = await resolveProvider(true, async () => {
      throw new InternalError({
        message: "Secret 'auth-github-credentials' is declared but not provisioned.",
        detail: "d1 secret 'auth-github-credentials' has no row in the secrets store",
      });
    });
    // Serialized, because a field carrying the throw could hide behind a structural comparison.
    expect(JSON.stringify(state)).toBe('{"state":"unresolvable"}');
  });
});

describe("unavailableProviderFor — which request gets the refusal", () => {
  const broken = providers({
    google: { state: "ready", credentials: CREDENTIALS },
    github: { state: "unresolvable" },
  });

  test("a social sign-in naming the unreadable provider", () => {
    expect(unavailableProviderFor("/sign-in/social", { provider: "github" }, broken)).toBe("github");
  });

  test("a link-social naming it too — the same credential serves both", () => {
    expect(unavailableProviderFor("/link-social", { provider: "github" }, broken)).toBe("github");
  });

  test("a healthy provider is Better Auth's to serve", () => {
    expect(unavailableProviderFor("/sign-in/social", { provider: "google" }, broken)).toBeUndefined();
  });

  /**
   * The distinction the whole fix turns on, asserted from the outside: a provider nobody enabled is
   * **not** this refusal's business. Better Auth answers it with `PROVIDER_NOT_FOUND`, which is true —
   * and if this function answered it too, a fault and a choice would be one event again.
   */
  test("a merely disabled provider is left to Better Auth's own 404", () => {
    expect(unavailableProviderFor("/sign-in/social", { provider: "facebook" }, broken)).toBeUndefined();
  });

  test("a provider id the kit does not compose is left alone", () => {
    expect(unavailableProviderFor("/sign-in/social", { provider: "discord" }, broken)).toBeUndefined();
  });

  test("every other endpoint is untouched — magic link above all", () => {
    for (const path of ["/sign-in/magic-link", "/email-otp/send-verification-otp", "/token", "/sign-out"]) {
      expect(unavailableProviderFor(path, { provider: "github" }, broken)).toBeUndefined();
    }
  });

  test("a body with no readable provider is not a refusal", () => {
    for (const body of [undefined, null, {}, { provider: "" }, { provider: 7 }, "github"]) {
      expect(unavailableProviderFor("/sign-in/social", body, broken)).toBeUndefined();
    }
  });
});

describe("providerUnavailable — three audiences, three fields", () => {
  const error = providerUnavailable("github");

  test("it is a PithyError carrying the kit's own 503 code", () => {
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.code).toBe("auth/provider_unavailable");
    expect(error.payload.status).toBe(503);
  });

  test("the caller's message names the provider and a method that works", () => {
    expect(error.payload.message).toContain("github");
    expect(error.payload.message).toContain("magic link");
  });

  test("the operator's action names the secret and the way to turn the provider off", () => {
    expect(error.payload.action).toContain("auth-github-credentials");
    expect(error.payload.action).toContain("pithy.config.ts");
  });

  test("every provider the kit composes produces one", () => {
    for (const id of SOCIAL_PROVIDER_IDS) {
      expect(providerUnavailable(id).payload.message).toContain(id);
    }
  });
});
