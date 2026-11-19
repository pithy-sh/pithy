# Moderation

Text one person writes and others see — a handle, a level title, a report reason — gets checked before it is shown. Pithy has one seam for that check: `c.var.moderator`. It is on every request, with or without config, like `c.var.t`.

## The interface

```ts
const verdict = await c.var.moderator.check(text, context);
// { verdict: "allow" }
// { verdict: "reject", reason: "blocklist" }
// { verdict: "review", reason: "moderator_timeout" }
```

`context` says what the text is: `handle`, `title` or `free_text`. A moderator can hold one to a stricter bar than another. The verdict schema is `ModerationVerdict`, and the interface is `TextModerator`, both from `@pithy-sh/core/src/moderation/moderator`.

The caller decides what each verdict means. `reject` is a refusal. `review` asks a person to look, and whether the text waits for that look or shows in the meantime is your call.

## Checking a title in a route

```ts
import { requireAuth } from "@pithy-sh/auth/src/http/middleware";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import { z } from "zod";

const CreateLevel = z
  .object({ title: z.string().min(1).max(60).describe("The level's title, shown in the level browser.") })
  .describe("A level to publish.");

const LevelCreated = z
  .object({ held: z.boolean().describe("Whether the level waits for a person to look before it is listed.") })
  .describe("The level was saved.");

export const app = defineCapability({
  name: "app",
  requiredBindings: [],
  routes: (a) => {
    a.post(
      "/levels",
      describeRoute({
        summary: "Publish a level.",
        verification: ["bearer", "session"],
        responses: { 201: LevelCreated },
      }),
      requireAuth(),
      validate("json", CreateLevel),
      async (c) => {
        const { title } = c.req.valid("json");
        const verdict = await c.var.moderator.check(title, "title");
        if (verdict.verdict === "reject") throw new ValidationError({ message: "Pick another title." });
        const held = verdict.verdict === "review";
        // Save the level with `held`, and list only what is not held.
        return c.json({ held } satisfies z.output<typeof LevelCreated>, 201);
      },
    );
  },
});
```

The refusal message names no word. Telling someone which word tripped the list teaches them the next spelling to try.

## The default

With no config, the moderator checks a blocklist the kit ships: English slurs, sexual terms and profanity. The words come from the English dataset of [obscenity](https://github.com/jo3-l/obscenity), MIT, with its notice kept in `packages/core/src/moderation/shippedList.ts`.

Both the text and the list are folded before they are compared:

- Case and width: `SHIT`, `ｓｈｉｔ` and `𝐬𝐡𝐢𝐭` are one word.
- Accents and stacked combining marks are dropped.
- Characters that stand in for a letter fold onto it: `$h1t`, a Cyrillic `ѕ` or `һ`, a Greek `τ`, small capitals such as `ᴛ`. A capital folds by its own shape, so a Greek `Ν` is an `N`. `l`, `I` and `1` are one letter.
- A word made only of digits is a number and is never read as letters, so `Level 455` and `dave717` are allowed. A digit stands in for a letter only in a word that has a letter in it.
- Invisible characters inside a word are removed, so a zero-width space hides nothing.

Then each word is matched whole. A listed word inside a longer one is allowed, and so are its letters split across two words: `ass` rejects `ass` and allows `class` and `as sorted`. A name is also read as its parts (`BigShit` as `big shit`, `shit99` as `shit 99`), and letters spelled out one at a time as one word (`s h i t`, `s.h.i.t`). Any reading that matches rejects.

The default answers only `allow` or `reject`. `review` is for a classifier that can be unsure, and for the seam when a moderator fails.

## Config

The `moderation` block of a Worker's `pithy.config.ts`, beside `capabilities` and `app`:

```ts
const config = {
  capabilities: [/* … */],
  app,
  moderation: {
    words: ["griefer", "speed run*", "cheat code"],
  },
};
```

- `words` adds to the shipped list. A word ending in `*` matches every word that starts with it. Several words match in order, or run together.
- `includeShipped: false` drops the shipped list, so `words` is the whole list.
- `moderator` replaces the default with your own.
- `timeoutMs` is how long the moderator has to answer. Defaults to 3000.

A block that does not parse refuses to deploy, and so does a `moderator` beside `words` or `includeShipped`, which it would never read.

## Your own moderator

Anything with an async `check(text, context)` that answers a verdict. To keep the list and add a classifier, put `blocklistModerator` inside yours:

```ts
import { blocklistModerator } from "@pithy-sh/core/src/moderation/blocklist";
import type { TextModerator } from "@pithy-sh/core/src/moderation/moderator";
import { SHIPPED_BLOCKLIST } from "@pithy-sh/core/src/moderation/shippedList";

const list = blocklistModerator({ words: [...SHIPPED_BLOCKLIST, "griefer"] });

const moderator: TextModerator = {
  async check(text, context) {
    const listed = await list.check(text, context);
    if (listed.verdict !== "allow") return listed;
    const score = await classify(text); // your Workers AI or third-party call
    if (score > 0.9) return { verdict: "reject", reason: "classifier" };
    if (score > 0.5 || (context === "handle" && score > 0.3)) return { verdict: "review", reason: "classifier_unsure" };
    return { verdict: "allow" };
  },
};
```

## When a moderator fails

The seam never answers `allow` for a moderator it could not hear from. A throw, a rejected promise, or an answer that is not a verdict is `review` with `moderator_failed`. No answer within `timeoutMs` is `review` with `moderator_timeout`. Each is logged as a warning with the context, never the text.
