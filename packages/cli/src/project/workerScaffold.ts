import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { NAMESPACE_PATTERN } from "@pithy-sh/core/src/migrations/registry";
import { ensureEmptyTarget, WORKER_NAME } from "./scaffold";

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

/** The files `scaffoldWorker` stamps into `apps/<name>/`, generated inline (no template dir to resolve). */
function workerFiles(name: string): Record<string, string> {
  const wrangler = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "${name}",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],

  // Workers Logs, on by default (see the root worker for the full note).
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },

  // The top level is the dev environment. Staging serves test users; production serves paid users.
  "vars": {
    "ENVIRONMENT": "dev"
  },
  "env": {
    "staging": {
      "vars": {
        "ENVIRONMENT": "staging"
      }
    },
    "production": {
      "vars": {
        "ENVIRONMENT": "production"
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
  }
}
`;

  const pkg = `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: { dev: "wrangler dev", deploy: "wrangler deploy" },
      dependencies: { "@pithy-sh/core": "^0.0.0", hono: "^4.12.0" },
      devDependencies: { "@cloudflare/workers-types": "^4.20260610.1", wrangler: "^4.99.0" },
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
 */
export async function scaffoldWorker(options: { projectDir: string; name: string }): Promise<{ dir: string }> {
  if (!WORKER_NAME.test(options.name)) {
    throw new ValidationError({
      message: `Worker name must be kebab-case (got "${options.name}").`,
      action: "Use lowercase words joined by hyphens, e.g. web or admin-api.",
    });
  }

  const dir = join(options.projectDir, "apps", options.name);
  await mkdir(dir, { recursive: true });
  await ensureEmptyTarget(dir);

  const files = workerFiles(options.name);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return { dir };
}
