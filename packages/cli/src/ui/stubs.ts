// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { PackageManager } from "../project/packageManager";
import { reactStub } from "./react";

/**
 * The framework-stub contract — everything `pithy ui` needs to scaffold a front end into a Worker and
 * everything `pithy dev` and `pithy deploy` need to run and build it afterwards. Nothing more abstract
 * than that: React 19 is the only stub today, so the interface describes the two jobs a stub actually
 * has (write files, declare its commands) rather than a framework model invented against one example.
 */

/** What a stub is told about the Worker it is being scaffolded into. */
export interface UiStubContext {
  /**
   * The target Worker's **directory** name — the `<name>` in `apps/<name>`.
   *
   * Not its deployed name: a Worker deploys as `<project>-<worker>`, and every use of this value is a path
   * or a build-state file that sits beside the ones `pithy init` already named after the directory.
   */
  worker: string;
  /** Whether to write the auth template (the passwordless screens) on top of the bare SPA. */
  auth: boolean;
  /**
   * Whether to write the payments screens — the paywall and the subscription status page.
   *
   * A second capability-gated screen set, chosen exactly the way `auth` is. It rides on the target Worker
   * composing `payments`, and it stacks: a Worker with both gets both, because the groups name disjoint
   * files over one layout.
   */
  payments: boolean;
  /** The project's package manager — what the generated docs and commands tell the adopter to run. */
  packageManager: PackageManager;
}

/** One file a stub writes: where it comes from in the template tree, and where it lands in the Worker. */
export interface UiStubFile {
  /** Path within the stub's `templateDir`. */
  source: string;
  /** Path relative to `apps/<worker>/`. Usually the same as `source`, but not always — the bare
   *  template's home screen lives beside the auth one as `home.bare.tsx` so both compile in place. */
  target: string;
}

/** One framework stub: the files it writes, the packages it needs, and how it is run and built. */
export interface UiStub {
  /** The positional `pithy ui add <framework>` takes, e.g. `react`. */
  id: string;
  /** One line, for `pithy ui list`. */
  description: string;
  /**
   * The root of this stub's template tree — real files on disk, in the stub's own template library
   * (`@pithy-sh/ui-react` for React).
   *
   * They are real files rather than string literals so that CI typechecks them and Biome lints them:
   * ~800 lines of React that only ever existed as a template literal is 800 lines no gate can see.
   * They live in a separate package because a framework's templates need that framework's toolchain
   * to be checked — folding them in here would make the CLI carry every framework's devDependencies
   * and every framework's tsconfig, to typecheck files it only ever copies.
   *
   * The tree mirrors the scaffolded layout exactly, which is what lets a screen's `../../router`
   * import resolve in the template as well as in the Worker it is copied into.
   */
  templateDir: string;
  /**
   * Every file this stub writes, for a given context. **Pure** — no filesystem, no clock, no
   * randomness — so the whole file set is assertable as a value in a test, and so the
   * create-never-overwrite check can see every target path before anything is read or written.
   * {@link loadStubFiles} is what turns this declaration into contents.
   */
  manifest(context: UiStubContext): UiStubFile[];
  /**
   * Literal tokens replaced in every template's text, e.g. `__PITHY_WORKER__` → the Worker's name.
   * Pure, and deliberately tiny: a template that needs more than a name substituted is a template
   * that should have been two files.
   */
  substitutions(context: UiStubContext): Record<string, string>;
  /** Runtime dependencies merged into the Worker's `package.json`. */
  dependencies: Record<string, string>;
  /** Build-time dependencies merged into the Worker's `package.json`. */
  devDependencies: Record<string, string>;
  /**
   * The dev argv **without** a package-manager prefix, for a given port. `wire` runs it through the
   * adopter's `execArgs` before persisting, so a Bun project gets `bun x vite dev …` and an npm project
   * `npx vite dev …` — the same rule `buildCommand` follows, and the reason adoption is never gated
   * behind Bun. `--strictPort` is not optional: without it Vite silently increments off a busy port,
   * which breaks Pithy's rule that ports are assigned at feature creation, never probed at startup.
   */
  devCommand(port: string): string[];
  /** Regex source marking "ready" in this process's output — `pithy dev` matches it to release the gate. */
  readySignal: string;
  /** The build argv, run through the adopter's package manager before `wrangler deploy`. */
  buildCommand: string[];
  /**
   * The `package.json` scripts merged into the target Worker — the adopter's own entry points, for
   * when they reach past `pithy dev`/`pithy deploy` and run the tool directly.
   *
   * Declared by the stub rather than hardcoded by the wiring, because they must not drift from
   * {@link devCommand} and {@link buildCommand}. They carry the same flags for the same reasons: a
   * `build` script missing `--configLoader runner` fails to load `vite.config.ts` at all, and the
   * adopter meets that as a raw Node resolution error on the most ordinary command there is.
   */
  scripts: Record<string, string>;
}

/** Every framework stub `pithy ui add` can scaffold, keyed by its `id`. */
export const UI_STUBS: Record<string, UiStub> = {
  [reactStub.id]: reactStub,
};

/** The stub a `<framework>` positional names, or an actionable error pointing at `pithy ui list`. */
export function resolveStub(id: string): UiStub {
  const stub = UI_STUBS[id];
  if (!stub) {
    throw new NotFoundError({
      message: `No UI stub named "${id}".`,
      action: `Run pithy ui list to see the frameworks you can add. Known: ${Object.keys(UI_STUBS).join(", ")}.`,
    });
  }
  return stub;
}
