// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type WorkerDir, workerDirOf } from "@pithy-sh/core/src/cli/command";

/**
 * A Worker's `apps/` directory name, as a fixture states one. `WorkerDir` is branded so a deployed script name
 * cannot reach `--worker` (#711); a fixture says which it means by building it here.
 */
export function dirOf(name: string): WorkerDir {
  return workerDirOf({ dir: `/project/apps/${name}` });
}
