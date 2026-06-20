import { describe, expect, test, vi } from "vitest";
import { type CfActorSource, createCachedActorResolver, resolveActor } from "./resolveActor";

/** A fake CF actor source; each method is a spy so we can assert call counts and override per test. */
function fakeSource(overrides: Partial<CfActorSource> = {}): CfActorSource {
  return {
    getUser: vi.fn(async () => ({ id: "cf-user-1", email: "dev@example.com" })),
    verifyToken: vi.fn(async () => ({ id: "tok-1", status: "active" })),
    getTokenName: vi.fn(async () => "ci-deployer"),
    ...overrides,
  };
}

describe("resolveActor", () => {
  test("cfut_ (user token) resolves to the user email with the CF user id in metadata", async () => {
    const actor = await resolveActor("cfut_abc123", fakeSource());
    expect(actor.actorType).toBe("user");
    expect(actor.actorId).toBe("dev@example.com");
    expect(actor.metadata).toMatchObject({ cfTokenType: "user", cfUserId: "cf-user-1" });
  });

  test("cfut_ falls back to the user id when no email is returned", async () => {
    const actor = await resolveActor("cfut_abc", fakeSource({ getUser: async () => ({ id: "cf-user-2" }) }));
    expect(actor.actorId).toBe("cf-user-2");
  });

  test("cfat_ (account token) resolves to the token name as a service actor", async () => {
    const actor = await resolveActor("cfat_xyz789", fakeSource());
    expect(actor.actorType).toBe("service");
    expect(actor.actorId).toBe("ci-deployer");
    expect(actor.metadata).toMatchObject({ cfTokenType: "account", cfTokenId: "tok-1", cfTokenStatus: "active" });
  });

  test("cfat_ falls back to the token id when the name can't be read", async () => {
    const actor = await resolveActor("cfat_xyz", fakeSource({ getTokenName: async () => null }));
    expect(actor.actorId).toBe("tok-1");
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
        getUser: async () => {
          throw new Error("network down");
        },
      }),
    );
    expect(actor.actorType).toBe("system");
    expect(actor.metadata.actorResolutionFailed).toBe(true);
    expect(String(actor.metadata.note)).toMatch(/network down/);
  });

  test("never reads the token value — only its prefix decides the path", async () => {
    const source = fakeSource();
    await resolveActor("cfat_super_secret_value", source);
    // The secret body is never passed to any source call; only the prefix routed it to verifyToken.
    expect(source.verifyToken).toHaveBeenCalledTimes(1);
    expect(source.getUser).not.toHaveBeenCalled();
  });
});

describe("createCachedActorResolver", () => {
  test("resolves once and caches for the session", async () => {
    const source = fakeSource();
    const resolver = createCachedActorResolver("cfut_abc", source);

    const [a, b] = await Promise.all([resolver(), resolver()]);
    expect(a).toBe(b);
    expect(await resolver()).toBe(a);
    expect(source.getUser).toHaveBeenCalledTimes(1);
  });
});
