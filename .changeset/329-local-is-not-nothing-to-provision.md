---
"@pithy-sh/cli": patch
---

`pithy env` said `local` where it meant "Miniflare is fine with this, and a bare deploy is not gated on it".

#320 was right that an id-less binding in the top-level stanza is not a deficiency: Miniflare serves D1 from the binding declaration, and `pithy dev` works because no Cloudflare resource is involved. But that stanza has a second job. A bare `pithy deploy` — `wrangler deploy` with no `--env` — ships it to Cloudflare, and it is the one deploy path with no `assertEnvironmentProvisioned` in front of it. Every `--env` deploy is refused before a binding with no id reaches wrangler (#240); this one is not.

So one word stood as the whole answer, and an operator reading `pithy env` before a deploy read it as *nothing to provision here*. The stanza now says the other half itself:

```
dev  local
  worker  dash-board
  DB (d1)  local
  Miniflare needs no id. A bare pithy deploy ships this stanza, and nothing gates it on one.
```

Once per stanza, because it is a fact about the stanza and not about each binding. And only where it is a fact: a local environment whose bindings all carry ids says nothing, and a deployed one already says `not provisioned`, which is the action item. A line under every environment would be the wallpaper #320 removed.
