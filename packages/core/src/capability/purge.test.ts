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

  test("two unnamed for the same subject from one capability are refused — each needs its own step name", () => {
    // The Workflow runs a step per contribution so a failure retries one alone. Two unnamed contributions for one
    // subject would both take the capability's name, and the second would be served the first one's journal.
    expect(() =>
      defineCapability({ name: "media", requiredBindings: [], purge: [recording([]), recording([])] }),
    ).toThrow(
      "The media capability declares 2 purge contributions for user (unnamed, unnamed), and 2 have no step name.",
    );
  });

  test("several for one subject with distinct step names are accepted, one step each, named <capability>/<step>", () => {
    const capability = defineCapability({
      name: "app",
      requiredBindings: [],
      purge: [
        { ...recording([], "Deletes the scores."), step: "scores" },
        { ...recording([], "Deletes the runs."), step: "runs" },
      ],
    });
    expect(purgeSteps([capability], "user").map(({ step, capability }) => ({ step, capability }))).toEqual([
      { step: "app/scores", capability: "app" },
      { step: "app/runs", capability: "app" },
    ]);
  });

  test("several for one subject where one has no step name are refused, naming the subject and the count", () => {
    const purge = [{ ...recording([]), step: "scores" }, recording([])];
    expect(() => defineCapability({ name: "app", requiredBindings: [], purge })).toThrow(PithyError);
    expect(() => defineCapability({ name: "app", requiredBindings: [], purge })).toThrow(
      'The app capability declares 2 purge contributions for user ("scores", unnamed), and 1 has no step name.',
    );
  });

  test("two for one subject sharing a step name are refused, naming the name", () => {
    const purge = [
      { ...recording([]), step: "scores" },
      { ...recording([]), step: "scores" },
    ];
    expect(() => defineCapability({ name: "app", requiredBindings: [], purge })).toThrow(
      /app capability declares two user purge contributions with the step name "scores"/,
    );
  });

  test("a step name that is not a lowercase slug is refused, because it becomes part of a Workflow step's name", () => {
    for (const step of ["", "Scores", "app/scores", "high scores"]) {
      expect(() =>
        defineCapability({ name: "app", requiredBindings: [], purge: [{ ...recording([]), step }] }),
      ).toThrow(/step name/);
    }
  });

  test("a named step's other refusals name the step, so the one to fix is plain among several", () => {
    const purge = [
      { ...recording([]), step: "scores" },
      { ...recording([], ""), step: "runs" },
    ];
    expect(() => defineCapability({ name: "app", requiredBindings: [], purge })).toThrow(
      'The app capability\'s user purge step "runs" has no summary.',
    );
  });

  test("the same step name under two subjects is two steps in two purges, so it is accepted", () => {
    const capability = defineCapability({
      name: "app",
      requiredBindings: [],
      purge: [
        { ...recording([]), step: "scores" },
        { ...recording([]), subject: "organization", step: "scores" },
      ],
    });
    expect(purgeSteps([capability], "organization").map((each) => each.step)).toEqual(["app/scores"]);
  });

  test("a contribution with no summary is refused, because the summary is what the step records", () => {
    expect(() => defineCapability({ name: "media", requiredBindings: [], purge: [recording([], "")] })).toThrow(
      PithyError,
    );
  });

  test("an export that is not a function is refused, because the export route would call it", () => {
    const broken = { ...recording([]), export: "everything" } as unknown as PurgeContribution;
    expect(() => defineCapability({ name: "media", requiredBindings: [], purge: [broken] })).toThrow(/media.*export/);
  });

  test("the subject vocabulary is closed, and today it is two words", () => {
    expect(PurgeSubject.options).toEqual(["user", "organization"]);
    expect(PurgeSubject.safeParse("tenant").success).toBe(false);
  });

  test("one capability may declare a contribution per subject, so a user's and an organization's sit side by side", () => {
    const capability = defineCapability({
      name: "media",
      requiredBindings: [],
      purge: [recording([]), { ...recording([]), subject: "organization" }],
    });
    expect(purgeSteps([capability], "organization").map((step) => step.step)).toEqual(["media"]);
    expect(purgeSteps([capability], "user").map((step) => step.step)).toEqual(["media"]);
  });

  test("a contribution reads the deletion it runs under when one is handed, and runs the same without it", async () => {
    const seen: (string | null)[] = [];
    const contribution: PurgeContribution = {
      subject: "organization",
      summary: "Tells the members.",
      erase: async ({ deletion }) => {
        seen.push(deletion ? `${deletion.actor.type}:${deletion.mode}:${deletion.reason}` : null);
      },
    };
    const subject = { type: "organization", id: "org-1" } as const;
    await contribution.erase?.({
      subject,
      env: {},
      deletion: { actor: { type: "owner", id: "u1" }, reason: "Closing.", mode: "hard", at: new Date(0) },
    });
    await contribution.erase?.({ subject, env: {} });
    expect(seen).toEqual(["owner:hard:Closing.", null]);
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
    expect(steps.map((step) => step.capability)).toEqual(["auth", "media", "app"]);
    for (const step of steps) await step.contribution.erase?.({ subject: { type: "user", id: "u1" }, env: {} });
    expect(seen).toEqual(["u1", "u1", "u1"]);
  });

  test("a project that composes no contribution has no steps, not an error", () => {
    expect(purgeSteps([defineCapability({ name: "turnstile", requiredBindings: [] })], "user")).toEqual([]);
  });
});

describe("purgeExports", () => {
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

  test("a capability's named steps each answer their own part, filed under the capability with the step named", async () => {
    const capabilities: Capability[] = [
      defineCapability({
        name: "app",
        requiredBindings: [],
        purge: [
          { ...recording([], "Deletes the scores."), step: "scores", export: async () => ({ scores: [1] }) },
          { ...recording([], "Deletes the runs."), step: "runs" },
        ],
      }),
    ];
    const entries = await purgeExports(purgeSteps(capabilities, "user"), { subject: SUBJECT, env: {} });
    expect(entries).toEqual([
      {
        capability: "app",
        step: "scores",
        summary: "Deletes the scores.",
        disposition: "erase",
        state: "exported",
        data: { scores: [1] },
      },
      { capability: "app", step: "runs", summary: "Deletes the runs.", disposition: "erase", state: "not_exported" },
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

/** A contribution that keeps the subject's rows, with the basis it gives the person. */
function retaining(basis = "Kept for tax records."): PurgeContribution {
  return {
    subject: "user",
    summary: "Keeps the user's purchases.",
    retain: { basis },
    export: async ({ subject }) => ({ purchases: [{ subjectId: subject.id }] }),
  };
}

describe("retain, the third disposition", () => {
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

describe("a retained basis that names a catalog key", () => {
  const keyed = (basisKey: string): PurgeContribution => ({
    subject: "user",
    summary: "Keeps the user's purchases.",
    retain: { basis: "Kept for tax records.", basisKey },
    export: async ({ subject }) => ({ purchases: [{ subjectId: subject.id }] }),
  });

  test("defineCapability accepts a basisKey under the capability's own domain", () => {
    const contribution = keyed("payments/purge.retained");
    expect(defineCapability({ name: "payments", requiredBindings: [], purge: [contribution] }).purge).toEqual([
      contribution,
    ]);
  });

  test("a basisKey under another capability's domain is refused, naming the capability and the key", () => {
    const define = () =>
      defineCapability({ name: "payments", requiredBindings: [], purge: [keyed("auth/purge.retained")] });
    expect(define).toThrow(PithyError);
    expect(define).toThrow(/payments/);
    try {
      define();
    } catch (error) {
      const { message, action, detail } = error as PithyError & { action?: string; detail?: string };
      expect(`${message} ${action} ${detail}`).toContain("auth/purge.retained");
    }
  });

  test("a basisKey that is not a catalog key at all is refused, naming it", () => {
    expect(() =>
      defineCapability({ name: "payments", requiredBindings: [], purge: [keyed("payments/Not A Key")] }),
    ).toThrow(/payments\/Not A Key/);
    expect(() => defineCapability({ name: "payments", requiredBindings: [], purge: [keyed("" as string)] })).toThrow(
      PithyError,
    );
  });

  test("the export translates the key, and carries it beside the translated basis", async () => {
    const capabilities: Capability[] = [
      defineCapability({ name: "payments", requiredBindings: [], purge: [keyed("payments/purge.retained")] }),
    ];
    const spanish = (key: string) =>
      key === "payments/purge.retained" ? "Se conservan por obligaciones fiscales." : null;
    const [entry] = await purgeExports(purgeSteps(capabilities, "user"), { subject: SUBJECT_U1, env: {} }, spanish);
    expect(entry).toMatchObject({
      disposition: "retain",
      basis: "Se conservan por obligaciones fiscales.",
      basisKey: "payments/purge.retained",
      state: "exported",
    });
  });

  test("a key the translator has no entry for answers with the basis", async () => {
    const capabilities: Capability[] = [
      defineCapability({ name: "payments", requiredBindings: [], purge: [keyed("payments/purge.retained")] }),
    ];
    const [entry] = await purgeExports(purgeSteps(capabilities, "user"), { subject: SUBJECT_U1, env: {} }, () => null);
    expect(entry).toMatchObject({ basis: "Kept for tax records.", basisKey: "payments/purge.retained" });
  });

  test("with no translator the basis is the English one, and a contribution with only a basis carries no key", async () => {
    const capabilities: Capability[] = [
      defineCapability({ name: "payments", requiredBindings: [], purge: [keyed("payments/purge.retained")] }),
      defineCapability({ name: "audit", requiredBindings: [], purge: [retaining()] }),
    ];
    const translate = (key: string) => `translated ${key}`;
    const [keyedEntry] = await purgeExports(purgeSteps(capabilities, "user"), { subject: SUBJECT_U1, env: {} });
    expect(keyedEntry).toMatchObject({ basis: "Kept for tax records.", basisKey: "payments/purge.retained" });
    const [, plain] = await purgeExports(purgeSteps(capabilities, "user"), { subject: SUBJECT_U1, env: {} }, translate);
    expect(plain).toEqual({
      capability: "audit",
      summary: "Keeps the user's purchases.",
      disposition: "retain",
      basis: "Kept for tax records.",
      state: "exported",
      data: { purchases: [{ subjectId: "u1" }] },
    });
  });
});

const SUBJECT_U1 = { type: "user", id: "u1" } as const;

describe("the helpers a contribution is written with", () => {
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

describe("credentialFields", () => {
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
