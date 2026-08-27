# @pithy-sh/matchmaking

Find competitors. Room codes, direct invites, a friend graph, and a skill-bucketed queue — every path lands two or more players in the same authoritative [`@pithy-sh/multiplayer`](../multiplayer) session.

Multiplayer gives you a session once players are in it. This is how they get there. Four ways, one output: a session id.

**Documentation: [pithy.sh/docs/capabilities/matchmaking](https://pithy.sh/docs/capabilities/matchmaking).** Overview, adding it, provisioning, using it, and the reference: the four ways in, the queue and its sweep.

_Everything else is on the site. `pithy.sh/docs` is canonical — new prose goes there, not here._

## Add it

```bash
pithy add matchmaking
```

That installs the package and writes four bindings into every environment of your Worker's `wrangler.jsonc` — `DB`, `MATCHMAKING`, and the `QUEUE` and `PRESENCE` Durable Object namespaces — together with the `new_sqlite_classes` class migration tags the two Durable Objects need. **That wiring is the reason this is a capability rather than a snippet.** A DO binding is one entry; a DO class migration tag is another, in a different block, repeated per environment, and getting it wrong deploys a Worker whose class does not exist.

One binding it writes without an id: a `kv_namespaces` entry has no name field, so `pithy add` prints the name to give the `MATCHMAKING` namespace in each environment. Create it in your account under that name and paste the id in.

`pithy add` also writes both classes into your worker entry, so wrangler's `class_name` resolves against it:

```ts
export { MatchmakingQueue } from "@pithy-sh/matchmaking/src/queue/durableObject";
export { MatchmakingPresence } from "@pithy-sh/matchmaking/src/presence/durableObject";
```

Each from its own module, never from the package entry point. That entry point is what `pithy.config.ts` imports, and that file is loaded by every Node-side `pithy` command — a Durable Object on that path imports `cloudflare:workers` and takes `pithy upgrade` down with it.

Finally:

```bash
pithy migrate
```

**This section stays here.** `src/capability.test.ts` holds those two export lines against the Durable Object classes the capability actually binds, and against the module each must come from. An instruction naming the package entry point would name a module that does not export them — a Worker that fails at bundle time, on the line the docs told somebody to write.

## License

MIT — adopter-side app value. The root `LICENSE` covers it.
