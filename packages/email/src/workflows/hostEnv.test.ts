// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { checkHostEnv, hostEnvFields, requireHostEnv } from "@pithy-sh/core/src/workflow/hostEnv";
import { describe, expect, test } from "vitest";
import { defaultTheme } from "../templates/theme";
import { EmailHostEnv, emailHostEnv } from "./hostEnv";

/**
 * What the email host reads, and what happens when one of it is missing or unusable.
 *
 * The three failures this closes are named in pithy-sh/pithy#410 and every one of them used to be
 * discovered as a mail that did not arrive: a missing `BASE_URL` rendered a magic link to
 * `undefined/…`, an unparseable `EMAIL_THEME` threw three retries deep inside a render step, and a
 * `SCHEDULER_BATCH_SIZE` somebody typed as `"fifty"` became `NaN`, after which the scheduler claimed
 * nothing, quietly, forever. So the assertions here are about the *report*, not merely the refusal:
 * the field, and the thing an operator changes to fix it.
 */

/** A logger that says nothing — the boot check writes its block before it throws, and most tests read the throw. */
function silentLog(): Logger {
  const log: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => log,
  };
  return log;
}

/** A D1 binding, structurally — the host only ever asks whether it can `prepare`. */
const d1 = () => ({ prepare: () => ({}) });

/** Everything a healthy host is handed. Vars arrive as strings, exactly as wrangler binds them. */
function completeEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: d1(),
    EMAIL_SUPPRESSIONS: d1(),
    SECRETS: d1(),
    SECRETS_ENCRYPTION_KEYS: '{"current":"v1","keys":{"v1":"k"}}',
    EMAIL: { send: async () => ({}) },
    EMAIL_SENDER: { create: async () => ({}), get: async () => ({}) },
    EMAIL_SCHEDULER: { create: async () => ({}) },
    BASE_URL: "https://api.acme.test",
    ENVIRONMENT: "staging",
    ...overrides,
  };
}

describe("the email host's env declaration", () => {
  test("every field it declares is one an operator can be told how to fill", () => {
    const fields = hostEnvFields(emailHostEnv);

    // The declaration is what `pithy doctor` reports from (#411), so an unaccounted field is not a
    // cosmetic gap — it is a row in that report with nothing actionable in it.
    expect(fields.map((field) => field.field)).toEqual(Object.keys(EmailHostEnv.shape));
    expect(fields.filter((field) => !field.description)).toEqual([]);
    expect(fields.filter((field) => field.provider.name.length === 0)).toEqual([]);
  });

  test("the fields a host cannot invent are required, and the tuned ones are not", () => {
    const required = hostEnvFields(emailHostEnv)
      .filter((field) => !field.optional)
      .map((field) => field.field);

    // Bindings and the base URL: nothing here has a sensible stand-in, and every one of them is
    // written by `pithy email provision`.
    expect(required).toEqual([
      "DB",
      "EMAIL_SUPPRESSIONS",
      "SECRETS",
      "SECRETS_ENCRYPTION_KEYS",
      "EMAIL",
      "EMAIL_SENDER",
      "EMAIL_SCHEDULER",
      "BASE_URL",
    ]);
  });
});

describe("a healthy env parses into the shape the host runs on", () => {
  test("the numbers are numbers, the flag is a boolean, and an absent theme is the default", () => {
    const report = checkHostEnv(emailHostEnv, completeEnv());

    expect(report.ok).toBe(true);
    expect(report.value).toMatchObject({
      LINK_TTL_DAYS: 90,
      MAX_ATTEMPTS: 5,
      SCHEDULER_ENABLED: true,
      SCHEDULER_BATCH_SIZE: 50,
      SCHEDULER_MAX_JOBS: 500,
      SCHEDULER_GRACE_MS: 120_000,
      SCHEDULER_STUCK_MS: 900_000,
      EMAIL_THEME: defaultTheme,
    });
  });

  test("the tuned strings wrangler binds are coerced, not read raw", () => {
    const report = checkHostEnv(
      emailHostEnv,
      completeEnv({ MAX_ATTEMPTS: "3", SCHEDULER_ENABLED: "false", SCHEDULER_GRACE_MS: "30000" }),
    );

    expect(report.value).toMatchObject({ MAX_ATTEMPTS: 3, SCHEDULER_ENABLED: false, SCHEDULER_GRACE_MS: 30_000 });
  });

  test("EMAIL_THEME arrives as one JSON var and leaves as a validated theme", () => {
    const theme = { ...defaultTheme, appName: "Acme" };
    const report = checkHostEnv(emailHostEnv, completeEnv({ EMAIL_THEME: JSON.stringify(theme) }));

    expect(report.ok).toBe(true);
    expect(report.value?.EMAIL_THEME).toEqual(theme);
  });
});

describe("an unusable env names the field and what fills it", () => {
  test("a missing BASE_URL is reported against the var that carries it", () => {
    const { BASE_URL: _dropped, ...withoutBaseUrl } = completeEnv();
    const report = checkHostEnv(emailHostEnv, withoutBaseUrl);

    expect(report.ok).toBe(false);
    expect(report.value).toBeUndefined();
    const problem = report.problems.find((entry) => entry.field === "BASE_URL");
    expect(problem?.provider).toMatchObject({ kind: "var", name: "BASE_URL" });
    expect(problem?.provider.command).toContain("pithy email provision");
  });

  test('a SCHEDULER_BATCH_SIZE of "fifty" is a refusal, not a NaN the scheduler swallows', () => {
    const report = checkHostEnv(emailHostEnv, completeEnv({ SCHEDULER_BATCH_SIZE: "fifty" }));

    expect(report.ok).toBe(false);
    expect(report.problems.map((problem) => problem.field)).toEqual(["SCHEDULER_BATCH_SIZE"]);
  });

  test("an EMAIL_THEME that is not JSON fails here rather than inside a render step", () => {
    const report = checkHostEnv(emailHostEnv, completeEnv({ EMAIL_THEME: "{not json" }));

    expect(report.problems.map((problem) => problem.field)).toEqual(["EMAIL_THEME"]);
    // Reported against the config key, not the var: the var is generated, and correcting it in place
    // is undone by the next provision run.
    expect(report.problems[0]?.provider).toMatchObject({ kind: "config", name: "email({ theme, customTheme })" });
  });

  test("an EMAIL_THEME that is JSON but not a theme is caught too", () => {
    const report = checkHostEnv(emailHostEnv, completeEnv({ EMAIL_THEME: '{"appName":7}' }));

    expect(report.problems.map((problem) => problem.field)).toEqual(["EMAIL_THEME"]);
  });

  test("a binding that was never wired is one problem, named by its binding", () => {
    const { EMAIL_SUPPRESSIONS: _dropped, ...withoutSuppressions } = completeEnv();
    const report = checkHostEnv(emailHostEnv, withoutSuppressions);

    const problem = report.problems.find((entry) => entry.field === "EMAIL_SUPPRESSIONS");
    expect(problem?.provider).toMatchObject({ kind: "binding", name: "EMAIL_SUPPRESSIONS" });
  });

  test("several unusable settings are reported together, in declaration order, one line each", () => {
    const { BASE_URL: _dropped, ...rest } = completeEnv();
    const report = checkHostEnv(emailHostEnv, { ...rest, MAX_ATTEMPTS: "lots" });

    // The whole block, not the first failure: an operator fixing one thing per restart is how a
    // five-minute repair becomes an afternoon.
    expect(report.problems.map((problem) => problem.field)).toEqual(["BASE_URL", "MAX_ATTEMPTS"]);
  });
});

describe("the boot check", () => {
  test("a healthy env hands back the parsed shape", () => {
    const value = requireHostEnv(emailHostEnv, completeEnv(), silentLog());

    expect(value.BASE_URL).toBe("https://api.acme.test");
    expect(value.SCHEDULER_BATCH_SIZE).toBe(50);
  });

  test("an unusable env logs the block once and refuses before the host serves anything", () => {
    const logged: string[] = [];
    const log: Logger = { ...silentLog(), error: (message: string) => void logged.push(message) };
    const { BASE_URL: _dropped, ...broken } = completeEnv();

    expect(() => requireHostEnv(emailHostEnv, broken, log)).toThrow(/email host is not configured/);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("BASE_URL");
    expect(logged[0]).toContain("pithy email provision");
  });
});
