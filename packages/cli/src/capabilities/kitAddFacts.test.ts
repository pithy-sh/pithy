// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { describe, expect, test } from "vitest";
import { addFactsOf, KIT_ADD_FACTS_PATH, kitAddFacts, renderKitAddFacts } from "./kitAddFacts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const payments = CapabilityManifest.parse({
  name: "payments",
  package: "@pithy-sh/payments",
  requiredBindings: [],
  peerCapabilities: ["secrets"],
  configOptions: [
    { key: "basePath", describe: "Where it mounts.", default: "/payments" },
    {
      key: "billingSubject",
      describe: "Who holds an entitlement.",
      choices: ["user", "organization"],
      choicesNeedingCode: { organization: "Write it." },
    },
  ],
});

describe("addFactsOf", () => {
  test("keeps the peers and only the options the manifest states no default for", () => {
    expect(addFactsOf(payments)).toEqual({
      name: "payments",
      peerCapabilities: ["secrets"],
      requiredOptions: [
        { key: "billingSubject", choices: ["user", "organization"], choicesNeedingCode: { organization: "Write it." } },
      ],
    });
  });
});

describe("kitAddFacts", () => {
  test("answers for a kit capability, and not for a name the kit does not have", () => {
    expect(kitAddFacts("payments")?.requiredOptions.map((option) => option.key)).toEqual(["billingSubject"]);
    expect(kitAddFacts("auth")?.peerCapabilities).toEqual(["secrets", "email"]);
    expect(kitAddFacts("nope")).toBeUndefined();
    expect(kitAddFacts("toString")).toBeUndefined();
  });
});

/**
 * **The committed table is the kit's manifests (#711).** A line naming `pithy add` for a package not yet installed
 * reads this, so a table behind a manifest names a command the manifest refuses.
 */
test("the committed kit facts are current: run `bun run command-catalog`", () => {
  const packages = join(REPO_ROOT, "packages");
  // A package with no manifest is not a capability; one that will not parse fails here, as it fails the writer.
  const manifests = readdirSync(packages)
    .sort()
    .filter((pkg) => existsSync(join(packages, pkg, "pithy.manifest.json")))
    .map((pkg) =>
      CapabilityManifest.parse(JSON.parse(readFileSync(join(packages, pkg, "pithy.manifest.json"), "utf8"))),
    );
  expect(manifests.length).toBeGreaterThan(10);
  expect(readFileSync(join(REPO_ROOT, KIT_ADD_FACTS_PATH), "utf8")).toBe(renderKitAddFacts(manifests));
});
