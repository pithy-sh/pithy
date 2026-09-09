// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { DeclaredEnvironments, FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { requireManagedEnvironment } from "../project/environment";
import type { ProvisionedDeclines, ProvisionReport } from "../provision/environment";
import { runProvision, writeReport } from "./provision";

/**
 * **The gate for #251's other half: exactly one of `--env` and `--feature`, refused at the flag.**
 *
 * The invariant is one sentence — **a provisioning run that named no environment, or two, is refused
 * before anything is read or built.** Not "before a Cloudflare client", which is a list of one forbidden
 * thing and would still pass if the refusal moved after the config load: it is stated against the
 * *earliest* observable step instead. Every case below runs against a directory that is not a Pithy
 * project at all, so any check that ran first would answer with `No pithy.config.ts here.` — and a
 * refusal that arrives after the project has been loaded, an account resolved, or a token read is a
 * refusal that arrived too late.
 *
 * `projectDir` is a seam for exactly that reason. The command uses the working directory; a test that had
 * to `chdir` could not make this assertion without racing every other suite in the pool.
 */

describe("pithy provision names exactly one environment", () => {
  let notAProject: string;

  beforeEach(async () => {
    notAProject = await mkdtemp(join(tmpdir(), "pithy-no-project-"));
  });
  afterEach(async () => {
    await rm(notAProject, { recursive: true, force: true });
  });

  /** The flags every case shares — the ones that are not the mode. */
  const rest = { yes: true, seed: false, json: true } as const;

  /** Run `act` and hand back whatever it threw, so a test asserts on the payload rather than the message. */
  function thrown(act: () => unknown): unknown {
    try {
      act();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  /** Run the command and hand back whatever it threw, so the payload is what a test asserts on. */
  async function refusal(flags: { env?: string; feature: boolean }): Promise<PithyError> {
    const error = await runProvision({ projectDir: notAProject, ...rest, ...flags }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PithyError);
    return error as PithyError;
  }

  test("both flags is refused, before the project is even looked for", async () => {
    const error = await refusal({ env: "staging", feature: true });
    expect(error.payload.message).toMatch(/either --env or --feature, not both/i);
    expect(error.payload.message).not.toMatch(/pithy\.config/i);
  });

  /**
   * **`--feature` is the declaration, never an inference from the branch.** The fixture is a bare temp
   * directory with no git repository in it, so a mode that consulted the branch would have to answer with
   * whatever git said about a directory that is not a checkout. It answers about the flags instead,
   * because that is the only input the mode has.
   */
  test("neither flag is refused, and the refusal names both spellings", async () => {
    const error = await refusal({ feature: false });
    expect(error.payload.message).toMatch(/needs an environment/i);
    expect(error.payload.action).toMatch(/--env/);
    expect(error.payload.action).toMatch(/--feature/);
    expect(error.payload.message).not.toMatch(/pithy\.config/i);
  });

  /**
   * **`--env` cannot reach a branch's environment, and it is closed rather than checked.** `--env` admits
   * exactly what the project declared, and no project can declare this name: `feature` is a legal wrangler
   * stanza key and an illegal declaration, because a declared environment's ids are committed and a
   * feature's are generated. Both halves are asserted, since either alone leaves the door ajar.
   *
   * The other direction is `featureScope`'s, whose stanza is that one name and nothing else — pinned in
   * core's `provisionScope.test.ts`.
   */
  test("`--env feature` is not a way to reach a branch's environment", () => {
    expect(DeclaredEnvironments.safeParse([FEATURE_ENVIRONMENT]).success).toBe(false);
    const error = thrown(() => requireManagedEnvironment(FEATURE_ENVIRONMENT, ["staging", "prod"]));
    expect(error).toBeInstanceOf(PithyError);
    // And it names the flag rather than telling someone to declare what cannot be declared.
    expect((error as PithyError).payload.action).toMatch(/--feature/);
  });
});

/**
 * **What the run says about a decline (#514).**
 *
 * A decline is the one input to `pithy provision` that removes work, and removed work leaves no trace: the
 * summary lists what was made, so a decline honored and a decline dropped on the floor printed the same
 * bytes. The only way to tell them apart was to go and look at the Cloudflare account, which is the
 * distance this report exists to close.
 *
 * `writeReport` is exported for these. It is the whole of what an operator sees of the run, and it was
 * reachable only by provisioning against a live account — so nothing checked a single line of it.
 */
describe("pithy provision reports what it left out", () => {
  /** A report of a run that made nothing, so every assertion below is about the decline lines alone. */
  const base: ProvisionReport = {
    env: "staging",
    resources: [],
    workers: [],
    services: [],
    secretBindings: [],
    declined: [],
    configs: [],
    committed: true,
  };

  /** Run `writeReport` and hand back everything it wrote, so a test asserts on the operator's own view. */
  function output(report: ProvisionReport, json = false): string {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      writeReport(report, { json, seeded: false, pending: { names: [], remedy: null } });
    } finally {
      process.stdout.write = original;
    }
    return chunks.join("");
  }

  const DECLINED: ProvisionedDeclines = {
    state: "read",
    worker: "board",
    declines: [
      {
        state: "honored",
        name: "SUPPORT_BUCKET",
        type: "r2",
        capability: "support",
        reason: "Attachments are off, so nothing would ever be written to it.",
        wantedBy: [],
      },
    ],
  };

  test("names the skipped binding and prints the adopter's own reason back", () => {
    const written = output({ ...base, declined: [DECLINED] });

    expect(written).toContain("SUPPORT_BUCKET (r2) declined by board.");
    // **"by this run"**, and the words are the assertion. Provisioning upserts and never deletes, so a
    // decline added to an already-provisioned environment leaves the bucket in the account and the binding
    // in the stanza — a bare "Not created." would be a claim about an account this run never checked.
    expect(written).toContain("Not created by this run.");
    // Verbatim. The reason is required in `declinedBindings` precisely so a report can hand it back, and
    // it carries the one fact the binding name does not.
    expect(written).toContain("Attachments are off, so nothing would ever be written to it.");
  });

  test("and it rides in --json, where a pipeline reads it", () => {
    const payload = JSON.parse(output({ ...base, declined: [DECLINED] }, true)) as { declined: unknown };

    expect(payload.declined).toEqual([DECLINED]);
  });

  /**
   * A binding a sibling Worker still declares is provisioned anyway — that is how two Workers share a
   * resource. Calling it a skip would send an operator looking for something that exists.
   */
  test("a decline whose binding a sibling still wants says so, rather than claiming a skip", () => {
    const written = output({
      ...base,
      declined: [{ ...DECLINED, declines: [{ ...DECLINED.declines[0], wantedBy: ["collab"] }] }] as never,
    });

    expect(written).toContain("Created anyway for collab.");
    expect(written).not.toContain("Not created by this run.");
  });

  /**
   * **One typo is enough.** An unreadable `declinedBindings` block collapses to an empty set at the
   * filter, so every declined resource is created — and with no line for it the run is byte-identical to a
   * project that declines nothing.
   */
  test("an unreadable declinedBindings block gets its own line, naming the Worker and the problem", () => {
    const written = output({
      ...base,
      declined: [
        {
          state: "invalid",
          worker: "board",
          problem: "`declinedBinding` is not a key this Worker's config declares. Did you mean `declinedBindings`?",
        },
      ],
    });

    expect(written).toContain("declinedBindings in board's pithy.config.ts cannot be read");
    expect(written).toContain("`declinedBinding` is not a key this Worker's config declares.");
  });

  /**
   * **The three states that leave nothing out still get a line, and this is why.**
   *
   * The honored-only report shipped first, on the argument that a refused or stale decline changes nothing
   * about what was provisioned. That is the argument the `invalid` line above already rejects — and the
   * likeliest typo in a decline is not in the block key but in the **binding name**, which resolves
   * `unrecognized`. Silent there, a run that created every declined resource printed what a clean run
   * prints, which is the failure the whole report exists to remove.
   */
  test("a decline that leaves nothing out says so, instead of reading as a project that declines nothing", () => {
    const written = output({
      ...base,
      declined: [
        {
          state: "read",
          worker: "board",
          declines: [
            { state: "unrecognized", name: "ASSET", reason: "no R2 in this account" },
            { state: "required", name: "DB", type: "d1", capability: "auth", reason: "we use Postgres" },
            {
              state: "undeclinable",
              name: "SESSION",
              type: "durable_object",
              capability: "multiplayer",
              reason: "not using rooms",
            },
          ],
        },
      ],
    });

    expect(written).toContain("ASSET declined by board. Nothing it composes declares it, so nothing was left out.");
    expect(written).toContain("DB (d1) declined by board. auth requires it, so nothing was left out.");
    expect(written).toContain("SESSION (durable_object) declined by board. Its kind cannot be declined,");
    // Each still quotes the adopter's own sentence, so the line names the decision as well as the outcome.
    expect(written).toContain("no R2 in this account");
    // And none of them claims a skip.
    expect(written).not.toContain("Not created by this run.");
  });
});
