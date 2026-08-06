import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The Workers-runtime project: `*.workers.test.ts` runs inside workerd, against a real D1 database and
// a real KV namespace that Miniflare creates per run and throws away after. No mocks, no fakes.
//
// The bindings here are declared for the *test* runtime, not read from a Worker's wrangler.jsonc — one
// test run covers every Worker under apps/, and they do not all declare the same bindings. Add a
// binding here when a capability you compose needs one; `pithy add <capability>` writes it into the
// Worker's wrangler.jsonc, and this file is the matching statement for tests.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-06-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        kvNamespaces: ["SESSIONS"],
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["apps/*/src/**/*.workers.test.ts"],
  },
});
