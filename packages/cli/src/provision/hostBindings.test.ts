// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { OwnedHostedWorkflowEntry } from "../feature/hosts";
import { addProvisionedHosts, bindHostWorkflows, type ProvisionedHost } from "./hostBindings";

const OWN: OwnedHostedWorkflowEntry = {
  capability: "email",
  owner: "two",
  binding: "EMAIL_SENDER",
  name: "acme-staging-two---email-send",
  class_name: "EmailSendWorkflow",
  script_name: "acme-staging-two---email",
};

describe("bindHostWorkflows", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-host-bindings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(config: unknown): Promise<void> {
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify(config, null, 2));
  }
  async function read(): Promise<{ env: { staging: { workflows: unknown[] } } }> {
    return parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as never;
  }

  test("moves a binding into the shared host onto the Worker's own, and keeps every other entry", async () => {
    const other = { binding: "APP_DIGEST", name: "acme-staging-app-digest", class_name: "Digest" };
    await write({
      name: "two",
      env: {
        staging: {
          workflows: [
            { ...other },
            {
              binding: "EMAIL_SENDER",
              name: "acme-staging-email-send",
              class_name: "EmailSendWorkflow",
              script_name: "acme-staging-email",
            },
          ],
        },
      },
    });
    expect(await bindHostWorkflows(dir, "staging", [OWN])).toBe(true);
    expect((await read()).env.staging.workflows).toEqual([
      other,
      {
        binding: "EMAIL_SENDER",
        name: "acme-staging-two---email-send",
        class_name: "EmailSendWorkflow",
        script_name: "acme-staging-two---email",
      },
    ]);
  });

  test("adds an entry the stanza lacks, and writes nothing on a second run", async () => {
    await write({ name: "two", env: { staging: {} } });
    expect(await bindHostWorkflows(dir, "staging", [OWN])).toBe(true);
    expect(await bindHostWorkflows(dir, "staging", [OWN])).toBe(false);
    expect((await read()).env.staging.workflows).toHaveLength(1);
  });

  test("leaves a Worker with no stanza for the environment alone", async () => {
    await write({ name: "two" });
    expect(await bindHostWorkflows(dir, "staging", [OWN])).toBe(false);
  });
});

describe("addProvisionedHosts", () => {
  test("lists each host once, with every Worker whose bindings reach it", () => {
    const hosts = new Map<string, ProvisionedHost>();
    const shared = { ...OWN, owner: undefined, name: "acme-staging-email-send", script_name: "acme-staging-email" };
    const { owner: _owner, ...sharedEntry } = shared;
    addProvisionedHosts(hosts, "acme-staging-one", [sharedEntry]);
    addProvisionedHosts(hosts, "acme-staging-three", [sharedEntry]);
    addProvisionedHosts(hosts, "acme-staging-two", [OWN]);
    expect([...hosts.values()]).toEqual([
      { capability: "email", script: "acme-staging-email", workers: ["acme-staging-one", "acme-staging-three"] },
      { capability: "email", owner: "two", script: "acme-staging-two---email", workers: ["acme-staging-two"] },
    ]);
  });
});
