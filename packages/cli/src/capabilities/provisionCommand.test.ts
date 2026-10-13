// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workerDirOf } from "@pithy-sh/core/src/cli/command";
import { describe, expect, test } from "vitest";
import { buildDocsCatalog } from "../docs/catalog";
import { capabilityProvisionRemedies, capabilityProvisionRemedy, remediesSentence } from "./provisionCommand";

/**
 * **A capability's provision, named so it runs as written (#711).** `pithy deploy --kit` skipped a host with
 * `Run pithy <capability> provision.`, which a project with two Workers refuses `input/required` for want of
 * `--worker`. The builder names the Worker wherever the command takes one, and only there.
 */
const api = workerDirOf({ dir: "/p/apps/api" });
const fixOf = (capability: string, env: string | undefined) => capabilityProvisionRemedy(capability, api, env, []).fix;

describe("capabilityProvisionRemedy", () => {
  test("names the Worker by its apps/ directory", () => {
    expect(fixOf("email", "staging")).toBe("pithy email provision --worker api");
  });

  // Secrets' provision is the project's, so it names no Worker — and it runs against every environment, production
  // included, whatever environment is in hand: a person's decision, with no fix (#711).
  test("names no Worker and no fix for secrets, whose provision is the project's and spans production", () => {
    const remedy = capabilityProvisionRemedy("secrets", api, "staging", []);
    expect(remedy.fix).toBeUndefined();
    expect(remedy.say((command) => `Run ${command}.`)).toBe(
      "`pithy secrets provision` runs against every environment, production included. That is a person's decision, not a fix.",
    );
  });

  // `vector provision` acts on one environment and defaults to dev. Named without `--env`, a staging skip sent
  // the caller to a provision of dev that exited 0, and the next staging deploy skipped again.
  test("names the environment for a provision that takes one", () => {
    expect(fixOf("vector", "staging")).toBe("pithy vector provision --worker api --env staging");
    expect(fixOf("testers", "staging")).toBe("pithy testers provision --worker api --env staging");
  });

  test("refuses to leave a defaulted environment to its default", () => {
    expect(() => fixOf("vector", undefined)).toThrow(/acts on dev/);
  });

  // With no environment in hand, `testers provision` acts on every one, production included (#711).
  test("names no fix for a provision that spans every environment, production included, where none is in hand", () => {
    expect(fixOf("testers", undefined)).toBeUndefined();
  });

  test("a provision against production is a person's decision, with no fix", () => {
    const remedy = capabilityProvisionRemedy("vector", api, "prod", []);
    expect(remedy.fix).toBeUndefined();
    expect(remedy.say((command) => `Run ${command}.`)).toMatch(/person's decision/);
  });

  // The adopter's own capability, or one newer than this CLI: no command to name, and a crash in a refusal's
  // sentence would hide the refusal. The line says the binding is the adopter's to make.
  test("names no command for a capability the CLI has no provision for, and says what is left", () => {
    const remedy = capabilityProvisionRemedy("rating", api, undefined, []);
    expect(remedy.fix).toBeUndefined();
    expect(remedy.say((command) => `Run ${command}.`)).toBe(
      "No pithy command provisions rating; bind what it needs by hand in each environment's wrangler.jsonc.",
    );
  });

  // Every `<capability> provision` the CLI has, against the flags it declares: `--worker` and `--env` exactly where
  // each is one.
  test("every flag it names is one the command declares, and --worker and --env wherever each is declared", async () => {
    const catalog = await buildDocsCatalog();
    const provisions = catalog.commands.filter((one) => /^[a-z]+ provision$/.test(one.path));
    expect(provisions.length).toBeGreaterThan(5);
    for (const { path, flags } of provisions) {
      const capability = path.split(" ")[0] as string;
      // One that always spans production is a person's decision, named in the sentence above, with no fix to read.
      if (path === "secrets provision") continue;
      const [pithy, ...words] = (fixOf(capability, "staging") ?? "").split(" ");
      expect(pithy).toBe("pithy");
      expect(words.slice(0, 2).join(" ")).toBe(path);
      const named = words.filter((word) => word.startsWith("--"));
      for (const flag of named) expect(flags, `${path} ${flag}`).toContain(flag);
      expect(named.includes("--worker"), path).toBe(flags.includes("--worker"));
      expect(named.includes("--env"), path).toBe(flags.includes("--env"));
      if (named.includes("--env")) expect(words[words.indexOf("--env") + 1], path).toBe("staging");
    }
  });
});

/**
 * **A line about no single environment (#711).** Doctor reads files, so a declined `VECTOR_REPROCESS` is about
 * every environment the Worker has. `vector provision` acts on one, so it is named once for each; a provision
 * that spans them is named once.
 */
describe("capabilityProvisionRemedies", () => {
  test("names a one-environment provision once per environment, production as a person's decision", () => {
    const remedies = capabilityProvisionRemedies("vector", api, ["dev", "staging", "prod"], []);
    expect(remedies.map((one) => one.fix)).toEqual([
      "pithy vector provision --worker api --env dev",
      "pithy vector provision --worker api --env staging",
      undefined,
    ]);
  });

  test("names a provision that spans every environment once, without --env", () => {
    expect(capabilityProvisionRemedies("email", api, ["dev", "prod"], []).map((one) => one.fix)).toEqual([
      "pithy email provision --worker api",
    ]);
  });

  // Bare, `testers provision` runs against every environment, production included (#711): named per deployed
  // environment, staging is a fix and prod a person's decision, and nothing names the bare command as a fix.
  test("names a provision that acts on every environment without --env once per deployed environment", () => {
    const remedies = capabilityProvisionRemedies("testers", api, ["dev", "staging", "prod"], []);
    expect(remedies.map((one) => one.fix)).toEqual(["pithy testers provision --worker api --env staging", undefined]);
    expect(remediesSentence(remedies)).toBe(
      "Run `pithy testers provision --worker api --env staging`. `pithy testers provision --worker api --env prod` runs against prod, a production environment. That is a person's decision, not a fix.",
    );
    const bare = capabilityProvisionRemedies("testers", api, [], []);
    expect(bare.map((one) => one.fix)).toEqual([undefined]);
    expect(remediesSentence(bare)).toMatch(
      /runs against every environment, production included\. That is a person's decision/,
    );
  });
});

/**
 * **Several remedies as one line (#711)**: the commands that run joined into one `Run …`, each person's decision in a
 * sentence of its own after it. Each branch on its own: a regression that dropped the decisions would name staging
 * and leave prod out in silence, and one that kept the `Run` clause for none would print `Run .`.
 */
describe("remediesSentence", () => {
  const vector = (envs: string[], production: string[] = []) =>
    remediesSentence(capabilityProvisionRemedies("vector", api, envs, production));
  const decision = (env: string) =>
    `\`pithy vector provision --worker api --env ${env}\` runs against ${env}, a production environment. That is a person's decision, not a fix.`;

  test("commands and decisions: the commands first, in one sentence, then each decision", () => {
    expect(vector(["dev", "staging", "prod"])).toBe(
      `Run \`pithy vector provision --worker api --env dev\` and \`pithy vector provision --worker api --env staging\`. ${decision("prod")}`,
    );
  });

  test("commands alone: one Run sentence, and nothing after it", () => {
    expect(vector(["dev"])).toBe("Run `pithy vector provision --worker api --env dev`.");
    expect(vector(["dev", "staging"])).toBe(
      "Run `pithy vector provision --worker api --env dev` and `pithy vector provision --worker api --env staging`.",
    );
  });

  test("decisions alone: no Run clause at all, each decision in its own sentence", () => {
    expect(vector(["prod", "live"], ["live"])).toBe(`${decision("prod")} ${decision("live")}`);
  });

  test("nothing to name is the empty string, which a caller branches on", () => {
    expect(remediesSentence([])).toBe("");
    expect(vector([])).toBe("");
  });
});
