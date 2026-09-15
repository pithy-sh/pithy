---
"@pithy-sh/cloudflare": minor
"@pithy-sh/cli": patch
---

`pithy feature destroy` finishes for a feature whose Workers call each other.

Cloudflare refuses to delete a Worker another Worker still binds unless the delete is forced. Teardown deleted a
feature's scripts in `apps/` order without forcing, so `apps/web` calling `apps/api` put the callee first: the
delete was refused, nothing else was removed, the manifest was kept, and every re-run failed the same way.

**Each script teardown deletes is now forced.** Every one is the feature's own and goes in the same pass. Deleting
callers first was the alternative, and it needs a graph teardown does not have: a recorded script may belong to a
Worker that has left the branch, Durable Object bindings reach siblings too, and two Workers can call each other.
Forcing also removes the Durable Objects a feature Worker hosts, which are the feature's.

`CloudflareWorkersManager.deleteWorker` takes `{ force }`. Without it, nothing changes for any other caller.
