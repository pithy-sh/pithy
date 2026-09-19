// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { secretsWriteWorkflowName } from "@pithy-sh/secrets/src/manager/dispatcher";
import {
  managerCfApiTokenName,
  managerCfApiTokenSecretName,
  masterKeySecretName,
} from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { vectorIndexName } from "@pithy-sh/vector/src/provision/provisionVector";
import { expect, test } from "vitest";
import { HOST_WORKERS } from "../capabilities/hostRegistry";
import { CloudflareSecretsProvisioner } from "../capabilities/secretsProvisioner";
import type { ResourceProvisioners } from "../provision/resources";
import { featureHostScripts } from "./hosts";
import { deprovisionFeature } from "./provision";

/**
 * **The reviewer's cross-project reproduction, kept (#643, finding 1 of the review of 8858558c).**
 *
 * Project `acme-f12-x` is another Pithy project in the same account. Its name began `<project>-f<issue>-`, which
 * project names were allowed to and environment names were not, so project `acme`'s branch `feature/12-x-prod`
 * composed every one of `acme-f12-x`'s production names: in the reproduction, provisioning adopted and
 * redeployed the other project's production hosts, and destroy deleted them and its master key. And
 * `feature/12-x-global` deleted its manager token. Neither may touch the other project now.
 */

const OTHER = "acme-f12-x";

/** An account holding the other project's production: its host scripts, Workflows, store entries and token. */
function account(seed: { scripts: string[]; workflows: [string, string][]; entries: string[]; tokens: string[] }) {
  const scripts = new Set(seed.scripts);
  const workflows = new Map(seed.workflows);
  const entries = new Set(seed.entries);
  const tokens = [...seed.tokens];
  const none = { find: async () => null, create: async () => ({ id: "x" }), delete: async () => {} };
  return {
    scripts,
    workflows,
    entries,
    tokens,
    options: {
      provisioners: { d1: none, kv: none, r2: none } as unknown as ResourceProvisioners,
      scripts: {
        exists: async (name: string) => scripts.has(name),
        delete: async (name: string) => void scripts.delete(name),
      },
      workflows: {
        hostedBy: async (hosting: ReadonlySet<string>) =>
          [...workflows].filter(([, script]) => hosting.has(script)).map(([name]) => name),
        delete: async (name: string) => void workflows.delete(name),
      },
      store: {
        storeId: "s",
        exists: async (name: string) => entries.has(name),
        put: async () => {},
        create: async () => "created" as const,
        remove: async (name: string) => entries.delete(name),
      },
    },
  };
}

async function destroy(slug: string, acct: ReturnType<typeof account>) {
  const dir = await mkdtemp(join(tmpdir(), "pithy-crossproject-"));
  try {
    return await deprovisionFeature({
      projectDir: dir,
      identity: { project: "acme", issue: "12", slug },
      capabilities: [secrets({ registry: {} }), email({ fromAddress: "a@b.example", baseUrl: "https://b.example" })],
      env: "feature",
      workers: [],
      ...acct.options,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("destroying acme's feature/12-x-prod leaves project acme-f12-x's production alone", async () => {
  const prod = resourceNames(OTHER).env("prod");
  const hosts = HOST_WORKERS.map((spec) => prod.worker(spec.capability));
  const workflows: [string, string][] = [
    [secretsWriteWorkflowName(OTHER, "prod"), prod.worker("secrets")],
    [prod.workflow("email", "send"), prod.worker("email")],
  ];
  const key = masterKeySecretName(OTHER, "prod");
  const acct = account({ scripts: hosts, workflows, entries: [key], tokens: [] });

  const report = await destroy("x-prod", acct);

  expect(report.deleted).toEqual([]);
  expect([...acct.scripts].sort()).toEqual([...hosts].sort());
  expect([...acct.workflows.keys()].sort()).toEqual(workflows.map(([name]) => name).sort());
  expect(acct.entries.has(key)).toBe(true);
});

test("destroying acme's feature/12-x-global leaves project acme-f12-x's manager token entry alone", async () => {
  const entry = managerCfApiTokenSecretName(OTHER);
  const acct = account({ scripts: [], workflows: [], entries: [entry], tokens: [managerCfApiTokenName(OTHER)] });

  const report = await destroy("x-global", acct);

  expect(report.deleted).toEqual([]);
  expect(acct.entries.has(entry)).toBe(true);
  expect(acct.tokens).toEqual([managerCfApiTokenName(OTHER)]);
});

test("provisioning acme's feature/12-x-prod composes none of acme-f12-x's production names, and creates its own key", async () => {
  const feature = { project: "acme", issue: "12", slug: "x-prod" };
  const prod = resourceNames(OTHER).env("prod");
  const theirs = new Set(HOST_WORKERS.map((spec) => prod.worker(spec.capability)));
  for (const host of featureHostScripts(feature)) expect(theirs.has(host.script), host.script).toBe(false);
  expect(vectorIndexName("acme", "notes", "feature", feature)).not.toBe(vectorIndexName(OTHER, "notes", "prod"));
  expect(masterKeySecretName("acme", "feature", feature)).not.toBe(masterKeySecretName(OTHER, "prod"));

  const entries = new Map([[masterKeySecretName(OTHER, "prod"), "PROD-KEY"]]);
  const created: string[] = [];
  const cf = {
    secrets: () => ({
      exists: async (name: string) => entries.has(name),
      createSecretIfAbsent: async (name: string, value: string) => {
        if (entries.has(name)) return "present";
        created.push(name);
        entries.set(name, value);
        return "created";
      },
    }),
  } as unknown as CloudflareClients;
  await new CloudflareSecretsProvisioner({
    cf,
    account: { accountId: "a", confirmation: "pinned" },
    project: "acme",
    storeId: "s",
    deploy: async () => {},
    feature,
  }).ensureMasterKey("feature");

  // Its own key, minted beside the other project's, which is left exactly as it was.
  expect(created).toEqual([masterKeySecretName("acme", "feature", feature)]);
  expect(entries.get(masterKeySecretName(OTHER, "prod"))).toBe("PROD-KEY");
});

test("project acme-f12-x itself can have no features, and its staging and prod are unaffected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pithy-crossproject-"));
  try {
    await expect(
      deprovisionFeature({
        projectDir: dir,
        identity: { project: OTHER, issue: "3", slug: "y" },
        capabilities: [],
        env: "feature",
        workers: [],
        ...account({ scripts: [], workflows: [], entries: [], tokens: [] }).options,
      }),
    ).rejects.toThrow(PithyError);
    expect(resourceNames(OTHER).env("prod").worker("email")).toBe("acme-f12-x-prod-email");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
