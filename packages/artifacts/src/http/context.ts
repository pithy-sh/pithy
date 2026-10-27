// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Context } from "hono";
import { type ArtifactsStore, artifactsStore } from "../data/store";
import { artifactsDatabase } from "../data/tables";

/** The store over this invocation's `DB`, for the owner's routes and the control plane's alike. */
export function storeOf(c: Context<PithyHonoEnv>): ArtifactsStore {
  const db = c.env.DB as D1Database | undefined;
  if (!db) throw new InternalError({ detail: "The artifacts routes require a `DB` D1 binding." });
  return artifactsStore(artifactsDatabase(db));
}
