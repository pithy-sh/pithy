# Testing a Workflow

_The reader's version of this page is [pithy.sh/docs/build/operations/test-your-backend](https://pithy.sh/docs/build/operations/test-your-backend). This copy stays in the kit because `packages/core/src/testing.ts` sends an adopter to it by name._

A Workflow runs in workerd, so its tests are `*.workers.test.ts` and run through `@cloudflare/vitest-plugin`, against the real Workflows engine Miniflare runs. This page covers what that suite needs, how to drive an instance, and how to hold a step at a chosen point so two runs can be tested interleaving. `packages/core/src/testing.workers.test.ts` is the worked example.

## What the test config needs

Three things. `pithy add` writes a capability's test bindings; a Workflow of your own is wired by hand.

- **A `main` module that exports the class.** workerd loads a Workflow's class from the module `cloudflareTest({ main })` names in `vitest.workers.config.ts`, at the project root. The scaffolded config sets no `main`, so add one, such as `main: "./apps/<worker>/src/test-main.ts"`, and export `CollectWorkflow` from that module.
- **A `workflows` entry in the Miniflare config** of the same `vitest.workers.config.ts`, naming the binding, the Workflow name and the class: `workflows: { COLLECT: { name: "collect", className: "CollectWorkflow" } }`.
- **A matching binding on `Cloudflare.Env`** in `apps/<worker>/src/cloudflare-test.d.ts`, typed with the Workflow's params: `COLLECT: Workflow<CollectParams>`.

## Driving an instance

`introspectWorkflowInstance` from `cloudflare:test` watches one instance by id. Open it before you create the instance, dispose it with `await using`, and wait on its status rather than on a timer.

```ts
import { env, introspectWorkflowInstance } from "cloudflare:test";

await using instance = await introspectWorkflowInstance(env.COLLECT, "run-1");
await env.COLLECT.create({ id: "run-1", params: {} });
await instance.waitForStatus("complete");
expect(await instance.getOutput()).toEqual({ written: 3 });
```

## Holding a step: `createGate`

Testing two runs that overlap — a cron run over a manual one, a retry over the original — means stopping one run mid-step, starting the other, and releasing the first when the test says so. `createGate` from `@pithy-sh/core/testing` is that stop. A gate is a flag: one side calls `open()`, the other waits on `opened()`.

The step reaches the gate through a seam the test injects, such as the fetcher the Workflow calls. Use two gates per held run: `held`, which the step opens when it arrives, and `release`, which the test opens to let it go.

```ts
import { createGate } from "@pithy-sh/core/testing";

const held = createGate({ name: "first run held" });
const release = createGate({ name: "first run released" });

// In the fetcher the test injects, which the step calls:
held.open();
await release.opened();

// In the test:
await env.COLLECT.create({ id: "first", params: {} });
await held.opened();
// start the second run, assert on the overlap, then:
release.open();
```

Open every `release` gate in a `finally`, so a failed assertion does not leave a step waiting while the introspector is disposed.

A wait that runs out throws an `InternalError` naming the gate. `timeoutMs` sets how long, 30 000 by default, and `pollMs` how often it checks, 5 by default.

## Never await a promise the other side settles

**A step must not await a promise settled from the test, and the test must not await a promise settled from a step.** That rules out the obvious gate, a `new Promise` the test resolves.

The test and each step run in separate request contexts. workerd ties a promise's continuations to request contexts, and it does not count a promise another request will settle as pending work in the one waiting on it. A step parked on the test's promise has nothing of its own pending, so workerd can cancel it as hung ("detected that your Worker's code had hung"). Disposing the instance's introspector then waits for a step that will never finish, so the test times out and the assertion that failed is never reported. Whether it fires depends on what else both sides have in flight, so a test that passes alone can hang in a busier suite.

`createGate` avoids the cross-context await: `opened()` checks a plain flag on a `setTimeout` of the waiting side's own. Each side waits on its own timer, and nothing either side awaits is settled by the other.
