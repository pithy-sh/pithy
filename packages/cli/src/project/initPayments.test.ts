// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputRequiredError, PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { linkKitPackages } from "../test-utils/linkKit";
import {
  askBillingSubject,
  composeInitPayments,
  initBackendRails,
  parseBillingSubject,
  parseInitRails,
  soldRails,
  withRailSettings,
} from "./initPayments";
import { DEFAULT_WORKER, scaffoldProject } from "./scaffold";

/** The prompts, scripted. Anything the script does not answer throws rather than guessing. */
function selecting(answer: string | symbol) {
  return {
    select: vi.fn(async () => answer),
    isCancel: (value: unknown) => typeof value === "symbol",
  };
}

describe("parseInitRails", () => {
  test("parses each flag against its platform, and leaves an unflagged platform out", () => {
    expect(parseInitRails({ ios: "apple", web: "stripe" })).toEqual({ ios: "apple", web: "stripe" });
  });

  test("a rail the platform cannot sell through is refused, naming the ones it can", () => {
    try {
      parseInitRails({ web: "google" });
      expect.unreachable();
    } catch (thrown) {
      expect((thrown as PithyError).payload.action).toBe("Pass --web-rail stripe, lemonSqueezy, paddle or none.");
    }
  });

  test("paddle is refused on any platform, because its client token is the adopter's to give", () => {
    for (const platform of ["ios", "android", "web"] as const) {
      let caught: unknown;
      try {
        parseInitRails({ [platform]: "paddle" });
      } catch (thrown) {
        caught = thrown;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      const error = caught as ValidationError;
      expect(error.message).toBe("init can't turn on the paddle rail. It needs your Paddle client token.");
      expect(error.payload.action).toContain(`--${platform}-rail`);
      expect(error.payload.action).toContain("rails.paddle");
    }
  });
});

describe("soldRails", () => {
  test("each rail once, in the order payments lists them, without none", () => {
    expect(soldRails({ ios: "stripe", android: "google", web: "stripe" })).toEqual(["google", "stripe"]);
    expect(soldRails({ ios: "none", android: "none" })).toEqual([]);
    expect(soldRails({})).toEqual([]);
  });
});

describe("initBackendRails", () => {
  test("composes payments and enables exactly the rails sold", () => {
    expect(initBackendRails(["apple", "google"])).toEqual({
      composed: true,
      enabled: { apple: true, google: true, stripe: false, lemonSqueezy: false, paddle: false },
    });
  });

  test("with nothing sold the Worker composes nothing, as a new one does", () => {
    expect(initBackendRails([])).toEqual({
      composed: false,
      enabled: { apple: false, google: false, stripe: false, lemonSqueezy: false, paddle: false },
    });
  });
});

describe("parseBillingSubject", () => {
  test("takes user and organization", () => {
    expect(parseBillingSubject("user")).toBe("user");
    expect(parseBillingSubject("organization")).toBe("organization");
  });

  test("refuses anything else, naming the two", () => {
    expect(() => parseBillingSubject("team")).toThrow(ValidationError);
    expect(() => parseBillingSubject("team")).toThrow('"team" is not a billing subject.');
    try {
      parseBillingSubject("team");
    } catch (thrown) {
      expect((thrown as PithyError).payload.action).toBe("Pass --billing-subject user or organization.");
    }
  });
});

describe("askBillingSubject", () => {
  test("a flag with no rail sold is refused: it only applies with one", async () => {
    let caught: unknown;
    try {
      await askBillingSubject({ flag: "user", sold: [], prompt: selecting("user") });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as PithyError).message).toBe(
      "--billing-subject only applies with a rail, and no rail flag names one.",
    );
  });

  test("nothing sold and no flag asks nothing and answers nothing", async () => {
    const prompt = selecting("user");
    expect(await askBillingSubject({ sold: [], prompt })).toEqual({ value: null, prompted: false });
    expect(prompt.select).not.toHaveBeenCalled();
  });

  test("a flag decides without a question", async () => {
    const prompt = selecting("user");
    expect(await askBillingSubject({ flag: "organization", sold: ["apple"], prompt })).toEqual({
      value: "organization",
      prompted: false,
    });
    expect(prompt.select).not.toHaveBeenCalled();
  });

  test("a run that may not ask is refused, naming --billing-subject and its two values", async () => {
    let caught: unknown;
    try {
      await askBillingSubject({ sold: ["apple"] });
    } catch (thrown) {
      caught = thrown;
    }
    expect(caught).toBeInstanceOf(InputRequiredError);
    const error = caught as InputRequiredError;
    expect(error.payload).toMatchObject({ code: "input/required", flag: "--billing-subject" });
    expect(error.payload.choices).toEqual(["user", "organization"]);
    expect(error.payload.action).toBe("Pass --billing-subject user or --billing-subject organization.");
  });

  test("a human is asked with no default: the first entry is no answer", async () => {
    const prompt = selecting("user");
    expect(await askBillingSubject({ sold: ["stripe"], prompt })).toEqual({
      value: "user",
      prompted: true,
    });
    const [request] = prompt.select.mock.calls[0] as unknown as [{ options: { value: string }[] }];
    expect(request.options.map((option) => option.value)).toEqual(["", "user", "organization"]);
  });

  test("enter on the first entry is refused as no answer, the way --json is", async () => {
    await expect(askBillingSubject({ sold: ["stripe"], prompt: selecting("") })).rejects.toThrow(InputRequiredError);
  });
});

/** A payments registration as `pithy add payments` renders it into the scaffold. */
const REGISTERED = [
  "export const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);",
  "",
  "export default {",
  "  capabilities: [",
  "    secrets({",
  "      registry: {},",
  "    }),",
  "    payments({",
  "      // Where the payments routes mount.",
  '      basePath: "/payments",',
  '      billingSubject: "user",',
  "    }),",
  "    // pithy:capabilities (managed region — do not remove this marker)",
  "  ],",
  "};",
  "",
].join("\n");

describe("withRailSettings", () => {
  test("store rails are switched on and need nothing else", () => {
    const written = withRailSettings(REGISTERED, ["apple", "google"]);
    expect(written).toContain(
      [
        '      billingSubject: "user",',
        "      // Which stores this project sells through. Every rail is off until named.",
        "      rails: { apple: true, google: true },",
        "    }),",
      ].join("\n"),
    );
    expect(written).not.toContain("stripe:");
  });

  test("stripe gets its return URLs, built on PUBLIC_ORIGIN", () => {
    const written = withRailSettings(REGISTERED, ["stripe"]);
    expect(written).toContain("      rails: { stripe: true },");
    expect(written).toContain(
      [
        "      stripe: {",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated config's template literal, uninterpolated.
        "        successUrl: `${PUBLIC_ORIGIN}/thanks?session={CHECKOUT_SESSION_ID}`,",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated config's template literal, uninterpolated.
        "        cancelUrl: `${PUBLIC_ORIGIN}/pricing`,",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated config's template literal, uninterpolated.
        "        portalReturnUrl: `${PUBLIC_ORIGIN}/account`,",
        "      },",
        "    }),",
      ].join("\n"),
    );
  });

  test("lemonSqueezy gets its one return URL", () => {
    const written = withRailSettings(REGISTERED, ["lemonSqueezy"]);
    expect(written).toContain("      rails: { lemonSqueezy: true },");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the generated config's template literal, uninterpolated.
    expect(written).toContain("      lemonSqueezy: { successUrl: `${PUBLIC_ORIGIN}/thanks` },");
  });

  test("touches nothing outside the payments registration", () => {
    const written = withRailSettings(REGISTERED, ["apple"]);
    expect(written.replace(/ {6}\/\/ Which stores[^\n]*\n {6}rails: [^\n]*\n/, "")).toBe(REGISTERED);
  });

  test("a config that does not register payments as a block is an internal fault, not a guess", () => {
    expect(() => withRailSettings("export default { capabilities: [] };\n", ["apple"])).toThrow(PithyError);
    expect(() => withRailSettings("    payments(),\n", ["apple"])).toThrow(PithyError);
  });

  test("a hosted rail in a config with no PUBLIC_ORIGIN is refused rather than written against nothing", () => {
    const without = REGISTERED.replace(/^export const PUBLIC_ORIGIN[^\n]*\n/m, "");
    expect(() => withRailSettings(without, ["stripe"])).toThrow(PithyError);
    // A store rail needs no origin, so it is still written.
    expect(withRailSettings(without, ["apple"])).toContain("rails: { apple: true },");
  });
});

describe("composeInitPayments", () => {
  let dir: string;
  let worker: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-init-payments-"));
    await scaffoldProject({ targetDir: dir, appName: "acme" });
    worker = join(dir, "apps", DEFAULT_WORKER);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Install by linking the kit's own package, the way a linked checkout provides it. */
  const install = async ({ projectDir, pkg }: { projectDir: string; pkg: string }) => {
    await linkKitPackages(projectDir, [pkg.replace("@pithy-sh/", "")]);
    return { packageManager: "bun" as const };
  };

  test("composes payments and its prerequisites the way pithy add does, then turns on exactly the rails named", async () => {
    const migrate = vi.fn(async () => []);
    const loaded = { capabilities: [] };
    const load = vi.fn(async () => loaded);
    const result = await composeInitPayments({
      projectDir: dir,
      workerDir: worker,
      worker: DEFAULT_WORKER,
      project: "acme",
      account: null,
      billingSubject: "user",
      rails: ["apple", "google"],
      steps: {
        install,
        declare: async () => [],
        migrate,
        sync: async () => {},
        bootstrap: async () => [],
        load,
      },
    });

    const config = await readFile(join(worker, "pithy.config.ts"), "utf8");
    expect(config).toContain('import { payments } from "@pithy-sh/payments/src/index";');
    expect(config).toContain('import { secrets } from "@pithy-sh/secrets/src/index";');
    expect(config).toContain('billingSubject: "user",');
    expect(config).toContain("rails: { apple: true, google: true },");
    expect(result.prerequisites).toEqual(["secrets"]);
    // Each add ran to its end, prerequisites included.
    expect(migrate).toHaveBeenCalled();
    // The config handed back is the Worker's as it now stands, read after the rails were written.
    expect(load).toHaveBeenCalledWith(worker);
    expect(result.config).toBe(loaded);
  });

  test("runs every install through the manager it is handed, so a project with no lockfile never becomes an npm one", async () => {
    const commands: string[] = [];
    await composeInitPayments({
      projectDir: dir,
      workerDir: worker,
      worker: DEFAULT_WORKER,
      project: "acme",
      account: null,
      billingSubject: "user",
      rails: ["apple"],
      packageManager: "bun",
      steps: {
        run: async (command, args) => {
          commands.push(`${command} ${args.join(" ")}`);
          const pkg = args.at(-1) ?? "";
          await linkKitPackages(dir, [pkg.replace("@pithy-sh/", "")]);
        },
        declare: async () => [],
        migrate: async () => [],
        sync: async () => {},
        bootstrap: async () => [],
        load: async () => ({ capabilities: [] }),
      },
    });

    expect(commands).toEqual(["bun add @pithy-sh/payments", "bun add @pithy-sh/secrets"]);
  });
});
