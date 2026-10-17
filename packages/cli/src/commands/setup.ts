// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative, sep } from "node:path";
import { commandName } from "@pithy-sh/core/src/cli/command";
import { defineCommand } from "citty";
import { z } from "zod";
import { withContract } from "../contract/commandContract";
import { DRY_RUN_ARG, emptyPlan, PlanKey, planText } from "../plan/plan";
import { externalLines, setupLines } from "../setup/render";
import { isBlockedPlan, type SetupReport, setupCheckout, setupPlan } from "../setup/run";
import { NextKey, setupNext } from "../terminal/nextSteps";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * `pithy setup` — make this checkout ready to develop, whatever state it is in. Dev only.
 *
 * The steps and the rules are `setup/run.ts`'s. This file parses, prints and publishes.
 */

const SetupCommand = z.literal("setup").describe('`"setup"`.');

/** The install a run starts with. */
const SetupInstall = z
  .object({
    packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).describe("The project's package manager."),
    lockfile: z
      .string()
      .nullable()
      .describe("The lockfile it installs against, by name — never rewritten. `null` when the project has none yet."),
    command: z.string().describe("The install, as a command line."),
  })
  .describe("The install this run ran, or under `--dry-run` would.");

/** `pithy setup --json`: one line, one outcome. */
const SetupPayload = z
  .union([
    z
      .object({
        command: SetupCommand,
        outcome: z
          .enum(["ready", "unchanged", "planned"])
          .describe(
            "`ready` — this run changed something and the checkout is ready. `unchanged` — it was ready already, and nothing was written. `planned` — `--dry-run`, and nothing was written.",
          ),
        dryRun: z.boolean().describe("Whether this was `--dry-run`."),
        project: z.string().describe("The project's name — what the dev secrets file and the port registry key on."),
        install: SetupInstall.nullable().describe("The install, or `null` under `--skip-install`."),
        localSecrets: z
          .object({
            path: z.string().describe("The dev secrets file, absolute. Outside the checkout."),
            minted: z
              .array(z.string().describe("A secret's name."))
              .describe("Secrets minted into it, or under `--dry-run` that would be."),
            adopted: z
              .array(z.string().describe("A secret's name."))
              .describe("Secrets an older home on this machine held, carried into it rather than minted."),
          })
          .describe("The local secrets the kit can mint."),
        appliedMigrations: z
          .array(z.string().describe("A migration's namespaced name."))
          .describe("The dev migrations applied, or under `--dry-run` pending."),
        ports: z
          .object({
            allocated: z.boolean().describe("Whether a Worker gained a port, or under `--dry-run` would."),
            workers: z
              .record(
                z.string().describe("The Worker or capability host's name."),
                z
                  .object({
                    port: z.number().int().describe("Its pinned port."),
                    origin: z.string().describe("The address its siblings reach it at."),
                  })
                  .describe("Where it answers once `pithy dev` starts it."),
              )
              .describe("Every pinned member. Empty under `--dry-run`, which pins none."),
          })
          .describe("This checkout's ports, in `.dev.config.json`."),
        devVarsWritten: z
          .array(z.string().describe("A Worker's directory, relative to the checkout."))
          .describe("Workers whose generated `.dev.vars` this run wrote. Empty when every one already held its bytes."),
        seededSecrets: z
          .array(z.string().describe("A secret's name."))
          .describe("Dev secrets seeded into the local SECRETS store this run."),
        seed: z
          .object({
            state: z
              .enum(["seeded", "planned", "held", "media", "none"])
              .describe(
                "`seeded` — fixtures written into an empty dev. `planned` — `--dry-run`, into an empty dev. `held` — dev holds rows, so it was left alone. `media` — a fixture uploads media, which setup never reaches, so nothing was seeded. `none` — nothing was written: nothing composes a fixture, or dev already holds everything one writes.",
              ),
            held: z
              .array(
                z
                  .object({
                    worker: z.string().describe("The first Worker that declares the table."),
                    binding: z.string().describe("The D1 binding."),
                    table: z.string().describe("The SQL table name."),
                  })
                  .describe("One table that holds rows."),
              )
              .describe("Under `held`, a table per database that holds rows. Empty otherwise."),
          })
          .describe("How the seed step ended."),
        externalSecrets: z
          .array(z.string().describe("A secret's name."))
          .describe(
            "Every secret somebody else issues with no value here. `pithy secrets edit` opens the file it goes in.",
          ),
        notes: z.array(z.string().describe("One sentence.")).describe("What the steps had to say, in order."),
        next: NextKey,
        plan: PlanKey,
      })
      .describe("A run that set the checkout up, found it set up, or planned doing so."),
    z
      .object({
        command: SetupCommand,
        outcome: z.literal("blocked").describe("`blocked` — `--dry-run` could plan only the install."),
        dryRun: z.literal(true).describe("Always `true`: only a dry run stops here."),
        install: SetupInstall,
        blocked: z
          .string()
          .describe("Why nothing after the install could be planned: the project check's own sentence."),
        plan: PlanKey,
      })
      .describe("A dry run on a checkout whose configs cannot load until the install has run."),
  ])
  .describe("What `pithy setup` did, or under `--dry-run` would.");

/** A Worker directory as the payload states it: relative to the checkout, `/`-separated. */
function shown(projectDir: string, dir: string): string {
  return relative(projectDir, dir).split(sep).join("/") || ".";
}

/** The install as the payload states it. */
function installJson(install: SetupReport["install"]): Record<string, unknown> | null {
  if (install === null) return null;
  return {
    packageManager: install.packageManager,
    lockfile: install.lockfile,
    command: [install.command, ...install.args].join(" "),
  };
}

export default withContract(
  defineCommand({
    meta: {
      name: "setup",
      description: "Make this checkout ready to develop: install, secrets, migrate, ports, seed",
    },
    args: {
      "skip-install": { type: "boolean", default: false, description: "Leave the dependencies as they are" },
      "dry-run": DRY_RUN_ARG,
      json: { type: "boolean", default: false, description: "Machine-readable output" },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        // No account, by construction: setup is dev only, and nothing below is handed one (#764).
        const result = await setupCheckout({
          projectDir,
          account: null,
          dryRun: args["dry-run"],
          install: !args["skip-install"],
        });

        if (isBlockedPlan(result)) {
          const plan = emptyPlan();
          plan.notes.push(
            `Runs ${result.install.command} ${result.install.args.join(" ")}.`,
            `Every later step reads the project's configs, which load once the install has run: ${result.blocked}`,
          );
          if (args.json) {
            const install = installJson(result.install);
            process.stdout.write(
              `${formatJsonLine({ command: "setup", outcome: "blocked", dryRun: true, install, blocked: result.blocked, plan })}\n`,
            );
            return;
          }
          for (const line of planText(plan)) process.stdout.write(`${line}\n`);
          process.stdout.write("Dry run. Nothing written.\n");
          return;
        }

        if (args.json) {
          // Every nested value built first, so the line below is one flat literal the docs gate can read.
          const outcome = result.dryRun ? "planned" : result.changed ? "ready" : "unchanged";
          const install = installJson(result.install);
          const localSecrets = {
            path: result.secrets.path,
            minted: result.secrets.minted,
            adopted: result.secrets.adopted,
          };
          const ports = { allocated: result.dev.allocated, workers: result.dev.dev?.workers ?? {} };
          const devVarsWritten = result.dev.devVars.map((dir) => shown(projectDir, dir));
          const seed = { state: result.seed.state, held: result.seed.state === "held" ? result.seed.held : [] };
          const next = setupNext({ dryRun: result.dryRun });
          const plan = result.dryRun ? setupPlan(projectDir, result) : undefined;
          process.stdout.write(
            `${formatJsonLine({
              command: "setup",
              outcome,
              dryRun: result.dryRun,
              project: result.project,
              install,
              localSecrets,
              appliedMigrations: result.migrations,
              ports,
              devVarsWritten,
              seededSecrets: result.dev.seededSecrets,
              seed,
              externalSecrets: result.external,
              notes: result.notes,
              next,
              plan,
            })}\n`,
          );
          return;
        }
        if (result.dryRun) {
          for (const line of planText(setupPlan(projectDir, result))) process.stdout.write(`${line}\n`);
          for (const line of externalLines(result)) process.stdout.write(`${line}\n`);
          process.stdout.write("Dry run. Nothing written.\n");
          return;
        }
        if (result.install !== null) {
          process.stdout.write(
            result.install.lockfile === null
              ? `Installed with ${result.install.packageManager}. There was no lockfile, so it wrote one. Commit it.\n`
              : `Installed with ${result.install.packageManager} against ${result.install.lockfile}.\n`,
          );
        }
        for (const line of setupLines(projectDir, result)) process.stdout.write(`${line}\n`);
        for (const line of externalLines(result)) process.stdout.write(`${line}\n`);
        process.stdout.write(`Next: ${commandName("dev")}.\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: SetupPayload,
    mutates: true,
    idempotent: true,
    // The install reaches the package registry. Nothing reaches Cloudflare.
    needsNetwork: true,
  },
);
