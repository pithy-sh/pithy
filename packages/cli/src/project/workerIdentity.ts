// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { WorkerTarget } from "./workers";

/**
 * The two names a Worker answers to, as every `--json` payload reports them.
 *
 * ## Why this is one function and not six spellings
 *
 * A Worker has two identities and they are not interchangeable: the directory under `apps/`, and the
 * script name it deploys as. `pithy init --worker board` creates `apps/board/`, and #100 stamps
 * `wrangler.jsonc` with `<project>-<worker>` — so the same Worker is `board` and `dash-board`, and
 * environments suffix the second again (`dash-board-staging`).
 *
 * The CLI used to pick between them per command. `init`, `ui add` and `ui sync` reported the directory;
 * `add`, `remove`, `upgrade` and `worker sync` reported the deployed name. One field, two meanings, and
 * nothing in the payload saying which — so anyone scripting the CLI had to know which half of it they
 * were in. That is pithy-sh/pithy#144.
 *
 * ## Why `worker` is the directory
 *
 * It is the name the adopter typed, and the one they can act on. It is what `--worker` accepts, what
 * they `cd` into, and what every path in the same payload is relative to — a payload reporting
 * `dash-board` beside `created: ["src/client.tsx"]` describes a directory that does not exist.
 *
 * The deployed name is derived from it and suffixed per environment, which makes it the less stable of
 * the two and the wrong thing for a script to key on. It is still worth reporting — it is what appears
 * in the Cloudflare dashboard and in `wrangler deploy` — so it gets its own field instead of overloading
 * this one.
 *
 * ## The failure this is shaped to prevent
 *
 * Read the directory. Never derive it from the deployed name by stripping a project prefix: a
 * `wrangler.jsonc` is free to name the Worker anything, `pithy worker rename` can leave the two
 * unrelated, and a prefix strip turns `board`/`board-worker` into nonsense. The directory is a fact on
 * disk; the deployed name is a string in a config file.
 */
export interface WorkerIdentity {
  /** The `apps/` directory. What `--worker` names, and what sibling paths are relative to. */
  worker: string;
  /** The deployed script name, from `wrangler.jsonc`. What Cloudflare shows. */
  deployedAs: string;
}

/** Both names for `target`, for a `--json` payload. */
export function workerIdentity(target: Pick<WorkerTarget, "name" | "dir">): WorkerIdentity {
  return { worker: basename(target.dir), deployedAs: target.name };
}
