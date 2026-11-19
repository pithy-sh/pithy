// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { linkKitPackages } from "../test-utils/linkKit";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";

/**
 * `pithy init` with a rail named. The composition is `runAdd`'s, run for real against the kit's own packages,
 * linked in the way a checkout provides them; only the package manager, the migrate and the dev-secret bootstrap
 * are stood in for, because `capabilities/flow.test.ts` holds those and none of them is what this file proves.
 */
const composed = vi.hoisted(() => ({ calls: 0, packageManager: undefined as string | undefined }));
vi.mock("../project/initPayments", async (importOriginal) => {
  const real = await importOriginal<typeof import("../project/initPayments")>();
  return {
    ...real,
    composeInitPayments: (options: Parameters<typeof real.composeInitPayments>[0]) => {
      composed.calls += 1;
      composed.packageManager = options.packageManager;
      return real.composeInitPayments({
        ...options,
        steps: {
          install: async ({ projectDir, pkg }) => {
            await linkKitPackages(projectDir, ["core", pkg.replace("@pithy-sh/", "")]);
            return { packageManager: "bun" };
          },
          declare: async () => [],
          migrate: async () => [],
          sync: async () => {},
          bootstrap: async () => [],
        },
      });
    },
  };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-init-rails-"));
  composed.calls = 0;
  composed.packageManager = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** Run `pithy init` expecting a refusal: the exit code it asked for, and what it wrote to stderr. */
async function refused(args: string[]): Promise<{ code: unknown; stderr: string }> {
  const stderr: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  let code: unknown;
  const exit = vi.spyOn(process, "exit").mockImplementation((value) => {
    code = value;
    throw new Error("exited");
  });
  try {
    await runCaptured("init", args).catch(() => undefined);
  } finally {
    write.mockRestore();
    exit.mockRestore();
  }
  return { code, stderr: stderr.join("") };
}

describe("pithy init with a rail named", () => {
  test("--ios-rail apple --android-rail google composes payments with exactly those rails, and the app sells through them", async () => {
    const target = join(dir, "phone");
    const written = await runCaptured("init", [
      "--dir",
      target,
      "--name",
      "acme",
      "--target",
      "mobile",
      "--react-native",
      "--ios-rail",
      "apple",
      "--android-rail",
      "google",
      "--billing-subject",
      "user",
      "--json",
    ]);
    const payload = JSON.parse(written.join("")) as {
      reactNative: { rails: Record<string, string> };
      selling: { billingSubject: string; rails: string[]; prerequisites: string[] };
    };
    expect(payload.reactNative.rails).toEqual({ ios: "apple", android: "google", web: "none" });
    expect(payload.selling).toMatchObject({
      billingSubject: "user",
      rails: ["apple", "google"],
      prerequisites: ["secrets"],
    });
    const config = await readFile(join(target, "apps", "api", "pithy.config.ts"), "utf8");
    expect(config).toContain('billingSubject: "user",');
    expect(config).toContain("rails: { apple: true, google: true },");
    expect(config).toMatch(/^\s*secrets\(/m);
    const generated = await readFile(join(target, "apps", "app", "src", "pithy-config.generated.ts"), "utf8");
    expect(generated).toMatch(/ios: "apple"/);
    expect(generated).toMatch(/android: "google"/);
    await expectConforms("init", written);
  }, 60_000);

  test("--web-rail stripe turns on stripe for the web build, with its return URLs on PUBLIC_ORIGIN", async () => {
    const target = join(dir, "web");
    const written = await runCaptured("init", [
      "--dir",
      target,
      "--name",
      "acme",
      "--web-rail",
      "stripe",
      "--billing-subject",
      "user",
      "--json",
    ]);
    const payload = JSON.parse(written.join("")) as { reactNative: { rails: Record<string, string> } };
    expect(payload.reactNative.rails).toEqual({ ios: "none", android: "none", web: "stripe" });
    const config = await readFile(join(target, "apps", "api", "pithy.config.ts"), "utf8");
    expect(config).toContain("rails: { stripe: true },");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated config's template literal, uninterpolated.
    expect(config).toContain("successUrl: `${PUBLIC_ORIGIN}/thanks?session={CHECKOUT_SESSION_ID}`,");
  }, 60_000);

  test("payments installs through the runner that launched pithy, not the npm a missing lockfile implies", async () => {
    vi.stubEnv("npm_config_user_agent", "bun/1.3.0 npm/? node/v24.0.0 linux arm64");
    await runCaptured("init", [
      "--dir",
      join(dir, "bunned"),
      "--name",
      "acme",
      "--web-rail",
      "stripe",
      "--billing-subject",
      "user",
      "--json",
    ]);
    expect(composed.packageManager).toBe("bun");
  }, 60_000);

  test("a person reads what was composed, before Done.", async () => {
    const target = join(dir, "spoken");
    const output = (
      await runCaptured("init", [
        "--dir",
        target,
        "--name",
        "acme",
        "--ios-rail",
        "apple",
        "--billing-subject",
        "user",
        "--no-input",
      ])
    ).join("");
    expect(output).toContain("Composed secrets into api first — payments requires it.");
    expect(output).toContain("Wired payments into api. It sells through apple.");
    expect(output.indexOf("Wired payments")).toBeLessThan(output.indexOf("Done."));
  }, 60_000);

  test("a rail without --billing-subject under --json is refused before anything is written, naming the flag", async () => {
    const target = join(dir, "unsubjected");
    const { code, stderr } = await refused(["--dir", target, "--name", "acme", "--ios-rail", "apple", "--json"]);
    expect(code).toBe(2);
    const error = (JSON.parse(stderr) as { error: { code: string; flag: string; action: string } }).error;
    expect(error).toMatchObject({ code: "input/required", flag: "--billing-subject" });
    expect(error.action).toBe("Pass --billing-subject user or --billing-subject organization.");
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
    expect(composed.calls).toBe(0);
  });

  test("--billing-subject with no rail, or with every rail none, is refused: it only applies with a rail", async () => {
    for (const [name, rails] of [
      ["alone", []],
      ["none", ["--ios-rail", "none", "--android-rail", "none", "--web-rail", "none"]],
    ] as const) {
      const target = join(dir, name);
      const { code, stderr } = await refused([
        "--dir",
        target,
        "--name",
        "acme",
        ...rails,
        "--billing-subject",
        "user",
        "--json",
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain("--billing-subject only applies with a rail, and no rail flag names one.");
      await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
    }
  });

  test("a billing subject payments does not take is refused before anything is written", async () => {
    const target = join(dir, "team");
    const { code, stderr } = await refused([
      "--dir",
      target,
      "--name",
      "acme",
      "--ios-rail",
      "apple",
      "--billing-subject",
      "team",
      "--json",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("Pass --billing-subject user or organization.");
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("paddle is refused before anything is written: init cannot know its client token", async () => {
    const target = join(dir, "paddle");
    const { code, stderr } = await refused([
      "--dir",
      target,
      "--name",
      "acme",
      "--web-rail",
      "paddle",
      "--billing-subject",
      "user",
      "--json",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("init can't turn on the paddle rail.");
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("a store rail on the wrong platform is refused before anything is written", async () => {
    const target = join(dir, "wrong");
    const { code, stderr } = await refused([
      "--dir",
      target,
      "--name",
      "acme",
      "--ios-rail",
      "google",
      "--billing-subject",
      "user",
      "--json",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("Pass --ios-rail apple, stripe, lemonSqueezy, paddle or none.");
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("a rail with --no-react-native is refused: there is no app to sell through", async () => {
    const target = join(dir, "no-app");
    const { code, stderr } = await refused([
      "--dir",
      target,
      "--name",
      "acme",
      "--no-react-native",
      "--ios-rail",
      "apple",
      "--billing-subject",
      "user",
      "--json",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("--no-react-native leaves it out.");
    await expect(readFile(join(target, "pithy.config.ts"), "utf8")).rejects.toThrow();
  });

  test("every rail none composes nothing, as init without rail flags does", async () => {
    const target = join(dir, "plain");
    const written = await runCaptured("init", [
      "--dir",
      target,
      "--name",
      "acme",
      "--ios-rail",
      "none",
      "--android-rail",
      "none",
      "--json",
    ]);
    const payload = JSON.parse(written.join("")) as { selling: unknown; reactNative: { rails: unknown } };
    expect(payload.selling).toBeNull();
    expect(payload.reactNative.rails).toEqual({ ios: "none", android: "none", web: "none" });
    expect(await readFile(join(target, "apps", "api", "pithy.config.ts"), "utf8")).not.toContain("payments(");
    expect(composed.calls).toBe(0);
  });
});
