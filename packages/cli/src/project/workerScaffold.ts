// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { NAMESPACE_PATTERN } from "@pithy-sh/core/src/migrations/registry";
import { PACKAGE_NAME, PACKAGE_VERSION } from "@pithy-sh/core/src/version.generated";
import { ensureEmptyTarget, kitRange, WORKER_NAME } from "./scaffold";

/**
 * The scaffolded app capability's name — which is also its **migration namespace**, and namespaces admit no
 * separators (`NAMESPACE_PATTERN`, `^[a-z][a-z0-9]*$`). A worker directory is kebab-case, so the two cannot
 * be the same string: stamping `admin-api` verbatim writes a config whose first migration is rejected.
 *
 * So the directory stays kebab-case and the namespace is derived from it — hyphens dropped, keeping the
 * worker's identity (`admin-api` → `adminapi`, distinct from every sibling's). A name that starts with a
 * digit cannot open a namespace, so it takes the `app` prefix the starter's own capability uses
 * (`2fa-api` → `app2faapi`).
 */
export function workerNamespace(name: string): string {
  const stripped = name.replace(/[^a-z0-9]/g, "");
  return NAMESPACE_PATTERN.test(stripped) ? stripped : `app${stripped}`;
}

/**
 * The wrangler every producer of a Worker manifest pins.
 *
 * Three write it: this file, `templates/starter/apps/api/package.json`, and the React stub `pithy ui add`
 * merges into a Worker. `scaffoldParity.test.ts` held it between the first two only, so the third could
 * drift from both unnoticed — a Worker whose front end and whose server deploy through different wrangler
 * majors. Exported and imported rather than restated, so there is one literal and one test holding it to
 * the template on disk.
 *
 * `@cloudflare/vite-plugin` peers on `wrangler ^4.115.0`; moving this alone will not resolve.
 */
export const WRANGLER_RANGE = "^4.115.0";

/**
 * The files `scaffoldWorker` stamps into `apps/<name>/`, generated inline (no template dir to resolve).
 *
 * The deploy name is `<project>-<name>`, the same shape `scaffoldProject` gives the first Worker — a Worker
 * script name is an account-flat Cloudflare name (CLAUDE.md §Resource naming), so the project segment is
 * the only thing keeping two projects apart. Stamping the bare directory name meant two projects that each
 * ran `pithy worker add admin` deployed to one script called `admin`, and the second `wrangler deploy`
 * silently replaced the first's live Worker.
 */
function workerFiles(name: string, project: string): Record<string, string> {
  const wrangler = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${project}-${name}",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],

  // Workers Logs, on by default (see the root worker for the full note).
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },

  // The deployed version of this Worker, injected by Cloudflare. Top level, so every environment
  // inherits it. It is what puts a build id on every log record and audit event, and what
  // \`pithy deploy\` reads back to prove this Worker is the one answering at your domain.
  "version_metadata": { "binding": "CF_VERSION_METADATA" },

  // The top level is the dev environment. Staging serves test users; production serves paid users.
  // All three vars repeat per environment: \`env.<name>.vars\` REPLACES this block rather than merging it.
  // \`PROJECT\` is the root pithy.config.ts name — the owner stamped into every Cloudflare Images and
  // Stream asset this Worker mints, since those stores are account-flat and key assets by their own id.
  // \`WORKER\` is this Worker's own apps/<name> directory. The runtime tells a script nothing about
  // itself, and Workers sharing a binding share one database, so this is what tells their events apart.
  "vars": {
    "ENVIRONMENT": "dev",
    "PROJECT": "${project}",
    "WORKER": "${name}"
  },
  "env": {
    "staging": {
      "vars": {
        "ENVIRONMENT": "staging",
        "PROJECT": "${project}",
        "WORKER": "${name}"
      }
    },
    "prod": {
      "vars": {
        "ENVIRONMENT": "prod",
        "PROJECT": "${project}",
        "WORKER": "${name}"
      }
    }
  }
}
`;

  const manifest = `{
  // How \`pithy dev\` runs this worker locally. This file is yours; wrangler.jsonc stays wrangler's.
  "dev": {
    // Must this run for the local environment to function? pithy dev starts exactly the autostart workers.
    "autostart": true,
    // Regex marking "ready" in this worker's output.
    "readySignal": "Ready on https?://"
    // "preferredPort": 8787   // a hint only — the feature's reserved port block is authoritative.
    // "command": ["bun", "run", "dev"]   // set this for a non-Worker process (e.g. a Vite frontend).
    //   {port} in any element of command becomes this worker's pinned port. pithy dev spawns with no
    //   shell, so an env var like $PORT on the argv would stay a literal.
  }
}
`;

  // The kit range, by the same rule `pithy init` stamps into the first Worker — `kitRange` imported from
  // there rather than restated, because a second copy of the rule is a second thing to forget. `null`
  // while nothing under `@pithy-sh/*` is published, and then the line is omitted outright: a `"^0.0.0"`
  // here 404'd the install this command runs, which is how the second Worker in a project came out
  // half-made. A published version writes the range with no change to this file.
  const kit = kitRange(PACKAGE_VERSION);
  const pkg = `${JSON.stringify(
    {
      // `<project>-<worker>`, matching both the deploy name above and what `pithy init` gives `apps/api`,
      // so a workspace never holds two `admin` packages when a second project is checked out beside it.
      name: `${project}-${name}`,
      private: true,
      type: "module",
      // Every field below is held equal to the starter template's by `scaffoldParity.test.ts`. This file
      // and that template are the project's two Worker producers, and only one of them is ever the file
      // somebody remembers to edit — which is how the pins here fell a major version behind.
      engines: { node: ">=22" },
      scripts: {
        dev: "wrangler dev",
        deploy: "wrangler deploy",
        "deploy:staging": "wrangler deploy --env staging",
        "deploy:prod": "wrangler deploy --env prod",
      },
      dependencies: { ...(kit === null ? {} : { [PACKAGE_NAME]: kit }), hono: "^4.12.0" },
      devDependencies: { "@cloudflare/workers-types": "^5.20260729.1", wrangler: WRANGLER_RANGE },
    },
    null,
    2,
  )}\n`;

  // Same settings as the starter's `apps/api/tsconfig.json` — every Worker in a project typechecks alike,
  // with the Workers globals its `src/index.ts` is written against. Workers have no root config to inherit.
  const tsconfig = `{
  // Matches the Pithy toolchain defaults: strict, ESM-only, TS-7 ready.
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types"],
    // Referenced from the root solution file, which requires \`composite\` — and \`composite\` makes tsc
    // write build state. It goes under the PROJECT's \`dist/\`, already gitignored, and deliberately not
    // under this Worker's: once this Worker carries a UI, Vite owns \`apps/<worker>/dist\` and empties it
    // on every build, which would throw the incremental state away each time.
    "composite": true,
    "tsBuildInfoFile": "../../dist/${name}.server.tsbuildinfo",
    "noEmit": true
  },
  "include": ["src/**/*.ts", "pithy.config.ts"]
}
`;

  const config = `// apps/${name}/pithy.config.ts — what THIS Worker is made of.
//
// Every Worker under apps/ has its own config. Capabilities are per-Worker because everything
// they drive is per-Worker: the composed route tree, the bindings written into this Worker's
// wrangler.jsonc, and Durable Object class migrations (which register a class against a script).
//
// Two Workers share a resource by declaring the SAME binding name — feature resource names are
// derived from the binding, not the Worker — so two Workers that both declare \`DB\` are backed by
// one D1. A Worker that wants its own declares a different binding (e.g. ${name.toUpperCase().replace(/-/g, "_")}_DB).

import { defineCapability } from "@pithy-sh/core/src/capability/capability";

const app = defineCapability({
  // The app's capability name. Also its migration namespace once it has tables, which is why it carries no
  // hyphens: a namespace is lowercase letters and digits, starting with a letter.
  name: "${workerNamespace(name)}",
  // Bindings this Worker's own routes need beyond what capabilities declare.
  requiredBindings: [],
  // Mount your routes here. Every route declares how callers are verified.
  // routes: (a) => {
  //   a.get("/hello", (c) => c.text("Hi."));
  // },
});

const config = {
  // Library capabilities this Worker composes, in order.
  // \`pithy add <capability> --worker ${name}\` registers them here.
  capabilities: [
    // pithy:capabilities (managed region — do not remove this marker)
  ],
  app,
};

export default config;
`;

  const index = `import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import config from "../pithy.config";

// The Worker. createEntrypoint assembles this Worker's capabilities into an entrypoint:
// \`fetch\` is one Hono app (typed db/kv registries per request, fail-fast binding validation,
// GET /health), and \`email\` fans inbound mail to every capability that handles it.
export default createEntrypoint(config);
`;

  return {
    "wrangler.jsonc": wrangler,
    "pithy.worker.jsonc": manifest,
    "pithy.config.ts": config,
    "package.json": pkg,
    "tsconfig.json": tsconfig,
    "src/index.ts": index,
  };
}

/**
 * Scaffold `apps/<name>/` — a new worker in the registry: its `wrangler.jsonc`, its `pithy.worker.jsonc`
 * manifest, its `pithy.config.ts`, its `package.json`, its `tsconfig.json`, and a `src/index.ts` mount file.
 * The same set `pithy init` gives `apps/api`, so a worker added later is not a second-class one on different
 * TypeScript settings. Additive: it never touches any sibling. The `.dev.vars` symlink and the port
 * reconcile are the command's job, not the scaffold's.
 *
 * `project` is the root `pithy.config.ts` name, resolved by the caller through `requireProjectName` (never
 * guessed — CLAUDE.md §Resource naming). It leads the Worker's **deploy name** (`<project>-<name>`, an
 * account-flat Cloudflare namespace) and its package name, and it is stamped as the `PROJECT` var in every
 * environment stanza, which is what lets this Worker mint attributable Cloudflare Images and Stream assets.
 */
export async function scaffoldWorker(options: {
  projectDir: string;
  name: string;
  project: string;
}): Promise<{ dir: string }> {
  if (!WORKER_NAME.test(options.name)) {
    throw new ValidationError({
      message: `Worker name must be kebab-case (got "${options.name}").`,
      action: "Use lowercase words joined by hyphens, e.g. web or admin-api.",
    });
  }

  // The gate runs **before** the directory is made, not after. A symlink at `apps/<name>` is refused
  // rather than created through (see `ensureEmptyTarget`), and a *dangling* one is ENOENT to a recursive
  // `mkdir` — a raw node:fs error escaping the PithyError contract `withErrorReporting` prints from.
  // Nothing created also means `addWorker` has nothing to roll back, which is the other half of that fix.
  const dir = join(options.projectDir, "apps", options.name);
  await ensureEmptyTarget(dir);
  await mkdir(dir, { recursive: true });

  const files = workerFiles(options.name, options.project);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return { dir };
}
