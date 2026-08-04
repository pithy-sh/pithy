// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { describe, expect, test, vi } from "vitest";
import {
  type CfAccountTokenActorSource,
  type CfActorSource,
  type CfUserActorSource,
  createCachedActorResolver,
  resolveActor,
} from "./resolveActor";

/** Overrides for {@link fakeSource}, per scope — so a test replaces one call without restating the rest. */
interface SourceOverrides {
  user?: Partial<CfUserActorSource>;
  accountTokens?: Partial<CfAccountTokenActorSource>;
}

/**
 * A fake CF actor source, one spy per call so a test can assert **which scope** was read, not only
 * what came back. The scope split is the whole point of the seam: a `cfat_*` token is invalid at
 * every `/user/*` endpoint, so these fakes model the two scopes as separately observable.
 */
function fakeSource(overrides: SourceOverrides = {}): CfActorSource {
  return {
    user: {
      getUser: vi.fn(async () => ({ id: "cf-user-1", email: "dev@example.com" })),
      ...overrides.user,
    },
    accountTokens: {
      verifyToken: vi.fn(async () => ({ id: "tok-1", status: "active" })),
      getTokenName: vi.fn(async () => "ci-deployer" as string | null),
      ...overrides.accountTokens,
    },
  };
}

/**
 * A source whose **user-scoped** calls fail the way Cloudflare really fails them for an account-owned
 * token: `GET /user/tokens/verify` answers `1000 — Invalid API Token`, `GET /user/tokens/:id` answers
 * `9109`. The account-scoped calls succeed, as they do live. This is the fake the old seam could not
 * express — it handed the resolver only the user manager, so `cfat_` resolution threw here and
 * degraded to `system` in production while a friendlier fake kept the test green.
 */
function realisticSource(): CfActorSource {
  return fakeSource({
    user: {
      getUser: vi.fn(async (): Promise<{ id?: string; email?: string }> => {
        throw new Error("Invalid API Token");
      }),
    },
  });
}

describe("resolveActor", () => {
  test("cfut_ (user token) resolves to the user email with the CF user id in metadata", async () => {
    const actor = await resolveActor("cfut_abc123", fakeSource());
    expect(actor.actorType).toBe("user");
    expect(actor.actorId).toBe("dev@example.com");
    expect(actor.metadata).toMatchObject({ cfTokenType: "user", cfUserId: "cf-user-1" });
  });

  test("cfut_ falls back to the user id when no email is returned", async () => {
    const actor = await resolveActor("cfut_abc", fakeSource({ user: { getUser: async () => ({ id: "cf-user-2" }) } }));
    expect(actor.actorId).toBe("cf-user-2");
  });

  test("cfat_ (account token) resolves to the token name as a service actor", async () => {
    const actor = await resolveActor("cfat_xyz789", fakeSource());
    expect(actor.actorType).toBe("service");
    expect(actor.actorId).toBe("ci-deployer");
    expect(actor.metadata).toMatchObject({ cfTokenType: "account", cfTokenId: "tok-1", cfTokenStatus: "active" });
  });

  test("cfat_ reads the account scope only — never a /user/* endpoint", async () => {
    const source = realisticSource();
    const actor = await resolveActor("cfat_xyz789", source);

    // The regression: with the user manager behind these calls, both throw `Invalid API Token` and the
    // whole branch degrades to `system`. Pinning the scope is what makes the endpoint the assertion.
    expect(actor.actorType).toBe("service");
    expect(actor.actorId).toBe("ci-deployer");
    expect(source.accountTokens.verifyToken).toHaveBeenCalledTimes(1);
    expect(source.accountTokens.getTokenName).toHaveBeenCalledWith("tok-1");
    expect(source.user.getUser).not.toHaveBeenCalled();
  });

  test("cfut_ reads the user scope only — never an account endpoint", async () => {
    const source = fakeSource();
    await resolveActor("cfut_abc123", source);
    expect(source.user.getUser).toHaveBeenCalledTimes(1);
    expect(source.accountTokens.verifyToken).not.toHaveBeenCalled();
    expect(source.accountTokens.getTokenName).not.toHaveBeenCalled();
  });

  test("cfat_ falls back to the token id when the name is declined, with nothing to report", async () => {
    // The normal answer for a least-privilege CI token: reading its own record needs `API Tokens Read`,
    // which `pithy token mint` deliberately withholds. Attribution lands on the token, not on `system`,
    // and nothing went wrong — so the record carries no error.
    const actor = await resolveActor("cfat_xyz", fakeSource({ accountTokens: { getTokenName: async () => null } }));
    expect(actor.actorType).toBe("service");
    expect(actor.actorId).toBe("tok-1");
    expect(actor.metadata.cfTokenNameError).toBeUndefined();
  });

  test("an unrecognized token prefix yields a system actor with a note", async () => {
    const actor = await resolveActor("whoami_123", fakeSource());
    expect(actor.actorType).toBe("system");
    expect(actor.actorId).toBeNull();
    expect(actor.metadata.actorResolutionFailed).toBe(true);
  });

  test("a resolution failure is non-fatal: a system actor with the failure note", async () => {
    const actor = await resolveActor(
      "cfut_abc",
      fakeSource({
        user: {
          getUser: async () => {
            throw new Error("network down");
          },
        },
      }),
    );
    expect(actor.actorType).toBe("system");
    expect(actor.metadata.actorResolutionFailed).toBe(true);
    expect(String(actor.metadata.note)).toMatch(/network down/);
  });

  test("an account verify failure degrades to system rather than throwing", async () => {
    const actor = await resolveActor(
      "cfat_abc",
      fakeSource({
        accountTokens: {
          verifyToken: async () => {
            throw new Error("account verify unreachable");
          },
        },
      }),
    );
    expect(actor.actorType).toBe("system");
    expect(actor.actorId).toBeNull();
    expect(String(actor.metadata.note)).toMatch(/account verify unreachable/);
  });

  test("an account name-read throw still attributes to the token, falling back to its id", async () => {
    // Verify already named the credential. A 429, a blip, or a denial the source did not classify must
    // not take that back — collapsing a known token to `system` is the very bug this change removes.
    const actor = await resolveActor(
      "cfat_abc",
      fakeSource({
        accountTokens: {
          getTokenName: async () => {
            throw new Error("name read exploded");
          },
        },
      }),
    );
    expect(actor.actorType).toBe("service");
    expect(actor.actorId).toBe("tok-1");
    expect(actor.metadata.actorResolutionFailed).toBeUndefined();
    // Kept, not swallowed: the id-instead-of-name is explained rather than left to look like the
    // ordinary least-privilege case.
    expect(String(actor.metadata.cfTokenNameError)).toMatch(/name read exploded/);
  });

  test("never reads the token value — only its prefix decides the path", async () => {
    const source = fakeSource();
    await resolveActor("cfat_super_secret_value", source);
    // The secret body is never passed to any source call; only the prefix routed it to the account scope.
    expect(source.accountTokens.verifyToken).toHaveBeenCalledWith();
    expect(source.user.getUser).not.toHaveBeenCalled();
  });
});

describe("createCachedActorResolver", () => {
  test("resolves once and caches for the session", async () => {
    const source = fakeSource();
    const resolver = createCachedActorResolver("cfut_abc", source);

    const [a, b] = await Promise.all([resolver(), resolver()]);
    expect(a).toBe(b);
    expect(await resolver()).toBe(a);
    expect(source.user.getUser).toHaveBeenCalledTimes(1);
  });
});
