// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENERATED_CONFIG_PATH,
  type GeneratedConfig,
  readGeneratedConfig,
  renderGeneratedConfig,
} from "@pithy-sh/ui-react-native/src/generatedConfig";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveTemplateSource } from "../project/scaffold";

/**
 * **A `pithy-config.generated.ts` Pithy writes is a file the Biome `pithy init` scaffolds passes as it is, and one
 * that Biome has reformatted is still a file Pithy reads.** The gate runs the adopter's own toolchain: the starter's
 * `biome.jsonc` verbatim, over the file `pithy ui add react-native` and `pithy ui sync --app` write.
 */

/** The starter, resolved the way `pithy init` resolves it. */
const STARTER = resolveTemplateSource(import.meta.dirname).dir;

/** The workspace's Biome, four up from `packages/cli/src/ui`. */
const BIOME = join(import.meta.dirname, "..", "..", "..", "..", "node_modules", ".bin", "biome");

const composed: GeneratedConfig = {
  origins: { dev: "http://localhost:8787", staging: null, prod: "https://api.example.com" },
  appScheme: "demo",
  universalLinkOrigin: "https://app.example.com",
  rails: { ios: "apple", android: "google", web: "stripe" },
  google: { webClientId: null, iosClientId: null },
  workerPaths: ["/auth", "/health", "/organizations"],
  auth: { enabled: true, basePath: "/auth", otpLength: 6 },
  i18n: { enabled: false },
  payments: { enabled: false },
  turnstile: { enabled: false },
};

/** A config with every shape a projection can hold: nested objects, arrays short and long, a key that needs quotes. */
const projected: GeneratedConfig = {
  ...composed,
  google: { webClientId: "123-abc.apps.googleusercontent.com", iosClientId: null },
  auth: {
    enabled: true,
    basePath: "/auth",
    providers: ["google", "apple", "github"],
    otp: { length: 6, expiresIn: 300 },
    "x-device-header": "x-pithy-device-id",
    trustedOrigins: [
      "https://app.example.com",
      "https://admin.example.com",
      "https://staging.app.example.com",
      "https://staging.admin.example.com",
      "pithyapp://",
    ],
  },
  i18n: { enabled: true, locales: ["en", "es"], fallback: "en", empty: [], none: {} },
  payments: {
    enabled: true,
    products: [
      { id: "pro", entitlements: ["pro"], skus: { apple: "pro.ios", google: null } },
      { id: "coins", entitlements: [], skus: { apple: null, google: "coins.android" } },
    ],
  },
  turnstile: { enabled: false, note: 'A "quoted" word, a backslash \\ and a line\nbreak.' },
};

/** Run the repository's Biome in `cwd` over `files`. */
function biome(cwd: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIOME, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe("the file, under the Biome `pithy init` scaffolds", () => {
  let project: string;
  const file = join("apps", "app", GENERATED_CONFIG_PATH);

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "pithy-generated-config-"));
    await cp(join(STARTER, "biome.template.jsonc"), join(project, "biome.jsonc"));
    await cp(join(STARTER, "plugins"), join(project, "plugins"), { recursive: true });
    await mkdir(join(project, "apps", "app", "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  test("passes `biome check` exactly as Pithy writes it", async () => {
    for (const config of [composed, projected]) {
      await writeFile(join(project, file), renderGeneratedConfig(config, "api"));
      const { code, output } = await biome(project, ["check", file]);
      expect(output).not.toContain("Formatter would have printed");
      expect(code, output).toBe(0);
    }
  });

  test("reads back after the project's formatter has rewritten it", async () => {
    // The same value as JSON, the way a file reads before a formatter reaches it: quoted keys, no trailing commas.
    const asJson = renderGeneratedConfig(projected, "api").replace(
      /= \{[\s\S]*\};\n/,
      `= ${JSON.stringify(projected, null, 2)};\n`,
    );
    expect(asJson).toContain('"origins": {');
    await writeFile(join(project, file), asJson);
    const formatted = await biome(project, ["format", "--write", file]);
    expect(formatted.code, formatted.output).toBe(0);
    const rewritten = await readFile(join(project, file), "utf8");
    expect(rewritten).not.toBe(asJson);
    expect(readGeneratedConfig(rewritten)).toEqual(projected);
  });
});
