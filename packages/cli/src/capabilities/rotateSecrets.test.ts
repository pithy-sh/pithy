// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretDispatcher, SecretWriteRequest } from "@pithy-sh/secrets/src/cli/dispatch";
import type { SecretRegistry, SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import type { CliAuditEvent } from "../audit/cliAudit";
import { rotationReportLines, runSecretRotation, unrecordedFailure } from "./rotateSecrets";

/**
 * What the operator reads and what the trail records — the two things that must never say a rotation
 * happened when one did not, and must never carry a value when one did.
 */

const DECLARED = ["staging", "prod"] as const;

const local: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  devValue: "random",
  origin: { kind: "minted", recipe: { kind: "random", bytes: 32, encoding: "base64url" } },
  rotation: { kind: "local" },
};

const manual: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: false,
  valueType: "text",
  origin: { kind: "obtained", issuer: "github", documentation: "https://github.com/settings/developers" },
  rotation: { kind: "manual", issuer: "github", documentation: "https://github.com/settings/developers" },
};

const provider: SecretRegistryEntry = {
  backend: "d1",
  scope: "environment",
  rotatable: true,
  valueType: "text",
  origin: { kind: "obtained", issuer: "cloudflare", documentation: "https://dash.cloudflare.com/profile/api-tokens" },
  rotation: {
    kind: "provider",
    issuer: "cloudflare",
    documentation: "https://developers.cloudflare.com/api/resources/user/subresources/tokens/",
  },
  rotator: {
    async roll() {
      return { newValue: "issued-by-cloudflare" };
    },
  },
};

/** A dispatcher that records requests, and refuses whichever environments it is told to. */
function dispatcher(refuse: string[] = []): SecretDispatcher & { sent: SecretWriteRequest[] } {
  const sent: SecretWriteRequest[] = [];
  return {
    sent,
    async dispatch(request) {
      sent.push(request);
      if (refuse.includes(request.env)) throw new Error(`${request.env} refused`);
    },
  };
}

/** An audit emitter that keeps every event, so the trail can be read as data. */
function recorder(): { emit: (event: CliAuditEvent) => Promise<void>; events: CliAuditEvent[] } {
  const events: CliAuditEvent[] = [];
  return {
    events,
    emit: async (event) => {
      events.push(event);
    },
  };
}

const registry = (entry: SecretRegistryEntry): SecretRegistry => ({ THE_SECRET: entry });

describe("what the operator reads", () => {
  test("a local rotation says rotated, and names only the environments that took it", async () => {
    const outcome = await runSecretRotation(registry(local), dispatcher(), {
      name: "THE_SECRET",
      env: "staging",
      environments: DECLARED,
    });
    expect(rotationReportLines(local, outcome, "staging")).toEqual(["THE_SECRET rotated in staging."]);
  });

  test("a provider rotation says where it was rolled, because that is the fact an operator checks", async () => {
    const outcome = await runSecretRotation(registry(provider), dispatcher(), {
      name: "THE_SECRET",
      env: "prod",
      environments: DECLARED,
    });
    expect(rotationReportLines(provider, outcome, "prod")).toEqual([
      "THE_SECRET rolled at cloudflare and recorded in prod.",
    ]);
  });

  test("a manual secret gets the console, the page, and the command that records the result", async () => {
    const outcome = await runSecretRotation(registry(manual), dispatcher(), {
      name: "THE_SECRET",
      env: "prod",
      environments: DECLARED,
    });
    expect(rotationReportLines(manual, outcome, "prod")).toEqual([
      "THE_SECRET is replaced by a human at github. Nothing was called.",
      "https://github.com/settings/developers",
      "Record the new value with pithy secrets update THE_SECRET --env prod.",
    ]);
  });

  /**
   * **The line that must never be printed over a partial failure.**
   *
   * `rotated` is the word an operator scans for, so it is the word that has to be absent here. This asserts
   * the whole rendering rather than a substring: a second line appearing beside a "rotated" first line is
   * exactly the aggregate-over-partial shape `#367` refuses, and only a full comparison catches it.
   */
  test("an unrecorded rotation never says rotated, and names where the dead credential is", async () => {
    const outcome = await runSecretRotation(registry(provider), dispatcher(["prod"]), {
      name: "THE_SECRET",
      env: "prod",
      environments: DECLARED,
      attempts: 2,
      sleep: async () => {},
    });
    const lines = rotationReportLines(provider, outcome, "prod");
    expect(lines).toEqual([
      "THE_SECRET rolled at cloudflare and recorded nowhere.",
      "prod still holds a credential cloudflare has retired.",
    ]);
    expect(lines.join(" ")).not.toContain("rotated");
  });
});

describe("the failure an operator has to act on", () => {
  test("carries its own code, the issuer, the page, and the command — and says the value is gone", async () => {
    const outcome = await runSecretRotation(registry(provider), dispatcher(["prod"]), {
      name: "THE_SECRET",
      env: "prod",
      environments: DECLARED,
      attempts: 2,
      sleep: async () => {},
    });
    const failure = unrecordedFailure(provider, outcome, "prod");
    expect(failure.payload.code).toBe("secrets/rotation_unrecorded");
    expect(failure.payload.message).toContain("THE_SECRET was rolled at cloudflare");
    expect(failure.payload.message).toContain("prod holds a credential cloudflare has retired");
    // The sentence an operator would otherwise assume the opposite of, and lose minutes to.
    expect(failure.payload.action).toContain("The new value is gone.");
    expect(failure.payload.action).toContain("pithy secrets update THE_SECRET --env prod");
    expect(failure.payload.action).toContain("https://developers.cloudflare.com/api/resources/user/");
  });

  /**
   * **The rule, proved rather than asserted.** The rotator's value is a known literal, so every string this
   * failure can produce is searched for it: the message, the action, the detail, and the JSON of the whole
   * payload. A leak into `detail` would be the easy one to write and the hard one to notice, because
   * `detail` is the field a developer reaches for when a message will not do.
   */
  test("no part of it carries the value", async () => {
    const outcome = await runSecretRotation(registry(provider), dispatcher(["prod"]), {
      name: "THE_SECRET",
      env: "prod",
      environments: DECLARED,
      attempts: 1,
    });
    const failure = unrecordedFailure(provider, outcome, "prod");
    expect(JSON.stringify(failure.payload)).not.toContain("issued-by-cloudflare");
    expect(JSON.stringify(outcome)).not.toContain("issued-by-cloudflare");
    expect(failure.message).not.toContain("issued-by-cloudflare");
  });
});

describe("the trail", () => {
  test("records a rotation with the environments it reached, and never a value", async () => {
    const audit = recorder();
    const sent = dispatcher();
    await runSecretRotation(
      registry(provider),
      sent,
      { name: "THE_SECRET", env: "prod", environments: DECLARED },
      audit.emit,
    );
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      action: "secrets/rotated",
      outcome: "success",
      severity: "warning",
      resourceId: "THE_SECRET",
      metadata: { name: "THE_SECRET", environments: ["prod"], rotation: "provider", rolled: true },
    });
    // The dispatcher was handed the value; the trail was not, and there is no field it could go in.
    expect(sent.sent[0]?.value).toBe("issued-by-cloudflare");
    expect(JSON.stringify(audit.events)).not.toContain("issued-by-cloudflare");
  });

  test("an unrecorded rotation is critical, and names both sides of the split", async () => {
    const audit = recorder();
    await runSecretRotation(
      registry({ ...provider, scope: "global" }),
      dispatcher(["prod"]),
      { name: "THE_SECRET", env: undefined, environments: DECLARED, attempts: 1 },
      audit.emit,
    );
    expect(audit.events[0]).toMatchObject({
      action: "secrets/rotated",
      outcome: "failure",
      severity: "critical",
      metadata: { environments: ["staging"], stranded: ["prod"], rolled: true },
    });
  });

  test("a run that called nothing records nothing", async () => {
    const audit = recorder();
    await runSecretRotation(
      registry(manual),
      dispatcher(),
      { name: "THE_SECRET", env: "prod", environments: DECLARED },
      audit.emit,
    );
    expect(audit.events).toEqual([]);
  });
});

describe("routing", () => {
  test("a global secret narrowed with --env is refused before anything is rolled", async () => {
    const sent = dispatcher();
    await expect(
      runSecretRotation(registry({ ...provider, scope: "global" }), sent, {
        name: "THE_SECRET",
        env: "prod",
        environments: DECLARED,
      }),
    ).rejects.toThrow(/holds one value across every environment/);
    expect(sent.sent).toEqual([]);
  });

  test("an undeclared name is refused, and reaches no dispatcher", async () => {
    const sent = dispatcher();
    await expect(
      runSecretRotation({}, sent, { name: "THE_SECRET", env: "prod", environments: DECLARED }),
    ).rejects.toThrow(/not declared in the registry/);
    expect(sent.sent).toEqual([]);
  });
});

/**
 * **A rotator that threw is a different sentence from a store that refused**, and the difference is the
 * difference between a true statement and one that is wrong half the time. Both exit 3; only one of them
 * may say the credential *was* rolled.
 */
describe("when the rotator itself fails", () => {
  const throwing: SecretRegistryEntry = {
    ...provider,
    rotator: {
      async roll() {
        throw new Error("the account rolled, then the connection dropped");
      },
    },
  };

  test("the report says it may have been rolled, and sends the operator to check first", async () => {
    const outcome = await runSecretRotation(registry(throwing), dispatcher(), {
      name: "THE_SECRET",
      env: "prod",
      environments: DECLARED,
    });
    expect(outcome).toMatchObject({ status: "unrecorded", rolled: true, rollFailed: true });
    expect(rotationReportLines(throwing, outcome, "prod")).toEqual([
      "THE_SECRET may have been rolled at cloudflare. Nothing was recorded.",
      "Check cloudflare before running this again.",
    ]);
    const failure = unrecordedFailure(throwing, outcome, "prod");
    expect(failure.payload.code).toBe("secrets/rotation_unrecorded");
    expect(failure.payload.message).toContain("may have been rolled at cloudflare");
    // Rolling again at an issuer that already rolled produces a second orphan, so the check comes first.
    expect(failure.payload.action).toContain("Check at cloudflare whether a new credential was issued.");
  });
});
