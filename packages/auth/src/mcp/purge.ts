// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PurgeContext } from "@pithy-sh/core/src/capability/purge";
import { authDatabase } from "../data/tables";
import { bindingOf, pluginRows, prepared, untyped } from "../purge/contribution";
import { MCP_MODEL_NAMES } from "./provider";

/**
 * What erasing and exporting a person means for the provider's tables.
 *
 * The rows keyed to a person are the consents they gave and the tokens minted under them. A dynamically registered
 * client is not theirs — it is the application's record of itself, written before anybody signed in — so it stays.
 */
export const MCP_USER_TABLES = [
  MCP_MODEL_NAMES.oauthConsent,
  MCP_MODEL_NAMES.oauthAccessToken,
  MCP_MODEL_NAMES.oauthRefreshToken,
] as const;

/** Erase one person's consents and tokens. Succeeds, having found nothing, when they are already gone. */
export async function eraseMcpUser(context: PurgeContext, database: string): Promise<void> {
  const d1 = bindingOf(context.env, database);
  const db = untyped(authDatabase(d1));
  await d1.batch(
    MCP_USER_TABLES.map((table) =>
      prepared(d1, db.deleteFrom(table).where("userId", "=", context.subject.id).compile()),
    ),
  );
}

/** One person's consents and tokens, every column but a credential's. */
export async function exportMcpUser(context: PurgeContext, database: string): Promise<Record<string, unknown>> {
  const db = authDatabase(bindingOf(context.env, database));
  const tables = await Promise.all(
    MCP_USER_TABLES.map(async (table) => [table, await pluginRows(db, table, context.subject.id)] as const),
  );
  return Object.fromEntries(tables);
}
