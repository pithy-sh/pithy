---
"@pithy-sh/ui-react": patch
"@pithy-sh/cli": patch
---

A scaffolded front end mounts into a node it creates, so no renamed id can leave an empty page behind.

`index.html` declared `<div id="root">`, `src/client.tsx` found it with `getElementById("root")`, and then guarded `if (container) { … }`. The guard was the defect: rename the div — an ordinary edit to your own HTML — and the app rendered nothing, threw nothing, logged nothing. An empty document with a 200, a clean build and a green suite. It is the failure mode hardest to attribute, because the first three things anyone suspects are their own code, their build and their Worker, and none of them is wrong.

The page carries no mount node now. `client.tsx` creates the one it renders into, sets `#root` on it so the styling hook survives, and there is no second string for a rename to break. Anything you put in `<body>` is left alone; the app mounts after it.

`src/client.test.tsx` is seeded with it (#391): it builds the document an adopter who renamed the div would have — a mount node carrying a deliberately wrong id — and asserts the app rendered anyway. Code that looks an id up goes red there; only code that creates its own node passes. Proven able to fail in a scaffolded project by planting the old shape.

`routeGlob.test.ts` stops writing an `index.html` of its own too: it builds the seeded page, and its entry fixture carries the shape the templates now ship.
