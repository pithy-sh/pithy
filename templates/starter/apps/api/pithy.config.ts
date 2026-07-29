// apps/api/pithy.config.ts — what THIS Worker is made of.
//
// Every Worker under apps/ has its own config. Capabilities are per-Worker
// because everything they drive is per-Worker: the composed route tree, the
// bindings written into this Worker's wrangler.jsonc, and Durable Object class
// migrations (which register a class against a specific script).
//
// Two Workers share a resource by declaring the SAME binding name — feature
// resource names are derived from the binding, not the Worker — so two Workers
// that both declare `DB` are backed by one D1. A Worker that wants its own
// declares a different binding (e.g. COLLAB_DB).

import { defineCapability } from "@pithy-sh/core/src/capability/capability";

// Your app is a capability like any other: routes, middleware, databases, KV
// namespaces, and the bindings they need. It composes last, after every
// library capability.
const app = defineCapability({
  // The app's capability name. Also its migration namespace once it has tables.
  name: "app",
  // Bindings your own routes need beyond what capabilities declare. Validated
  // on the first request — a missing binding fails fast with the binding's name.
  requiredBindings: [],
  // Mount your routes here. Every route declares how callers are verified —
  // bearer, session, signed-webhook, or public. `GET /health` is built in.
  // routes: (a) => {
  //   a.get("/hello", (c) => c.text("Hi."));
  // },
});

const config = {
  // Library capabilities this Worker composes, in order.
  // `pithy add <capability> --worker api` registers them here.
  capabilities: [
    // pithy:capabilities (managed region — do not remove this marker)
  ],
  app,
};

export default config;
