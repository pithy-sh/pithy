// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ActingResponse, OrganizationsResponse } from "../http/responses";
import {
  chooseOrganization,
  listOrganizations,
  ORGANIZATION_BASE_PATH,
  ORGANIZATION_CROSS_ORIGIN,
  ORGANIZATION_UNREACHABLE,
  ORGANIZATION_UNREADABLE,
  type OrganizationFetch,
  type OrganizationResponse,
} from "./api";

/** A fetch that answers once, and records what it was asked. */
function answering(body: unknown, ok = true, status = ok ? 200 : 400) {
  const calls: { url: string; init?: { method?: string; body?: string; credentials?: string } }[] = [];
  const send: OrganizationFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => body } satisfies OrganizationResponse;
  };
  return { send, calls };
}

/** The chooser's answer, as the server's own schema says it is shaped. */
const LIST = OrganizationsResponse.parse({
  organizations: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Acme Games",
      slug: "acme",
      mark: "/organizations/marks/organization/11111111-1111-4111-8111-111111111111?v=1",
      role: "admin",
      createdAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  acting: null,
  chosen: false,
});

const CHOSEN = ActingResponse.parse({
  organizationId: "11111111-1111-4111-8111-111111111111",
  name: "Acme Games",
  slug: "acme",
  role: "admin",
  chosen: true,
});

describe("the client reads what the server actually answers", () => {
  /*
    **Both fixtures are parsed through the server's own response schemas**, so a field renamed on the
    wire fails here rather than in an adopter's browser. That is the whole reason this test imports from
    `../http/responses` while the module under test imports nothing at all: the *module* must stay free
    of the Worker's schema graph, because it compiles into a bundle; the *test* has no such constraint,
    and it is the only place the two halves can be held together.

    The pairing that made this necessary: the wire says `mark` and `acting`, and a client written from
    the prose would have said `logo` and `activeOrganizationId`. Both would have type-checked, both would
    have failed their guard at runtime, and the screen would have rendered "we couldn't read that".
  */

  test("the list comes back narrowed", async () => {
    const { send, calls } = answering(LIST);
    const result = await listOrganizations({ fetch: send });
    expect(result.ok && result.value.organizations[0]?.name).toBe("Acme Games");
    expect(result.ok && result.value.acting).toBeNull();
    expect(result.ok && result.value.chosen).toBe(false);
    expect(calls[0]?.url).toBe(ORGANIZATION_BASE_PATH);
    // The whole cookie story, asserted rather than assumed.
    expect(calls[0]?.init?.credentials).toBe("include");
  });

  test("a choice reads back from the row the write proved, not from the request", async () => {
    const { send, calls } = answering(CHOSEN);
    const result = await chooseOrganization("11111111-1111-4111-8111-111111111111", { fetch: send });
    // The role in particular: echoing the request would let a header show a standing nobody has.
    expect(result.ok && result.value.role).toBe("admin");
    expect(result.ok && result.value.chosen).toBe(true);
    expect(calls[0]?.url).toBe(`${ORGANIZATION_BASE_PATH}/acting`);
    expect(calls[0]?.init?.method).toBe("POST");
  });
});

describe("nothing throws, and every failure is renderable", () => {
  test("a refusal arrives as the server's own code and message", async () => {
    const { send } = answering(
      { error: { code: "organization/not_found", message: "That organization does not exist.", action: null } },
      false,
      404,
    );
    const result = await chooseOrganization("22222222-2222-4222-8222-222222222222", { fetch: send });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.code).toBe("organization/not_found");
  });

  test("and a client cannot tell a non-member's 404 from a missing account's, because the server cannot", async () => {
    // Not a limitation to work around. `detail` never crosses the codec, so the two are one answer here
    // exactly as they are on the wire — and a client that guessed which it was would be inventing the
    // distinction the model spent its design refusing to draw.
    const payload = {
      error: { code: "organization/not_found", message: "That organization does not exist.", action: null },
    };
    const absent = await chooseOrganization("a", { fetch: answering(payload, false, 404).send });
    const foreign = await chooseOrganization("b", { fetch: answering(payload, false, 404).send });
    expect(absent).toEqual(foreign);
  });

  test("an unreachable worker is a failure, not a rejection", async () => {
    const send: OrganizationFetch = async () => {
      throw new Error("offline");
    };
    await expect(listOrganizations({ fetch: send })).resolves.toEqual({ ok: false, failure: ORGANIZATION_UNREACHABLE });
  });

  test("a program with no fetch at all is the same failure", async () => {
    await expect(listOrganizations({ global: {} })).resolves.toEqual({
      ok: false,
      failure: ORGANIZATION_UNREACHABLE,
    });
  });

  test("a proxy's HTML page is unreadable rather than a crash", async () => {
    const send: OrganizationFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(listOrganizations({ fetch: send })).resolves.toEqual({ ok: false, failure: ORGANIZATION_UNREADABLE });
  });

  test("an answer of the wrong shape is unreadable rather than handed on", async () => {
    // The guard is the boundary. A row missing `role` is a row the chooser would draw wrong.
    const { send } = answering({ organizations: [{ id: "x", name: "y", slug: "z" }], acting: null, chosen: false });
    await expect(listOrganizations({ fetch: send })).resolves.toEqual({ ok: false, failure: ORGANIZATION_UNREADABLE });
  });
});

describe("the request never leaves this origin", () => {
  test.each([
    ["//evil.example.com", "a protocol-relative authority"],
    ["/\\evil.example.com", "the backslash form a URL parser reads as one"],
    ["https://evil.example.com/organizations", "an absolute URL"],
    ["organizations", "an unrooted path"],
  ])("%s is refused before anything is sent — %s", async (basePath) => {
    const { send, calls } = answering(LIST);
    const result = await listOrganizations({ basePath, fetch: send });
    expect(result).toEqual({ ok: false, failure: ORGANIZATION_CROSS_ORIGIN });
    // Never sent, rather than sent and ignored. The session is ambient; the request is the disclosure.
    expect(calls).toEqual([]);
  });
});

describe("the module compiles into a browser bundle", () => {
  test("and imports nothing, so the Worker's schema graph does not come with it", () => {
    // Structural rather than a habit, and the same rule `@pithy-sh/auth`'s client is held to. One
    // `import { Organization } from "../data/organization"` would drag Zod and every table schema into
    // an adopter's bundle — and it would type-check, which is why this is a test and not a review note.
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "api.ts"), "utf8");
    const imports = source.match(/^\s*import\s.+$/gm) ?? [];
    expect(imports).toEqual([]);
  });
});
