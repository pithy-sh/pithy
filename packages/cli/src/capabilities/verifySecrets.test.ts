// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { StoreVerification } from "@pithy-sh/secrets/src/admin/verifyStore";
import type { SecretStoreVerifier } from "@pithy-sh/secrets/src/cli/dispatch";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import { EXIT_ROLLED_NOT_RECORDED } from "./rotateSecrets";
import { storeEntryCensus } from "./storeEntryCensus";
import {
  EXIT_MASTER_KEY_UNREADABLE,
  EXIT_STORE_UNVERIFIED,
  firstUnreachable,
  runSecretsVerification,
  sweepStoreEntries,
  type VerificationReport,
  verificationExitCode,
  verificationJson,
  verificationReportLines,
  verificationVerdict,
} from "./verifySecrets";

/**
 * The verdict, the exit code and the sentences.
 *
 * The three things a cron acts on, and each has a state it must be able to tell apart from its
 * neighbor: a finding from a fault, a withheld sweep from a clean one, and a master key that will not
 * resolve from anything at all. Every case here is paired with the state that makes it the other answer.
 */

const CLEAN: StoreVerification = {
  keySet: "resolved",
  rows: 12,
  readable: 12,
  unreadable: 0,
  keyVersions: [{ keyVersion: 2, rows: 12 }],
  heldVersions: [1, 2],
  currentVersion: 2,
  currentVersionHeld: true,
  missingVersions: [],
  rotationInProgress: false,
};

function verified(env: ManagedEnvironment, verification: StoreVerification = CLEAN) {
  return { env, state: "verified" as const, verification };
}

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return { environments: [verified("prod")], sweep: null, notSwept: null, ...overrides };
}

const registry = defineSecretRegistry({
  "email-link-signing-key": { backend: "cf-secrets-store", scope: "environment", rotatable: true, valueType: "text" },
  SECRETS_ENCRYPTION_KEYS: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    bootstrap: true,
  },
});

function census(overrides: { registryComplete?: boolean } = {}) {
  return storeEntryCensus({
    project: "acme",
    environments: ["prod"],
    registry,
    registryComplete: overrides.registryComplete ?? true,
    tokenEntries: [],
  });
}

describe("runSecretsVerification", () => {
  test("one environment's silence never costs another its answer", async () => {
    const verifier: SecretStoreVerifier = {
      verifyStore: async ({ env }) => {
        if (env === "staging") throw new Error("no manager");
        return CLEAN;
      },
    };

    const answers = await runSecretsVerification({ verifier, environments: ["staging", "prod"] });

    expect(answers.map((entry) => [entry.env, entry.state])).toEqual([
      ["staging", "unreachable"],
      ["prod", "verified"],
    ]);
    expect(answers[1]?.verification).toEqual(CLEAN);
  });

  test("the cause is kept for the caller rather than rendered here", async () => {
    const cause = new Error("no manager");
    const verifier: SecretStoreVerifier = { verifyStore: async () => Promise.reject(cause) };

    const answers = await runSecretsVerification({ verifier, environments: ["prod"] });

    expect(firstUnreachable({ environments: answers, sweep: null, notSwept: null })).toBe(cause);
  });
});

describe("the verdict", () => {
  test("a clean environment and a clean sweep is verified", () => {
    const sweep = sweepStoreEntries(["acme-prod-email-link-signing-key"], census());

    expect(verificationVerdict(report({ sweep }))).toBe("verified");
  });

  test("a stray master key is a finding, not a printed aside", () => {
    // **The debris the sibling outage actually left (#647).** A second entry holding a key sat beside the real
    // one for months. `key-material` was collected and rendered — `Key material: …` — and then not counted, so
    // the run said `verified` and exited 0 over exactly the thing it was built to find. Drop
    // `report.sweep?.keyMaterial.length` from the `found` disjunction in verifySecrets.ts and this goes green.
    const sweep = sweepStoreEntries(["acme-staging-secrets-encryption-keys"], census());

    expect(sweep.keyMaterial).not.toEqual([]);
    expect(verificationVerdict(report({ sweep }))).toBe("failed");
  });

  test("an unreadable row is a finding", () => {
    expect(verificationVerdict(report({ environments: [verified("prod", { ...CLEAN, unreadable: 1 })] }))).toBe(
      "failed",
    );
  });

  test("a missing key version is a finding", () => {
    expect(verificationVerdict(report({ environments: [verified("prod", { ...CLEAN, missingVersions: [1] })] }))).toBe(
      "failed",
    );
  });

  test("a missing key version during a live at-rest rotation is not, because it may be a key mid-flight", () => {
    const midRotation = { ...CLEAN, missingVersions: [3], rotationInProgress: true };

    expect(verificationVerdict(report({ environments: [verified("prod", midRotation)] }))).toBe("verified");
    // And the same numbers with no rotation running are a finding, so this is not a blanket exemption.
    expect(
      verificationVerdict(report({ environments: [verified("prod", { ...midRotation, rotationInProgress: false })] })),
    ).toBe("failed");
  });

  test("a pointer the key set does not hold is a finding, though every row still opens (D9)", () => {
    const pointerMoved = { ...CLEAN, currentVersionHeld: false };

    expect(verificationVerdict(report({ environments: [verified("prod", pointerMoved)] }))).toBe("failed");
  });

  test("a pointer that is not a version number is a finding", () => {
    expect(verificationVerdict(report({ environments: [verified("prod", { ...CLEAN, currentVersion: null })] }))).toBe(
      "failed",
    );
  });

  test("a master key that will not resolve is its own verdict, not merely a finding", () => {
    const unreadable: StoreVerification = {
      keySet: "unreadable",
      rows: 12,
      keyVersions: [],
      rotationInProgress: false,
    };

    expect(verificationVerdict(report({ environments: [verified("prod", unreadable)] }))).toBe("key-unreadable");
  });

  test("an unscoped store entry is a finding", () => {
    const sweep = sweepStoreEntries(["SECRETS_ENCRYPTION_KEYS"], census());

    expect(verificationVerdict(report({ sweep }))).toBe("failed");
  });

  test("an orphan is a finding", () => {
    const sweep = sweepStoreEntries(["acme-prod-leftover"], census());

    expect(verificationVerdict(report({ sweep }))).toBe("failed");
  });

  test("a withheld sweep is neither verified nor failed", () => {
    const sweep = sweepStoreEntries(["acme-prod-leftover"], census({ registryComplete: false }));

    expect(sweep.orphans).toEqual([]);
    expect(verificationVerdict(report({ sweep }))).toBe("withheld");
  });

  test("a sweep that never ran is withheld too", () => {
    expect(verificationVerdict(report({ notSwept: "The CF Secrets Store id is missing." }))).toBe("withheld");
  });

  test("a finding outranks a withheld sweep", () => {
    const sweep = sweepStoreEntries(["SECRETS_ENCRYPTION_KEYS"], census({ registryComplete: false }));

    expect(verificationVerdict(report({ sweep }))).toBe("failed");
  });

  test("an unreachable environment beside a finding is still a finding", () => {
    // The whole reason the exit codes are distinct. Masked by the fault, the broken store exits 1 — the
    // code a cron retries forever.
    const mixed = report({
      environments: [
        { env: "staging", state: "unreachable", cause: new Error("no manager") },
        verified("prod", { ...CLEAN, missingVersions: [1] }),
      ],
    });

    expect(verificationVerdict(mixed)).toBe("failed");
    expect(verificationExitCode(verificationVerdict(mixed))).toBe(EXIT_STORE_UNVERIFIED);
  });
});

describe("the exit codes", () => {
  test("each verdict maps to its own status", () => {
    expect(verificationExitCode("verified")).toBe(0);
    expect(verificationExitCode("withheld")).toBe(0);
    expect(verificationExitCode("failed")).toBe(EXIT_STORE_UNVERIFIED);
    expect(verificationExitCode("key-unreadable")).toBe(EXIT_MASTER_KEY_UNREADABLE);
  });

  test("a finding is distinguishable from every other status a secrets command produces", () => {
    // 1 is "could not run, try again", 2 is citty's usage error, 3 is rolled-not-recorded. A script has
    // to be able to tell a finding from any of them without parsing a message.
    expect(new Set([1, 2, EXIT_ROLLED_NOT_RECORDED, EXIT_STORE_UNVERIFIED, EXIT_MASTER_KEY_UNREADABLE]).size).toBe(5);
  });
});

describe("sweepStoreEntries", () => {
  test("counts every class and names only what it is entitled to", () => {
    const sweep = sweepStoreEntries(
      ["acme-prod-email-link-signing-key", "SECRETS_ENCRYPTION_KEYS", "acme-prod-leftover", "beta-prod-db"],
      census(),
    );

    expect(sweep.counts).toMatchObject({ accounted: 1, unscoped: 1, orphan: 1, foreign: 1 });
    expect(sweep.unscoped).toEqual(["SECRETS_ENCRYPTION_KEYS"]);
    expect(sweep.orphans).toEqual(["acme-prod-leftover"]);
  });

  test("a foreign entry is counted and never named", () => {
    const sweep = sweepStoreEntries(["beta-prod-db"], census());

    expect(sweep.counts.foreign).toBe(1);
    expect(JSON.stringify(sweep)).not.toContain("beta-prod-db");
  });

  test("a withheld verdict suppresses the orphan names and keeps the counts", () => {
    const sweep = sweepStoreEntries(
      ["acme-prod-leftover", "acme-prod-legacy-secrets-encryption-keys"],
      census({ registryComplete: false }),
    );

    expect(sweep.counts).toMatchObject({ orphan: 1, "key-material": 1 });
    expect(sweep.orphans).toEqual([]);
    expect(sweep.keyMaterial).toEqual([]);
    expect(sweep.withheld).not.toBeNull();
  });

  test("a withheld verdict still reports an unscoped entry", () => {
    const sweep = sweepStoreEntries(["SECRETS_ENCRYPTION_KEYS"], census({ registryComplete: false }));

    expect(sweep.unscoped).toEqual(["SECRETS_ENCRYPTION_KEYS"]);
  });
});

describe("the lines an operator reads", () => {
  test("a clean environment reports counts and versions", () => {
    const lines = verificationReportLines(report());

    expect(lines[0]).toBe("prod: 12 of 12 rows opened. Key versions 2 (12 rows).");
  });

  test("a master key that will not resolve says exactly that, and says what to look at (D15)", () => {
    const unreadable: StoreVerification = {
      keySet: "unreadable",
      rows: 12,
      keyVersions: [],
      rotationInProgress: false,
    };

    const lines = verificationReportLines(report({ environments: [verified("prod", unreadable)] }));

    expect(lines.join("\n")).toContain("the master key will not resolve");
    expect(lines.join("\n")).toContain("SECRETS_ENCRYPTION_KEYS");
    // Never the sentence a retryable fault gets. That reading is what sent a cron round this state forever.
    expect(lines.join("\n")).not.toContain("could not be reached");
  });

  test("an unreachable manager is the one that says it could not be reached", () => {
    const lines = verificationReportLines(
      report({ environments: [{ env: "prod", state: "unreachable", cause: new Error("x") }] }),
    );

    expect(lines).toEqual(["prod: no answer. The manager could not be reached."]);
  });

  test("a missing version names the versions and does not open with `restore the key`", () => {
    // The remedy touches the one value a wrong edit makes unrecoverable, so finding out what removed it
    // comes first. A line leading with the edit is a line somebody follows at 2am.
    const lines = verificationReportLines(
      report({ environments: [verified("prod", { ...CLEAN, missingVersions: [1, 4] })] }),
    );

    expect(lines.join("\n")).toContain("key versions 1, 4");
    expect(lines.join("\n")).toContain("Find out what removed that key version");
  });

  test("a missing version during a rotation says to re-run instead", () => {
    const lines = verificationReportLines(
      report({ environments: [verified("prod", { ...CLEAN, missingVersions: [4], rotationInProgress: true })] }),
    );

    expect(lines.join("\n")).toContain("Run this again once it finishes");
    expect(lines.join("\n")).not.toContain("Find out what removed");
  });

  test("a pointer the key set does not hold says every new write will fail", () => {
    const lines = verificationReportLines(
      report({ environments: [verified("prod", { ...CLEAN, currentVersionHeld: false })] }),
    );

    expect(lines.join("\n")).toContain("The active key pointer is version 2");
    expect(lines.join("\n")).toContain("Every new write will fail.");
  });

  test("an unscoped entry is named with the sentence that stops somebody deleting it on this report's word", () => {
    const lines = verificationReportLines(report({ sweep: sweepStoreEntries(["SECRETS_ENCRYPTION_KEYS"], census()) }));

    expect(lines.join("\n")).toContain("Unscoped entry: SECRETS_ENCRYPTION_KEYS");
    expect(lines.join("\n")).toContain("says nothing about which project wrote it");
  });

  test("key material is named as key material, never as an orphan", () => {
    const lines = verificationReportLines(
      report({ sweep: sweepStoreEntries(["acme-prod-legacy-secrets-encryption-keys"], census()) }),
    );

    expect(lines.join("\n")).toContain("Key material: acme-prod-legacy-secrets-encryption-keys");
    expect(lines.join("\n")).not.toContain("Orphan:");
  });

  test("a withheld verdict prints its reason, because a detector that guesses is worse than one that says it cannot tell", () => {
    const lines = verificationReportLines(
      report({ sweep: sweepStoreEntries(["acme-prod-leftover"], census({ registryComplete: false })) }),
    );

    expect(lines.join("\n")).toContain("Orphan verdict withheld.");
    expect(lines.join("\n")).not.toContain("acme-prod-leftover");
  });

  test("a sweep that never ran says so rather than reading as one that found nothing", () => {
    const lines = verificationReportLines(report({ notSwept: "The CF Secrets Store id is missing." }));

    expect(lines.join("\n")).toContain("Store not swept. The CF Secrets Store id is missing.");
  });

  test("nothing that could be a secret reaches the rendered lines", () => {
    // Asserted against the rendering, not against the inputs: the report is built from a verification
    // that has no field for a value, so the only way one could appear is if a line invented it.
    const rendered = verificationReportLines(
      report({
        environments: [verified("prod", { ...CLEAN, unreadable: 3, missingVersions: [1] })],
        sweep: sweepStoreEntries(["SECRETS_ENCRYPTION_KEYS", "beta-prod-db"], census()),
      }),
    ).join("\n");

    expect(rendered).not.toContain("beta-prod-db");
    expect(rendered).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
  });
});

describe("--json", () => {
  test("carries the verdict, the exit code, and a boolean that is false for anything but verified", () => {
    const clean = verificationJson(report({ sweep: sweepStoreEntries([], census()) }));
    const withheld = verificationJson(report({ notSwept: "no store" }));
    const failed = verificationJson(report({ environments: [verified("prod", { ...CLEAN, unreadable: 1 })] }));

    expect(clean).toMatchObject({ command: "secrets verify", verdict: "verified", verified: true, exitCode: 0 });
    // A run that asserted nothing about the store must not read like one that found nothing.
    expect(withheld).toMatchObject({ verdict: "withheld", verified: false, exitCode: 0 });
    expect(failed).toMatchObject({ verdict: "failed", verified: false, exitCode: EXIT_STORE_UNVERIFIED });
  });

  test("`verified` agrees with the verdict on every shape", () => {
    const shapes: VerificationReport[] = [
      report({ sweep: sweepStoreEntries([], census()) }),
      report({ notSwept: "no store" }),
      report({ environments: [verified("prod", { ...CLEAN, missingVersions: [1] })] }),
      report({
        environments: [verified("prod", { keySet: "unreadable", rows: 1, keyVersions: [], rotationInProgress: false })],
      }),
    ];

    for (const shape of shapes) {
      expect(verificationJson(shape).verified).toBe(verificationVerdict(shape) === "verified");
    }
  });

  test("an unreachable environment appears without a verification rather than with an empty one", () => {
    const json = verificationJson(
      report({ environments: [{ env: "prod", state: "unreachable", cause: new Error("x") }] }),
    );

    expect(json.environments).toEqual([{ env: "prod", state: "unreachable" }]);
  });

  test("the cause never crosses into the JSON line", () => {
    const cause = new Error("SECRET-BEARING-UPSTREAM-TEXT");

    const json = JSON.stringify(
      verificationJson(report({ environments: [{ env: "prod", state: "unreachable", cause }] })),
    );

    expect(json).not.toContain("SECRET-BEARING-UPSTREAM-TEXT");
  });
});
