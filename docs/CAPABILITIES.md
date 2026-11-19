# Capability routes

A capability's routes load on the first request that reaches them. Not at Worker startup.

Cloudflare refuses a version whose startup runs past its CPU limit (code 10021). Every route module, every Zod schema it builds and everything it imports costs startup CPU when it is evaluated. So a capability hands core two things: the methods and paths it serves, and a loader for the module that mounts them. Core registers the paths at startup. It imports and mounts the module on the first request that matches one.

This page is for anyone writing a capability: a kit package, a capability built outside the kit, or your own `app`.

## The shape

`Capability.routes` is `{ declared, load }`, typed `CapabilityRoutes` in `@pithy-sh/core/src/http/lazyRoutes`.

```ts
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { declareRoutes } from "@pithy-sh/core/src/http/lazyRoutes";

export function notes(options: { basePath?: string } = {}) {
  const base = options.basePath ?? "/notes";
  return defineCapability({
    name: "notes",
    requiredBindings: [{ type: "d1", name: "DB" }],
    routes: {
      declared: declareRoutes(base, [
        ["GET", ""],
        ["POST", ""],
        ["GET", "/:id"],
        ["DELETE", "/:id"],
      ]),
      load: async () => (await import("./http/routes")).registerNotesRoutes({ basePath: base }),
    },
  });
}
```

- `declared` lists every method and path the module mounts. A route mounted with `app.all` is declared with the method `ALL`, and so is an `app.use` path, unless a declared `ALL` wildcard already covers it (`/notes/*` covers `/notes/sign-in`).
- `load` imports the module and returns its mount: `(app, host) => void`. `app` holds this capability's routes alone. `host.composed` is the Worker's whole app, for a capability that dispatches into it or reads its route table.
- The module behind `load` must not be imported anywhere else at startup: not by the file that defines the capability, not by the package's entry. A static import anywhere puts it back in the startup bundle, whatever the loader says.

A function in `routes` is refused when the Worker assembles, with a message that names this shape.

## What stays the same

- **Order.** Core registers each capability's declared paths where its routes used to mount, so the router matches in the same order. A request the loaded module does not answer goes on to the next capability's routes, as before.
- **Middleware.** A request reaches a not-yet-loaded route behind everything it sat behind before: CORS, the base context, every capability's `middleware`, and the readiness guards. A request one of them refuses never loads the module.
- **One build.** The module loads once, however many first requests arrive together. A load that fails is tried again on the next request.
- **Context.** The module's routes see every `c.var` the Worker set, every header its middleware prepared and a body it already read. Variables they set, headers on an error the Worker answers, and errors themselves come back out.
- **An `app.use` in the module runs only for requests that enter it.** Declaring its path is what sends every request it matches into the module, so a guard there still runs ahead of a later capability's route. What it does after `await next()` sees only this capability's responses: middleware that wraps other capabilities' routes belongs in `middleware`. `routeDrift` names an `app.use` the table does not cover.
- **One request, two contexts.** The loaded routes run in a context of their own, so state a middleware keeps per request outside `c.var` is keyed on `c.req.raw`, which both contexts share, never on `c`.

## What moves

- **The route table is read after loading.** `routeGroupsOf(app)` (`@pithy-sh/core/src/openapi/routeGroups`) is async now: it loads every capability's routes and resolves to the finished groups. `pithy contract`, the MCP endpoint and the control-plane manifest all read through it.
- **A wrong tool declaration is refused when the route table is read**, by `routeGroupsOf`, rather than at assembly: no route's `describeRoute` exists before its capability loads. `pithy deploy` reads every Worker's table under `apps/` before it uploads anything, so the refusal still stops the deploy. A route module that cannot load outside workerd is not read there; the Worker refuses it on the first read instead.
- **A message key outside its capability's domain is still refused at assembly.** Only the keys are read then. The catalogs merge on the first message rendered.
- **Scope gates are declared, not derived.** `scopeGates` lists each route a scope gates, built from the same config as the routes. Pin the list in a test beside the routes' own `describeRoute({ scopes })`: nothing reads those before the routes load.
- **A declared table that reads a peer is a getter.** When which routes mount depends on what else is composed, read it in `get declared()`. Core reads `declared` after every `compose` hook has run.

## Everything else a request needs

Routes are the largest part of a capability, not the only part a Worker can put off. Anything that runs only when a request, a message or a command reaches it loads with that, through the helpers in `@pithy-sh/core/src/capability/deferred`:

- `deferredMiddleware(load)` registers a middleware whose handler module is imported on the first request it sees: `app.use("*", deferredMiddleware(async () => (await import("./http/session")).handler))`. The kit's session middleware loads Better Auth this way.
- `deferred(load)` is a function whose implementation is imported on its first call. An `email` handler, a queue handler or a listener is one: `email: deferred(async () => (await import("./inbound/handler")).handle)`.
- `deferredSettings(load, { account })` is a `settings` check `pithy doctor` imports when it runs. Say whether it has an account half, since a caller reads that before calling it.
- `deferredValue(build)` builds a value once, on first use, and hands every caller the same one.

Each loads once, however many calls arrive together, and tries again after a load that fails.

What the Worker reads while it assembles stays eager: `declared`, `config`, `requiredBindings`, `databases`, `secretRegistry`, `workflows`, `sockets` and anything a `compose` hook reads. Keep the modules behind them small. A constant that sits in a module full of schemas, read by the capability's file, puts every schema in that module on the Worker's startup; move it into a module of its own.

Declare `"sideEffects": false` in the package's `package.json`. A Worker's bundler then leaves out a module the package entry re-exports and nothing uses. A module imported only for what it does when it loads, `import "./builtins"`, is listed by path instead, in its source and its built form, so neither tsdown nor the Worker's bundler drops it:

```json
"sideEffects": ["./src/game/builtins.ts", "./dist/game/builtins.js"]
```

`packages/cli/src/ci/sideEffects.test.ts` holds every kit package to this.

## Keeping the table true

`routeDrift(routes)` loads a capability's module and compares what it mounts against what it declares. Hold both lists empty in a test, for every configuration that changes which routes mount or where:

```ts
import { routeDrift } from "@pithy-sh/core/src/http/lazyRoutes";

test("declares exactly what it mounts", async () => {
  for (const capability of [notes(), notes({ basePath: "/memos" })]) {
    expect(await routeDrift(capability.routes!)).toEqual({ undeclared: [], unmounted: [] });
  }
});
```

An undeclared route is one no request reaches. An unmounted one answers as if it were never declared.

The kit runs this for every package in `packages/cli/src/openapi/kitRoutes.test.ts`, beside a check that no capability's startup imports reach the module its loader imports.

## Tests and small apps

`routesOf(mount)` builds `{ declared, load }` from a mount already in memory, reading the table off the mount itself. Nothing is deferred, so it saves no startup. It is for a test's capability, and for an `app` small enough that its startup does not matter.

`mountRoutes(routes, app)` loads a capability's routes and mounts them straight onto an app, for a test that wants one capability's routes in hand.

## Moving a capability built outside the kit

1. Move the route registration into a module of its own, if it is not already, and export its mount.
2. Remove every static import of that module from the capability's file and its package entry. Move any constant they needed into a small module of its own.
3. Write `declared`: every method and path the mount registers.
4. Set `routes: { declared, load: async () => (await import("./routes")).mount }`.
5. Add the `routeDrift` test above.

The startup gate (`tooling/startup/src/budget.ts`) shows the result on the kit's own reference Worker: `wrangler check startup` before and after, on one machine. It first starts each side's Worker once in workerd (`tooling/startup/src/starts.ts`), because `wrangler check startup` times a Worker whose startup threw as a fast one.
