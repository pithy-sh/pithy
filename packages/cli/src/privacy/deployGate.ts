// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { PreconditionFailedError } from "@pithy-sh/core/src/error/pithyError";
import { PRIVACY_ATTESTATION_VAR, type PrivacyAttestation } from "@pithy-sh/core/src/privacy/posture";
import { loadProjectPrivacy, type ProjectConfig } from "../project/config";
import { readConsoleGate } from "./consoleGate";
import type { ConsoleGateReading } from "./gateReading";

/**
 * **The `pithy deploy` console gate, and the attestation every deploy writes.**
 *
 * The only hard failure the privacy work adds: a project that declared a class, whose linter config is readable
 * and leaves `console` open, does not deploy — file named, rule named, fix named. Everything else deploys: no
 * class declared (the gate does not apply, whatever the rule says), the rule on in every linter config, or none
 * Pithy can read, which is said out loud on the run and carried into the manifest as `unverifiable`.
 *
 * Every deploy then writes what it found into the Worker as {@link PRIVACY_ATTESTATION_VAR}, on wrangler's argv —
 * a project that declared nothing included, so its manifest says so explicitly rather than saying nothing.
 */

/** What a deploy attests, and the gate reading behind it (`null` when no class is declared, so none was read). */
export interface DeployPrivacy {
  /** The attestation written into every Worker this deploy ships. */
  attestation: PrivacyAttestation;
  /** The console gate as read, or `null` when nothing is declared. */
  gate: ConsoleGateReading | null;
}

/** What {@link deployPrivacy} takes. */
export interface DeployPrivacyOptions {
  /** The project root. */
  projectDir: string;
  /** The loaded root config. */
  config: ProjectConfig;
  /** The clock. */
  now?: () => Date;
}

/**
 * The fix a refusal names, by why the gate is off. `pithy privacy enable` writes the rule only where it was never
 * stated, so it is the fix for that cause alone: a rule a person turned down, or a linter they disabled, is
 * theirs to change back, and naming `enable` there would name a command that writes nothing.
 */
function fixFor(gate: Extract<ConsoleGateReading, { state: "off" }>, classes: readonly string[]): string {
  switch (gate.cause) {
    case "unstated":
      return `Set ${gate.rule} to "error" in ${gate.file}, or run ${pithyCommand("privacy enable", { flags: { "--class": classes[0] as string } })} to write it.`;
    case "lowered":
      return `Set ${gate.rule} to "error", allowing no method, for the Worker source in ${gate.file}, where it was turned down on purpose. Pithy does not override that.`;
    case "disabled":
      return `Turn the linter back on for the Worker source in ${gate.file}, and keep ${gate.rule} at "error" there. Pithy does not override that.`;
  }
}

/**
 * Decide the gate for a deploy, and refuse when it is off. Read once, before any Worker is built: the refusal is
 * the project's, not a Worker's, so it is one error rather than a failed row per Worker.
 */
export async function deployPrivacy(options: DeployPrivacyOptions): Promise<DeployPrivacy> {
  const classes = loadProjectPrivacy(options.config);
  const attestedAt = (options.now ?? (() => new Date()))().toISOString();
  if (classes.length === 0) {
    return { attestation: { classes: [], consoleGate: "not_required", reason: null, attestedAt }, gate: null };
  }
  const gate = await readConsoleGate(options.projectDir);
  if (gate.state === "off") {
    throw new PreconditionFailedError({
      message: `This project declares ${classes.join(", ")}, and console is open: ${gate.reason}`,
      action: `${fixFor(gate, classes)} A console.log bypasses every privacy gate.`,
      detail: `console gate off (${gate.cause}) in ${gate.file}`,
    });
  }
  return {
    attestation: {
      classes,
      consoleGate: gate.state,
      reason: gate.state === "unverifiable" ? gate.reason : null,
      attestedAt,
    },
    gate,
  };
}

/**
 * The argv that carries the attestation into a Worker. wrangler splits a `--var` on its first colon and joins the
 * rest back (`collectKeyValues`, wrangler 4.151.0), so a JSON value survives whole.
 */
export function privacyVarArgs(attestation: PrivacyAttestation): string[] {
  return ["--var", `${PRIVACY_ATTESTATION_VAR}:${JSON.stringify(attestation)}`];
}

/** The line a deploy prints when the gate cannot be read, or `undefined` when there is nothing to say. */
export function unverifiableGateLine(privacy: DeployPrivacy): string | undefined {
  if (privacy.attestation.consoleGate !== "unverifiable") return undefined;
  return `Console gate unverifiable. ${privacy.attestation.reason ?? ""} Deploying anyway; the control plane reports it as unverified.`;
}
