// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { PithyError } from "../error/pithyError";
import { createLogger } from "../logger/logger";
import type { LogRecord } from "../logger/record";
import {
  checkHostEnv,
  defineHostEnv,
  hostEnvFields,
  hostEnvProviderSentence,
  renderHostEnvProblems,
  requireHostEnv,
} from "./hostEnv";

/**
 * The host env contract: a capability host declares what it reads, says what fills each field, and
 * refuses to serve when any of it is unusable — naming the binding, var, secret or config key that
 * would fix it.
 */

/** A stand-in for a real host's env: two bindings, a var, a config blob, and one tuned number. */
const declaration = defineHostEnv({
  capability: "email",
  env: z.object({
    EMAIL_JOBS: z
      .unknown()
      .refine((value) => value !== undefined, "Required.")
      .describe("The jobs database."),
    BASE_URL: z.url().describe("The origin links in a sent message point back at."),
    EMAIL_THEME: z
      .string()
      .transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          ctx.addIssue({ code: "custom", message: "Not JSON." });
          return z.NEVER;
        }
      })
      .describe("The rendering theme, serialized."),
    MAX_ATTEMPTS: z.coerce.number().int().positive().optional().describe("How many times a send is retried."),
  }),
  provided: {
    EMAIL_JOBS: { kind: "binding", name: "EMAIL_JOBS", command: "pithy email provision --env dev" },
    BASE_URL: { kind: "var", name: "BASE_URL" },
    EMAIL_THEME: { kind: "config", name: "email.theme" },
    MAX_ATTEMPTS: { kind: "var", name: "MAX_ATTEMPTS" },
  },
});

/** A complete env for the declaration above. */
function usableEnv(): Record<string, unknown> {
  return {
    EMAIL_JOBS: { prepare: () => undefined },
    BASE_URL: "http://localhost:8787",
    EMAIL_THEME: '{"brand":"saffron"}',
    MAX_ATTEMPTS: "5",
  };
}

/** A logger that keeps every record, so the boot block can be read back. */
function capturingLogger(): { log: ReturnType<typeof createLogger>; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { log: createLogger({ level: "debug", sink: (record) => void records.push(record) }), records };
}

describe("defineHostEnv", () => {
  test("a field with nothing named as its provider is refused at declaration", () => {
    const declare = () =>
      defineHostEnv({
        capability: "media",
        env: z.object({
          MEDIA_DB: z.unknown().describe("The media database."),
          MEDIA_AI: z.unknown().describe("The Workers AI binding."),
        }),
        // Deliberately cast: the compile-time mapped type already refuses this, and the runtime
        // check has to hold for a declaration the CLI reads back off a package it did not compile.
        provided: { MEDIA_DB: { kind: "binding", name: "MEDIA_DB" } } as never,
      });

    expect(declare).toThrow(PithyError);
    try {
      declare();
    } catch (error) {
      // The unaccounted field is throw-site context, so it travels in `detail`, not on a wire.
      expect((error as PithyError).payload.detail).toContain("MEDIA_AI");
    }
  });
});

describe("checkHostEnv", () => {
  test("a usable env parses, and the parsed value is what the host runs on", () => {
    const report = checkHostEnv(declaration, usableEnv());
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.value?.EMAIL_THEME).toEqual({ brand: "saffron" });
    expect(report.value?.MAX_ATTEMPTS).toBe(5);
  });

  test("every unusable field is reported once, with what provides it", () => {
    const report = checkHostEnv(declaration, { EMAIL_THEME: "not json", MAX_ATTEMPTS: "fifty" });
    expect(report.ok).toBe(false);
    expect(report.value).toBeUndefined();
    expect(report.problems.map((problem) => problem.field).sort()).toEqual([
      "BASE_URL",
      "EMAIL_JOBS",
      "EMAIL_THEME",
      "MAX_ATTEMPTS",
    ]);

    const theme = report.problems.find((problem) => problem.field === "EMAIL_THEME");
    expect(theme?.provider).toEqual({ kind: "config", name: "email.theme" });
    expect(theme?.reason).toBe("Not JSON.");

    const jobs = report.problems.find((problem) => problem.field === "EMAIL_JOBS");
    expect(jobs?.provider.command).toBe("pithy email provision --env dev");
  });

  test("an env that is not an object at all is a problem per declared field, not a crash", () => {
    const report = checkHostEnv(declaration, undefined);
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
  });
});

describe("renderHostEnvProblems", () => {
  test("one block names the capability, each field, and the thing that fills it", () => {
    const report = checkHostEnv(declaration, { BASE_URL: "not a url" });
    const block = renderHostEnvProblems("email", report.problems);
    expect(block).toMatch(/^The email host cannot start\./);
    expect(block).toContain("BASE_URL");
    expect(block).toContain("Var BASE_URL");
    expect(block).toContain("Binding EMAIL_JOBS");
    expect(block).toContain("Run pithy email provision --env dev.");
    expect(block).toContain("Config key email.theme");
  });

  test("each kind names its own kind of thing", () => {
    expect(hostEnvProviderSentence({ kind: "binding", name: "EMAIL_JOBS" })).toBe(
      "Binding EMAIL_JOBS in the host's wrangler.jsonc.",
    );
    expect(hostEnvProviderSentence({ kind: "var", name: "BASE_URL" })).toBe(
      "Var BASE_URL in the host's wrangler.jsonc.",
    );
    expect(hostEnvProviderSentence({ kind: "secret", name: "EMAIL_SIGNING_KEY" })).toBe(
      "Secret EMAIL_SIGNING_KEY, read through @pithy-sh/secrets.",
    );
    expect(hostEnvProviderSentence({ kind: "config", name: "email.theme" })).toBe("Config key email.theme.");
  });
});

describe("requireHostEnv", () => {
  test("a usable env is parsed and handed back, and nothing is logged", () => {
    const { log, records } = capturingLogger();
    const value = requireHostEnv(declaration, usableEnv(), log);
    expect(value.BASE_URL).toBe("http://localhost:8787");
    expect(records).toEqual([]);
  });

  test("an unusable env logs one block, then refuses — the host does not wait to be asked", () => {
    const { log, records } = capturingLogger();
    const env = { BASE_URL: "nope" };
    expect(() => requireHostEnv(declaration, env, log)).toThrow(PithyError);

    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.level).toBe("error");
    expect(record?.msg).toContain("The email host cannot start.");
    expect(record?.msg).toContain("Binding EMAIL_JOBS");
  });

  test("the refusal is core/internal — the operator reads our logs to fix a config we cannot parse", () => {
    const { log } = capturingLogger();
    try {
      requireHostEnv(declaration, {}, log);
      expect.unreachable("requireHostEnv must refuse an env it cannot parse");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      const { payload } = error as PithyError;
      expect(payload.code).toBe("core/internal");
      expect(payload.status).toBe(500);
      // The block is the operator's, so it travels in `detail` — never on a wire toward a client.
      expect(payload.detail).toContain("BASE_URL");
      expect(payload.message).not.toContain("BASE_URL");
    }
  });

  test("the block is logged once per env, however many times a boot path asks", () => {
    const { log, records } = capturingLogger();
    const env = { BASE_URL: "nope" };
    expect(() => requireHostEnv(declaration, env, log)).toThrow(PithyError);
    expect(() => requireHostEnv(declaration, env, log)).toThrow(PithyError);
    expect(records).toHaveLength(1);
  });
});

describe("hostEnvFields", () => {
  test("the declaration reads statically, which is what pithy doctor needs", () => {
    const fields = hostEnvFields(declaration);
    expect(fields.map((field) => field.field)).toEqual(["EMAIL_JOBS", "BASE_URL", "EMAIL_THEME", "MAX_ATTEMPTS"]);

    const baseUrl = fields.find((field) => field.field === "BASE_URL");
    expect(baseUrl?.description).toBe("The origin links in a sent message point back at.");
    expect(baseUrl?.provider).toEqual({ kind: "var", name: "BASE_URL" });
    expect(baseUrl?.optional).toBe(false);

    expect(fields.find((field) => field.field === "MAX_ATTEMPTS")?.optional).toBe(true);
  });
});
