---
"@pithy-sh/support": minor
"@pithy-sh/ui-react": minor
---

Support publishes a client-safe projection. `virtual:pithy/support` carries the mount path and the submission bounds, so a browser stops writing its own copy of both.

`POST {basePath}/feedback` is the one route on this capability an end user's client calls, and until now the only way for that client to know where it was mounted was to hardcode the path. Move `basePath` in `pithy.config.ts` and the Worker mounts elsewhere while the client keeps posting to `/support/feedback`, which answers 404 — and a 404 on a write reads to the person pressing Send as *the request did not go*, indistinguishable from a server that is down. Nothing in either program fails to compile.

```ts
import support from "virtual:pithy/support";

if (support.enabled) {
  await fetch(`${support.basePath}/feedback`, { method: "POST", /* … */ });
}
```

Beside `basePath` are the bounds a compose form should hold somebody to before it lets them send: `submission.maxSubjectChars`, `submission.maxBodyChars`, and `submission.attachments` — `maxCount`, `maxBytes`, `allowedContentTypes`, or `null` when attachments are off and no file picker should render. A form that stops at 200 characters because the handler refuses at 200 characters is a better form than one that finds out afterwards.

**`{ enabled: false }` when `submission.enabled` is false.** The feedback routes are not mounted then — they answer 404 — so a browser has nothing here to call and no use for a path. A screen branches once, exactly as it does for a payments catalog with nothing in it.

**The taxonomy is deliberately not projected.** A category's value is the instruction a model reads and it lands in the prompt verbatim: prompt input written for a classifier, not copy for a chooser, and an adopter's UI wants its own words for a category either way. Nor are the inbox addresses, the canned replies, the classifier settings, the mail path's bounds, or `maxPerAccountPerHour` — a rate no client can pre-enforce honestly, since the count lives in D1 and the server's refusal is the only truth about it.

The scaffold's `client-env.d.ts` declares the module, so a screen written later type-checks with no path mapping.
