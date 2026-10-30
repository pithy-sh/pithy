// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import type { McpClientId } from "../mcp/clients";
import { type McpOptions, status } from "../mcp/connect";
import { docsConnectFix } from "./findingFixes";

/**
 * Which AI clients on this machine could be reading the Pithy documentation and are not.
 *
 * **Reports, never gates.** Whether an operator wants their editor wired to a documentation server is
 * their business, and a check that failed `pithy doctor`'s exit over it would be a CLI telling somebody
 * their machine is misconfigured for declining an offer. So this contributes no exit code — it is the
 * same category as the `Alias:` line, which reports that `p.` is not installed and lets that be.
 *
 * **A finding names the command that clears it**, which is the property `doctor` is held to generally:
 * a line that says something is wrong and not what to run has moved the problem rather than reported it.
 * Here that means the client's own id, so the remedy can be pasted rather than worked out.
 *
 * **It resolves every path through `mcp/connect.ts`, the code `pithy docs connect` writes through**, so a
 * `CLAUDE_CONFIG_DIR` or `CODEX_HOME` moves what this reads exactly as it moves what that writes — and
 * each line names the files it read, because "not connected" is only as true as the file it was read from.
 *
 * **Files only, and only files that are already there.** Nothing is created, nothing is written, and a
 * client whose config cannot be read is simply not reported as connected — a diagnostic that repaired
 * things would be the last thing an operator with a broken environment needs.
 */

/** What the docs-server check found. */
export interface DocsMcpCheck {
  /**
   * `unconnected` when a detected client has no entry anywhere; `ok` when every detected client has one,
   * and when no client was detected at all — nothing is wrong with a machine that runs none of them.
   */
  readonly state: "ok" | "unconnected" | "could-not-check";
  /** One line per detected-but-unconnected client, each naming the files it read and the command that connects it. */
  readonly findings: readonly string[];
  /** The same clients as data, in the same order: the id the command takes, and the name a person reads. */
  readonly clients: readonly DocsMcpClient[];
}

/** One detected client with no docs-server entry anywhere. */
export interface DocsMcpClient {
  /** The id `pithy docs connect --client` takes. */
  readonly client: McpClientId;
  /** The name a person knows it by. */
  readonly label: string;
  /** Every file the check read for it, one per scope, absolute. None of them carries an entry. */
  readonly paths: readonly string[];
}

/** The remedy line printed under the findings. */
export const DOCS_MCP_ACTION = `Each line is one command. \`${pithyCommand("docs status")}\` shows where each one would land.`;

/** Read every detected client's configuration and report the ones with no entry. */
export async function checkDocsMcp(projectDir: string, options?: McpOptions): Promise<DocsMcpCheck> {
  const resolved: McpOptions = options ?? { projectDir };
  const reported = await status(resolved);
  const clients = reported
    .filter((client) => client.detected && client.scopes.every((scope) => !scope.connected))
    .map((client) => ({ client: client.client, label: client.label, paths: client.scopes.map((scope) => scope.path) }));
  const findings = clients.map(
    (client) => `${client.label}, nothing in ${client.paths.join(" or ")} — ${docsConnectFix(client.client)}`,
  );
  return { state: findings.length > 0 ? "unconnected" : "ok", findings, clients };
}

/** The one-sentence verdict, shared by the text renderer and the `--json` detail so neither words it twice. */
export function describeDocsMcp(check: DocsMcpCheck): string {
  switch (check.state) {
    case "ok":
      return "Every AI client detected here can read the Pithy docs.";
    case "unconnected":
      return `${check.findings.length} detected client${check.findings.length === 1 ? "" : "s"} cannot read the Pithy docs.`;
    case "could-not-check":
      return "Could not read the AI clients' configuration.";
  }
}
