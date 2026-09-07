// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareManagerConfig } from "@pithy-sh/cloudflare/src/client/manager";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";

/**
 * The one place the CLI loads the Cloudflare REST client, and it loads it at the moment a command
 * decides to talk to Cloudflare rather than at the moment a command is imported.
 *
 * **Measured, because the shape looks like ceremony until the number is on the page.** `pithy add
 * --help` cost 867 ms under Node, of which roughly 53% was Node's own module loader, and the two
 * leaves it was loading for were `miniflare` (~290 ms) and this one (~360 ms) — neither of which a
 * flag list needs (#482). The cost is not `clients.ts` composing 26 managers; it is one static
 * `import { Cloudflare } from "cloudflare"` in `@pithy-sh/cloudflare/src/client/manager`, the SDK
 * every manager extends. Anything that reaches `CloudflareManager` pays it, and until #482 every
 * command module reached it before citty had even parsed the arguments.
 *
 * **A function rather than 24 `await import` lines.** Each call site would otherwise re-derive the
 * specifier, and a specifier written 24 times is a specifier one of them gets wrong. It also makes
 * the rule grep-able the way `secretsStore(` is: every Cloudflare REST client the CLI builds comes
 * from here, so `ci/lazyHeavyImports.test.ts` can hold the property by deriving the import graph
 * rather than by keeping a list of files.
 *
 * **The type import above stays static and costs nothing** — `import type` is erased, so naming
 * `CloudflareClients` in a signature never loads it. That is what lets every seam in the CLI keep
 * its `CloudflareClients` type while none of them pull the SDK in.
 */
export async function cloudflareClients(config: CloudflareManagerConfig): Promise<CloudflareClients> {
  const { CloudflareClients: Clients } = await import("@pithy-sh/cloudflare/src/client/clients");
  return new Clients(config);
}

/**
 * The Workflows REST client, loaded the same way and for the same reason.
 *
 * A separate function rather than a method on {@link cloudflareClients}' result because
 * `CloudflareWorkflowsClient` is not one of the managers `CloudflareClients` aggregates — it is
 * constructed directly by the two commands that poll a Workflow instance (`payments`, `vector`) and
 * by the secrets dispatcher.
 */
export async function cloudflareWorkflows(config: CloudflareManagerConfig): Promise<CloudflareWorkflowsClient> {
  const { CloudflareWorkflowsClient: Workflows } = await import("@pithy-sh/cloudflare/src/workflows/workflowsClient");
  return new Workflows(config);
}
