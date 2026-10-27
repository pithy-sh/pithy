// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { type Capability, defineCapability } from "./capability";
import {
  credentialFields,
  exportRows,
  isRetained,
  type PurgeContribution,
  PurgeSubject,
  purgeBinding,
  purgeExports,
  purgeSteps,
} from "./purge";

/** A contribution that records the subject it was asked to erase, so a test can see it ran. */
function recording(seen: string[], summary = "Erases this capability's rows for one user."): PurgeContribution {
  return {
    subject: "user",
    summary,
    erase: async ({ subject }) => {
      seen.push(subject.id);
    },
  };
}

describe("the purge contribution on the Capability contract", () => {
  test("defineCapability accepts one, and hands it back unchanged", () => {
    const seen: string[] = [];
    const contribution = recording(seen);
    const capability = defineCapability({ name: "media", requiredBindings: [], purge: [contribution] });
    expect(capability.purge).toEqual([contribution]);
  });

  test("a capability that erases nothing declares nothing, which is the ordinary case", () => {
    expect(defineCapability({ name: "turnstile", requiredBindings: [] }).purge).toBeUndefined();
  });

  test("one declared for a subject the kit does not know is refused at define time, naming it", () => {
    // A typo'd subject would otherwise be a contribution no purge ever asks for — rows nobody erases,
    // with a declaration in the source saying they are.
    const unknown = { ...recording([]), subject: "users" } as unknown as PurgeContribution;
    expect(() => defineCapability({ name: "media", requiredBindings: [], purge: [unknown] })).toThrow(PithyError);
    expect(() => defineCapability({ name: "media", requiredBindings: [], purge: [unknown] })).toThrow(/"users"/);
  });

  test("two for the same subject from one capability are refused — one capability is one step", () => {
    // The Workflow runs a step per capability so a failure retries one capability alone. Two
    // contributions for one subject would have to share that step, and a retry would re-run both.
    expect(() =>
      defineCapability({ name: "media", requiredBindings: [], purge: [recording([]), recording([])] }),
    ).toThrow(/media.*user/);
  });

  test("a contribution with no summary is refused, because the summary is what the step records", () => {
    expect(() => defineCapability({ name: "media", requiredBindings: [], purge: [recording([], "")] })).toThrow(
      PithyError,
    );
  });

  test("an export that is not a function is refused, because the export route would call it (#622)", () => {
    const broken = { ...recording([]), export: "everything" } as unknown as PurgeContribution;
    expect(() => defineCapability({ name: "media", requiredBindings: [], purge: [broken] })).toThrow(/media.*export/);
  });

  test("the subject vocabulary is closed, and today it is two words", () => {
    expect(PurgeSubject.options).toEqual(["user", "organization"]);
    expect(PurgeSubject.safeParse("tenant").success).toBe(false);
  });

  test("one capability may declare a contribution per subject, so a user's and an organization's sit side by side (#623)", () => {
    const capability = defineCapability({
      name: "media",
      requiredBindings: [],
      purge: [recording([]), { ...recording([]), subject: "organization" }],
    });
    expect(purgeSteps([capability], "organization").map((step) => step.step)).toEqual(["media"]);
    expect(purgeSteps([capability], "user").map((step) => step.step)).toEqual(["media"]);
  });
});

describe("purgeSteps", () => {
  test("one step per composed capability that declared one, in composition order, named for it", async () => {
    const seen: string[] = [];
    const capabilities: Capability[] = [
      defineCapability({ name: "auth", requiredBindings: [], purge: [recording(seen)] }),
      defineCapability({ name: "turnstile", requiredBindings: [] }),
      defineCapability({ name: "media", requiredBindings: [], purge: [recording(seen)] }),
      defineCapability({ name: "app", requiredBindings: [], purge: [recording(seen, "Erases the adopter's tables.")] }),
    ];
    const steps = purgeSteps(capabilities, "user");
    expect(steps.map((step) => step.step)).toEqual(["auth", "media", "app"]);
    for (const step of steps) await step.contribution.erase?.({ subject: { type: "user", id: "u1" }, env: {} });
    expect(seen).toEqual(["u1", "u1", "u1"]);
  });

  test("a project that composes no contribution has no steps, not an error", () => {
    expect(purgeSteps([defineCapability({ name: "turnstile", requiredBindings: [] })], "user")).toEqual([]);
  });
});

describe("purgeExports (#622)", () => {
  const SUBJECT = { type: "user", id: "u1" } as const;

  test("one entry per step, in step order: what each exported, said none, or could not read", async () => {
    const capabilities: Capability[] = [
      defineCapability({
        name: "auth",
        requiredBindings: [],
        purge: [{ ...recording([]), export: async ({ subject }) => ({ user: { id: subject.id } }) }],
      }),
      defineCapability({ name: "media", requiredBindings: [], purge: [recording([], "Deletes the uploads.")] }),
      defineCapability({
        name: "app",
        requiredBindings: [],
        purge: [
          {
            ...recording([], "Erases the drafts."),
            export: async () => {
              throw new Error("the drafts table is gone");
            },
          },
        ],
      }),
    ];
    const entries = await purgeExports(purgeSteps(capabilities, "user"), { subject: SUBJECT, env: {} });
    expect(entries).toEqual([
      {
        capability: "auth",
        summary: "Erases this capability's rows for one user.",
        disposition: "erase",
        state: "exported",
        data: { user: { id: "u1" } },
      },
      { capability: "media", summary: "Deletes the uploads.", disposition: "erase", state: "not_exported" },
      { capability: "app", summary: "Erases the drafts.", disposition: "erase", state: "unavailable" },
    ]);
  });

  test("an export that answers something other than an object is unavailable, not passed through", async () => {
    const capabilities: Capability[] = [
      defineCapability({
        name: "media",
        requiredBindings: [],
        purge: [{ ...recording([]), export: async () => ["a", "b"] as unknown as Record<string, unknown> }],
      }),
    ];
    const [entry] = await purgeExports(purgeSteps(capabilities, "user"), { subject: SUBJECT, env: {} });
    expect(entry?.state).toBe("unavailable");
  });

  test("each export is read concurrently and one that throws costs only its own entry", async () => {
    const order: string[] = [];
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("slow");
      return { rows: 1 };
    };
    const fast = async () => {
      order.push("fast");
      return { rows: 2 };
    };
    const capabilities: Capability[] = [
      defineCapability({ name: "slow", requiredBindings: [], purge: [{ ...recording([]), export: slow }] }),
      defineCapability({ name: "fast", requiredBindings: [], purge: [{ ...recording([]), export: fast }] }),
    ];
    const entries = await purgeExports(purgeSteps(capabilities, "user"), { subject: SUBJECT, env: {} });
    expect(order).toEqual(["fast", "slow"]);
    expect(entries.map((entry) => entry.capability)).toEqual(["slow", "fast"]);
  });
});

/** A contribution that keeps the subject's rows, with the basis it gives the person (#814). */
function retaining(basis = "Kept for tax records."): PurgeContribution {
  return {
    subject: "user",
    summary: "Keeps the user's purchases.",
    retain: { basis },
    export: async ({ subject }) => ({ purchases: [{ subjectId: subject.id }] }),
  };
}

describe("retain, the third disposition (#814)", () => {
  test("defineCapability accepts a contribution that keeps the rows and says why", () => {
    const contribution = retaining();
    const capability = defineCapability({ name: "payments", requiredBindings: [], purge: [contribution] });
    expect(capability.purge).toEqual([contribution]);
    expect(isRetained(contribution)).toBe(true);
    expect(isRetained(recording([]))).toBe(false);
  });

  test("a retained contribution with no basis is refused — the basis is what the person is told", () => {
    expect(() => defineCapability({ name: "payments", requiredBindings: [], purge: [retaining("  ")] })).toThrow(
      /payments.*basis/,
    );
  });

  test("a retained contribution without an export is refused: rows that are kept are rows that are answered for", () => {
    const { export: _dropped, ...silent } = retaining() as PurgeContribution & { export?: unknown };
    expect(() =>
      defineCapability({ name: "payments", requiredBindings: [], purge: [silent as unknown as PurgeContribution] }),
    ).toThrow(/payments.*export/);
  });

  test("a contribution that both retains and erases is refused — it is one disposition or the other", () => {
    const both = { ...retaining(), erase: async () => {} } as unknown as PurgeContribution;
    expect(() => defineCapability({ name: "payments", requiredBindings: [], purge: [both] })).toThrow(/payments.*both/);
  });

  test("its export entry is exported, with its data and the basis", async () => {
    const capabilities: Capability[] = [
      defineCapability({ name: "payments", requiredBindings: [], purge: [retaining()] }),
    ];
    const entries = await purgeExports(purgeSteps(capabilities, "user"), {
      subject: { type: "user", id: "u1" },
      env: {},
    });
    expect(entries).toEqual([
      {
        capability: "payments",
        summary: "Keeps the user's purchases.",
        disposition: "retain",
        basis: "Kept for tax records.",
        state: "exported",
        data: { purchases: [{ subjectId: "u1" }] },
      },
    ]);
  });

  test("a retained export that cannot be read still says the rows are kept, and why", async () => {
    const broken: PurgeContribution = {
      ...retaining(),
      export: async () => {
        throw new Error("no table");
      },
    };
    const capabilities: Capability[] = [defineCapability({ name: "audit", requiredBindings: [], purge: [broken] })];
    const [entry] = await purgeExports(purgeSteps(capabilities, "user"), {
      subject: { type: "user", id: "u1" },
      env: {},
    });
    expect(entry).toEqual({
      capability: "audit",
      summary: "Keeps the user's purchases.",
      disposition: "retain",
      basis: "Kept for tax records.",
      state: "unavailable",
    });
  });
});

describe("the helpers a contribution is written with (#814)", () => {
  test("purgeBinding hands back the binding, or refuses naming the capability and the binding", () => {
    const db = { prepare: () => null };
    expect(purgeBinding({ DB: db }, "DB", "ledger")).toBe(db);
    expect(() => purgeBinding({}, "DB", "ledger")).toThrow(PithyError);
    expect(() => purgeBinding({ DB: "not a binding" }, "DB", "ledger")).toThrow(/ledger/);
  });

  test("exportRows answers plain JSON, a Date as its ISO string", () => {
    const at = new Date("2026-10-26T12:00:00.000Z");
    expect(exportRows([{ id: 1, at, tags: ["a"], none: null }])).toEqual([
      { id: 1, at: "2026-10-26T12:00:00.000Z", tags: ["a"], none: null },
    ]);
  });
});

describe("credentialFields (#814)", () => {
  test("names every field, at any depth, that holds a credential", () => {
    expect(
      credentialFields({
        member: { email: "ada@example.test", optInToken: "t" },
        shares: [{ token: "s", objectId: "o" }],
        invitations: [{ tokenDigest: "d" }],
        vault: { encryptedValue: "x", clientSecret: "y", password: "z" },
      }),
    ).toEqual([
      "member.optInToken",
      "shares[0].token",
      "invitations[0].tokenDigest",
      "vault.encryptedValue",
      "vault.clientSecret",
      "vault.password",
    ]);
  });

  test("is empty for an export of plain data — a key or a code that is not a credential is not one", () => {
    expect(credentialFields({ accounts: [{ currency: "chips", storageKey: "obj/1", boardKey: "weekly" }] })).toEqual(
      [],
    );
  });
});
