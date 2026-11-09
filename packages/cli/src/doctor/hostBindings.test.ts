// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { WorkerTarget } from "../project/workers";
import { checkHostBindings, describeHostBinding } from "./hostBindings";

const mailer: Capability = defineCapability({
  name: "email",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "workflow", name: "EMAIL_SENDER", job: "send", className: "EmailSendWorkflow" },
  ],
  workflows: {
    send: { binding: "EMAIL_SENDER", params: z.object({}).describe("None."), className: "EmailSendWorkflow" },
  },
});

/** One Worker's staging stanza, binding `EMAIL_SENDER` into `script`. */
function stanza(script: string, job: string) {
  return {
    name: "acme-two",
    env: {
      staging: {
        workflows: [{ binding: "EMAIL_SENDER", name: job, class_name: "EmailSendWorkflow", script_name: script }],
      },
    },
  };
}

describe("checkHostBindings", () => {
  let dir: string;
  let two: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-host-bindings-doctor-"));
    two = join(dir, "apps", "two");
    await mkdir(two, { recursive: true });
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme", environments: ["staging"] };\n');
    await writeFile(join(dir, "package.json"), '{ "name": "acme" }\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (ownBindings: string[]) => {
    const workers: WorkerTarget[] = [{ name: "acme-two", dir: two, hasWrangler: true, ownBindings }];
    return checkHostBindings({ projectDir: dir, workers, capabilitiesFor: async () => [mailer] });
  };

  test("reports a Worker that owns DB and still binds the shared host, which reads another database", async () => {
    await writeFile(
      join(two, "wrangler.jsonc"),
      JSON.stringify(stanza("acme-staging-email", "acme-staging-email-send")),
    );
    const check = await run(["DB"]);
    expect(check).toEqual({
      state: "stale",
      stale: [
        {
          worker: "two",
          env: "staging",
          binding: "EMAIL_SENDER",
          capability: "email",
          boundTo: "acme-staging-email",
          expected: "acme-staging-two---email",
        },
      ],
    });
    expect(describeHostBinding(check.stale[0] as (typeof check.stale)[number])).toBe(
      "binds EMAIL_SENDER in staging to acme-staging-email, which reads another database, so its email work runs against the wrong one. It belongs on acme-staging-two---email.",
    );
  });

  test("passes a Worker bound to the host that reads its own database", async () => {
    await writeFile(
      join(two, "wrangler.jsonc"),
      JSON.stringify(stanza("acme-staging-two---email", "acme-staging-two---email-send")),
    );
    expect(await run(["DB"])).toEqual({ state: "ok", stale: [] });
  });

  test("reports a Worker that no longer owns DB and still binds its own host", async () => {
    await writeFile(
      join(two, "wrangler.jsonc"),
      JSON.stringify(stanza("acme-staging-two---email", "acme-staging-two---email-send")),
    );
    expect((await run([])).stale.map((entry) => [entry.boundTo, entry.expected])).toEqual([
      ["acme-staging-two---email", "acme-staging-email"],
    ]);
  });

  test("leaves a binding into a script that is no kit host of this capability to the adopter", async () => {
    await writeFile(join(two, "wrangler.jsonc"), JSON.stringify(stanza("my-own-mailer", "my-own-mailer-send")));
    expect(await run(["DB"])).toEqual({ state: "ok", stale: [] });
  });

  test("reports a service binding from an owning Worker into the shared kit host", async () => {
    await writeFile(
      join(two, "wrangler.jsonc"),
      JSON.stringify({
        name: "acme-two",
        env: { staging: { services: [{ binding: "EMAIL", service: "acme-staging-email" }] } },
      }),
    );
    expect(await run(["DB"])).toEqual({
      state: "stale",
      stale: [
        {
          worker: "two",
          env: "staging",
          binding: "EMAIL",
          capability: "email",
          boundTo: "acme-staging-email",
          expected: "acme-staging-two---email",
        },
      ],
    });
  });

  test("passes a service binding into the Worker's own host, and one into a script that is no kit host", async () => {
    await writeFile(
      join(two, "wrangler.jsonc"),
      JSON.stringify({
        name: "acme-two",
        env: {
          staging: {
            services: [
              { binding: "EMAIL", service: "acme-staging-two---email" },
              { binding: "API", service: "acme-staging-api" },
            ],
          },
        },
      }),
    );
    expect(await run(["DB"])).toEqual({ state: "ok", stale: [] });
  });

  test("a Worker whose ownBindings split audit's paired bindings is not checked, and doctor does not throw", async () => {
    const audit = { name: "audit", requiredBindings: [] } as unknown as Capability;
    await writeFile(
      join(two, "wrangler.jsonc"),
      JSON.stringify(stanza("acme-staging-email", "acme-staging-email-send")),
    );
    const workers: WorkerTarget[] = [{ name: "acme-two", dir: two, hasWrangler: true, ownBindings: ["DB"] }];
    const check = await checkHostBindings({ projectDir: dir, workers, capabilitiesFor: async () => [audit] });
    expect(check.state).toBe("could-not-check");
  });

  test("cannot check a project with no readable root config", async () => {
    await rm(join(dir, "pithy.config.ts"));
    expect((await run(["DB"])).state).toBe("could-not-check");
  });
});
