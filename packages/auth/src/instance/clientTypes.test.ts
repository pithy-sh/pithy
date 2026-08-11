// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createAuthClient } from "better-auth/client";
import { emailOTPClient, inferAdditionalFields, magicLinkClient, organizationClient } from "better-auth/client/plugins";
import type { organization } from "better-auth/plugins/organization";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { AuthInstance } from "./auth";

/**
 * The client half of #271, and the reason it is a *typecheck* rather than an assertion.
 *
 * Better Auth derives a client's surface from its **client** plugin list, not from the server's — the
 * server type never crosses into a browser bundle. So the answer to "an adopter who adds `organization`
 * server-side gets no `authClient.organization`" is that they add `organizationClient()` beside it, and
 * the cast (`(authClient as any).organization.list()`) is then unnecessary rather than merely
 * discouraged. This file is what makes that claim checkable: `bun run typecheck` fails if any line
 * below needs a cast.
 *
 * The one thing that genuinely needs the *server's* type is `inferAdditionalFields`, which teaches the
 * client about extra user/session fields. That is why {@link AuthInstance} is parameterised in the
 * plugin tuple — an adopter names the instance their own composition produces and hands it over.
 */

/** What an adopter writes: the composition their `pithy.config.ts` declares, named as a type. */
type AdopterAuth = AuthInstance<[ReturnType<typeof organization>]>;

const authClient = createAuthClient({
  baseURL: "http://localhost:8787",
  basePath: "/auth",
  // The kit's own two sign-in plugins have client halves too, and an adopter composes them the same
  // way. Better Auth's client is built from this list alone — nothing about it is inherited from the
  // server, which is exactly why the server-side fix in #271 needed this line documented beside it.
  plugins: [magicLinkClient(), emailOTPClient(), organizationClient(), inferAdditionalFields<AdopterAuth>()],
});

/** Never called. It exists to be **compiled**: every line here would need a cast if #271 were unfixed. */
async function adopterCode() {
  const created = await authClient.organization.create({ name: "Acme", slug: "acme" });
  const listed = await authClient.organization.list();
  const sentLink = await authClient.signIn.magicLink({ email: "ada@example.com" });
  return { created, listed, sentLink };
}

describe("an added plugin's client surface", () => {
  test("`authClient.organization` exists, and nothing above it is `any`", () => {
    expect(typeof authClient.organization.create).toBe("function");
    expect(typeof authClient.organization.list).toBe("function");
    expectTypeOf(authClient.organization).not.toBeAny();
    expectTypeOf(adopterCode).returns.not.toBeAny();
  });

  test("the kit's own sign-in is on the same client, beside the added plugin", () => {
    expect(typeof authClient.signIn.magicLink).toBe("function");
    expect(typeof authClient.emailOtp.sendVerificationOtp).toBe("function");
  });
});
