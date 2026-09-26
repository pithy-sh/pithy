// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type McpOptions, status } from "../mcp/connect";

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
  /** One line per detected-but-unconnected client, each naming the command that connects it. */
  readonly findings: readonly string[];
}

/** The remedy line printed under the findings. */
export const DOCS_MCP_ACTION = "Each line is one command. `pithy docs status` shows where each one would land.";

/** Read every detected client's configuration and report the ones with no entry. */
export async function checkDocsMcp(projectDir: string, options?: McpOptions): Promise<DocsMcpCheck> {
  const resolved: McpOptions = options ?? { projectDir };
  const reported = await status(resolved);
  const findings = reported
    .filter((client) => client.detected && client.scopes.every((scope) => !scope.connected))
    .map((client) => `${client.label} — pithy docs connect --client ${client.client}`);
  return { state: findings.length > 0 ? "unconnected" : "ok", findings };
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
