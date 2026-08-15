// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type FixtureName,
  type FixtureOutcome,
  fixtureReady,
  fixtureReportLines,
  fixtureValue,
  LIVE_FIXTURES,
  reportFixtureEstate,
  resolveFixture,
} from "./fixtures";

/**
 * A gate about gates, so it is proved in three directions rather than one.
 *
 * The failure this kit keeps finding is that **"everything skipped" and "everything passed" look
 * identical**. A helper that always skips satisfies every test that only checks nothing threw, and it
 * takes a whole suite offline in silence. So:
 *
 * 1. A missing fixture skips, and the skip is *visible* — asserted on the reported outcome and on the
 *    line a human reads, not on the absence of an exception.
 * 2. A planted fixture **runs**. There is a live `describe.skipIf` below whose body must execute, and an
 *    `afterAll` that fails the file if it did not. Without it, proof 1 alone is satisfied by a helper
 *    that never lets anything run.
 * 3. A malformed fixture is not an absent one. Empty, whitespace, and the literal text `undefined` each
 *    have a deliberate answer, and it is not the answer given to a fixture nobody configured.
 *
 * Every case injects its own environment. A maintainer's real `.dev.vars` must never decide whether a
 * unit test passes — the failure `vitest.setup.ts` exists to prevent, one level up.
 */

/** No variables at all: the contributor with no credentials. */
const NOTHING: Record<string, string | undefined> = {};

/** A complete Turnstile fixture. Planted, and deliberately not shaped like a real key. */
const PLANTED_SITE_KEY = "planted-sitekey-abc123";
const PLANTED_SECRET_KEY = "planted-secretkey-xyz789";
const PLANTED_TURNSTILE: Record<string, string> = {
  TURNSTILE_SITE_KEY: PLANTED_SITE_KEY,
  TURNSTILE_SECRET_KEY: PLANTED_SECRET_KEY,
};

describe("a missing fixture skips, and says so", () => {
  it("resolves to absent, and is not ready", () => {
    const resolution = resolveFixture("turnstile-widget", { env: NOTHING });
    expect(resolution.outcome).toBe<FixtureOutcome>("absent");
    expect(resolution.ready).toBe(false);
    expect(fixtureReady("turnstile-widget", { env: NOTHING })).toBe(false);
  });

  it("reports the fixture, the variables, what skips, and where to make it", () => {
    const [line] = fixtureReportLines([resolveFixture("turnstile-widget", { env: NOTHING })]);
    expect(line).toBe(
      "fixture absent: turnstile-widget. TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY are not set. " +
        "Turnstile sign-in gating on a workers.dev hostname (#84) skips. See docs/FIXTURES.md#turnstile-widget.",
    );
  });

  it("counts the estate, so a wholly skipped run cannot read as a passing one", () => {
    const resolutions = (Object.keys(LIVE_FIXTURES) as FixtureName[]).map((name) =>
      resolveFixture(name, { env: NOTHING }),
    );
    const lines = fixtureReportLines(resolutions);
    expect(lines.at(-1)).toBe(
      "fixtures: 0 present, 8 absent, 0 malformed, 0 declined. A skipped suite is not a passing one.",
    );
  });

  it("never prints a value, in any outcome", () => {
    const planted = { ...PLANTED_TURNSTILE, PITHY_LIVE_DEPLOY: "1", SECRETS_STORE_ID: "  " };
    const resolutions = (Object.keys(LIVE_FIXTURES) as FixtureName[]).map((name) =>
      resolveFixture(name, { env: planted }),
    );
    const report = fixtureReportLines(resolutions).join("\n");
    expect(report).not.toContain(PLANTED_SITE_KEY);
    expect(report).not.toContain(PLANTED_SECRET_KEY);
  });
});

/**
 * Proof 2, at the level it has to be proved on: a real `describe.skipIf`, whose body really runs.
 *
 * An assertion inside a skipped `describe` is not evidence of anything — Vitest never reaches it. So the
 * evidence is a side effect and an `afterAll` outside the gate.
 */
let plantedSuiteRan = false;

describe.skipIf(!fixtureReady("turnstile-widget", { env: PLANTED_TURNSTILE }))(
  "a planted fixture runs — this suite must not skip",
  () => {
    it("executes its body, and reads the planted value", () => {
      plantedSuiteRan = true;
      expect(fixtureValue("turnstile-widget", "TURNSTILE_SITE_KEY", { env: PLANTED_TURNSTILE })).toBe(PLANTED_SITE_KEY);
    });
  },
);

describe.skipIf(!fixtureReady("turnstile-widget", { env: NOTHING }))(
  "an absent fixture skips — this suite must never run",
  () => {
    it("would fail the file if the gate were inverted", () => {
      expect.unreachable("A suite gated on an absent fixture ran. The gate is inverted.");
    });
  },
);

afterAll(() => {
  // Outside the gate on purpose. Every other assertion in this file is satisfied by a helper that skips
  // everything; this one is not.
  expect(plantedSuiteRan).toBe(true);
});

describe("a malformed fixture is not an absent one", () => {
  const cases: ReadonlyArray<[label: string, value: string, note: string]> = [
    ["an empty string", "", "is set to an empty value"],
    ["whitespace only", "   ", "is set to whitespace"],
    ["the literal text undefined", "undefined", "is set to placeholder text, not a value"],
    ["the literal text null", "NULL", "is set to placeholder text, not a value"],
  ];

  it.each(cases)("%s is malformed, not absent", (_label, value, note) => {
    const env = { SECRETS_STORE_ID: value };
    const resolution = resolveFixture("secrets-store", { env });
    expect(resolution.outcome).toBe<FixtureOutcome>("malformed");
    expect(resolution.reason).toBe(`SECRETS_STORE_ID ${note}.`);
  });

  it.each(cases)("%s still skips rather than failing the run", (_label, value) => {
    expect(fixtureReady("secrets-store", { env: { SECRETS_STORE_ID: value } })).toBe(false);
  });

  it("says malformed where absent would be wrong, and absent where it is right", () => {
    const broken = fixtureReportLines([resolveFixture("secrets-store", { env: { SECRETS_STORE_ID: "" } })]);
    const missing = fixtureReportLines([resolveFixture("secrets-store", { env: NOTHING })]);
    expect(broken[0]).toContain("fixture malformed: secrets-store. SECRETS_STORE_ID is set to an empty value.");
    expect(missing[0]).toContain("fixture absent: secrets-store. SECRETS_STORE_ID is not set.");
    expect(broken[0]).not.toBe(missing[0]);
  });

  it("takes the worst verdict across a fixture's keys, so one broken key is never averaged away", () => {
    const env = { TURNSTILE_SITE_KEY: "real-enough", TURNSTILE_SECRET_KEY: "" };
    const resolution = resolveFixture("turnstile-widget", { env });
    expect(resolution.outcome).toBe<FixtureOutcome>("malformed");
    expect(resolution.reason).toBe("TURNSTILE_SECRET_KEY is set to an empty value.");
  });

  it("is not ready when only some of its keys are set", () => {
    expect(fixtureReady("turnstile-widget", { env: { TURNSTILE_SITE_KEY: PLANTED_SITE_KEY } })).toBe(false);
  });
});

describe("a switch is a word, not a non-empty string", () => {
  it.each(["1", "true", "TRUE", "yes", "on"])("%s arms the deploy", (value) => {
    const resolution = resolveFixture("live-deploy", { env: { PITHY_LIVE_DEPLOY: value } });
    expect(resolution.outcome).toBe<FixtureOutcome>("present");
  });

  it.each(["0", "false", "no", "off"])("%s declines it, and is not a misconfiguration", (value) => {
    const resolution = resolveFixture("live-deploy", { env: { PITHY_LIVE_DEPLOY: value } });
    expect(resolution.outcome).toBe<FixtureOutcome>("declined");
    expect(resolution.reason).toBe("PITHY_LIVE_DEPLOY is off.");
  });

  it("refuses a word that is neither, rather than reading it as yes", () => {
    const resolution = resolveFixture("live-deploy", { env: { PITHY_LIVE_DEPLOY: "please" } });
    expect(resolution.outcome).toBe<FixtureOutcome>("malformed");
    expect(resolution.ready).toBe(false);
  });

  it("keeps the behaviour the hand-rolled check had: only an explicit word deploys", () => {
    // `process.env.PITHY_LIVE_DEPLOY === "1"` was the whole gate, in five places. This is the one.
    expect(fixtureReady("live-deploy", { env: { PITHY_LIVE_DEPLOY: "1" } })).toBe(true);
    expect(fixtureReady("live-deploy", { env: { PITHY_LIVE_DEPLOY: "0" } })).toBe(false);
    expect(fixtureReady("live-deploy", { env: NOTHING })).toBe(false);
  });
});

describe("reading a value", () => {
  it("hands back the trimmed value of a ready fixture", () => {
    const env = { SECRETS_STORE_ID: "  store-id  " };
    expect(fixtureValue("secrets-store", "SECRETS_STORE_ID", { env })).toBe("store-id");
  });

  it("refuses a fixture that is not ready, and names the document rather than a value", () => {
    let thrown: unknown;
    try {
      fixtureValue("turnstile-widget", "TURNSTILE_SITE_KEY", { env: NOTHING });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PithyError);
    const payload = (thrown as PithyError).payload;
    expect(payload.message).toBe("Fixture turnstile-widget is absent.");
    expect(payload.action).toContain("docs/FIXTURES.md#turnstile-widget");
  });

  it("refuses a key the fixture does not declare", () => {
    expect(() => fixtureValue("secrets-store", "TURNSTILE_SITE_KEY", { env: NOTHING })).toThrow(PithyError);
  });
});

describe("the estate report", () => {
  it("covers every declared fixture and never throws", () => {
    const resolutions = reportFixtureEstate({ env: NOTHING });
    expect(resolutions.map((entry) => entry.fixture.name)).toEqual(Object.keys(LIVE_FIXTURES));
  });

  it("survives a reporter that cannot print, rather than failing the run it was explaining", () => {
    const warn = vi.spyOn(console, "warn").mockImplementationOnce(() => {
      throw new Error("stdout is gone");
    });
    expect(() => reportFixtureEstate({ env: NOTHING })).not.toThrow();
    warn.mockRestore();
  });

  it("agrees with the credential gate it stands in for", () => {
    // `loadIntegrationCreds().hasCreds` is `Boolean(accountId && apiToken)`. The fixture must not come to
    // a different answer, or a suite runs while the report says it cannot.
    const matrix: ReadonlyArray<[id: string | undefined, token: string | undefined]> = [
      [undefined, undefined],
      ["acct", undefined],
      [undefined, "tok"],
      ["", "tok"],
      ["acct", ""],
      ["acct", "tok"],
    ];
    for (const [id, token] of matrix) {
      const env = { CLOUDFLARE_ACCOUNT_ID: id, CLOUDFLARE_API_TOKEN: token };
      expect(fixtureReady("cloudflare-account", { env })).toBe(Boolean(id && token));
    }
  });
});

describe("every fixture points at a document that exists", () => {
  /**
   * #52's defect class, closed at the source. A skip message naming a document nobody wrote is worse than
   * no message: it sends a contributor looking for instructions that were never there, and this
   * repository has already spent a lane cleaning up citations of a deleted file.
   */
  const doc = readFileSync(fileURLToPath(new URL("../../../../docs/FIXTURES.md", import.meta.url)), "utf8");

  it.each(Object.values(LIVE_FIXTURES))("$name has a section in docs/FIXTURES.md", (fixture) => {
    const [path, anchor] = fixture.doc.split("#");
    expect(path).toBe("docs/FIXTURES.md");
    expect(doc).toContain(`\n## ${anchor}\n`);
  });

  it.each(Object.values(LIVE_FIXTURES))("$name's variables are named in its section", (fixture) => {
    const section = doc.split(`\n## ${fixture.doc.split("#")[1]}\n`)[1]?.split("\n## ")[0] ?? "";
    for (const key of fixture.keys) expect(section).toContain(key);
  });
});
