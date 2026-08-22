// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { truncateToBytes } from "./truncate";

/**
 * HTML sanitization for inbound mail, through the runtime's own streaming parser.
 *
 * This capability ingests attacker-controlled content and a dashboard renders it. That is the
 * highest-risk sentence in the package, so the sanitizer is built on `HTMLRewriter` — workerd's real
 * HTML parser — rather than on regular expressions. A regex sanitizer is a list of the tricks its
 * author thought of; a parser-based one strips what the browser will actually see, which is the only
 * question that matters. It is also why this file has no dependencies: the safest HTML parser
 * available here already ships in the runtime.
 *
 * The policy is an **allowlist on both axes** — a small set of tags survives and a small set of
 * attributes survives — because a denylist is wrong the day a new attribute is invented, and a
 * support inbox will still be running then.
 *
 * `HTMLRewriter` is a Workers global, so it is touched only inside these functions. The module
 * imports cleanly under node (which the `.describe()` meta-test requires); its tests are
 * `.workers.test.ts`, running against the real parser rather than a stand-in for it.
 */

/**
 * Tags removed together with everything inside them.
 *
 * Two groups. The obvious executables (`script`, `iframe`, `object`, `embed`, `svg` — SVG is a
 * scripting context, not an image format), and the quiet ones: `style` because CSS can position an
 * invisible overlay over a real control, `link`/`base`/`meta` because they retarget or redirect the
 * whole document, `form` and its inputs because a phishing form rendered inside a trusted dashboard
 * is the most convincing phishing form there is, and `noscript`/`template` because their contents
 * are inert to the parser here and live to a browser later.
 */
const DROPPED_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "svg",
  "math",
  "noscript",
  "template",
  "title",
]);

/**
 * Attributes that survive, on any tag.
 *
 * Note what is absent and deliberate: `style` (see above), every `on*` handler, `srcset`/`ping`/
 * `formaction`, and every `data-*`. Nothing needs an allowlist entry to be dropped — anything not on
 * this list goes, which is what makes the policy hold against attributes that do not exist yet.
 */
const ALLOWED_ATTRIBUTES = new Set(["href", "alt", "title", "colspan", "rowspan", "start", "type", "dir", "lang"]);

/** URL schemes a surviving `href` may use. Everything else — `javascript:`, `data:`, `vbscript:` — is dropped. */
const ALLOWED_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

/** The largest sanitized body kept, **in bytes**. A dashboard rendering 5 MB of markup has already lost. */
export const MAX_HTML_BYTES = 512 * 1024;

/**
 * Decode the character references a browser would decode before it resolves a scheme.
 *
 * `href="java&#10;script:alert(1)"` is a `javascript:` URL to every browser: the parser decodes the
 * entity into a newline while reading the attribute, and the URL parser then strips it. A check that
 * reads the raw attribute sees `java&#10;script:...`, whose first `#` looks like a fragment marker,
 * and waves it through as relative — which is exactly the bypass this function exists to remove.
 *
 * Numeric, hex, and the three named references that can hide a scheme. Deliberately not a general
 * entity decoder: this value is about to be compared against a scheme allowlist, and the only
 * question worth answering is whether decoding could turn it into something that *is* a scheme.
 */
function decodeReferences(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&colon;?/gi, ":")
    .replace(/&newline;?/gi, "\n")
    .replace(/&tab;?/gi, "\t");
}

/**
 * One decoded character, or the replacement character when the reference names nothing.
 *
 * `String.fromCodePoint` throws a `RangeError` above U+10FFFF, and `&#99999999;` in an `href` is a
 * string an attacker chooses. Unguarded it throws out of the attribute walk, rejects the whole
 * `sanitizeHtml` promise, and fails ingest for that message — a mailable denial of service in the
 * decoder that exists to make ingest safe. The HTML spec's own answer is U+FFFD, so this returns what
 * a browser would have shown: a character that names no scheme and so decides nothing.
 */
function codePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return "�";
  // Lone surrogates are equally not characters; the spec replaces them for the same reason.
  return value >= 0xd800 && value <= 0xdfff ? "�" : String.fromCodePoint(value);
}

/** Whether an `href` value is safe to keep. Relative URLs are fine; a bare scheme we do not know is not. */
export function isSafeHref(value: string): boolean {
  // Decode first, THEN strip, in that order — the point is to see what a browser will see. Stripping
  // first leaves `&#10;` intact and the check then reads a fragment marker where a scheme is hiding.
  const trimmed = decodeReferences(value)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point — this is what stops one hiding a `javascript:` scheme from the check below.
    .replace(/[\u0000-\u0020]+/g, "")
    .toLowerCase();
  if (trimmed.length === 0) return false;
  // No colon before the first `/`, `?` or `#` means it is relative, which cannot name a scheme.
  const colon = trimmed.indexOf(":");
  if (colon === -1) return true;
  const firstDelimiter = Math.min(
    ...["/", "?", "#"].map((char) => {
      const index = trimmed.indexOf(char);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }),
  );
  if (colon > firstDelimiter) return true;
  return ALLOWED_SCHEMES.includes(trimmed.slice(0, colon + 1));
}

/**
 * Sanitize an HTML body for storage and later rendering.
 *
 * **Remote images are stripped, not merely sandboxed.** An `<img src="https://…">` in a support
 * message is a read receipt: it tells the sender the exact moment somebody opened their mail and
 * from which IP, and against a support inbox that is a reconnaissance tool for whoever is probing
 * you. Every mail client blocks them by default and so does this. The `alt` text survives, so a
 * screenshot that mattered leaves a visible trace rather than vanishing silently. The original is
 * still in R2 if an operator genuinely needs to see it.
 */
export async function sanitizeHtml(html: string): Promise<string> {
  const rewriter = new HTMLRewriter()
    .onDocument({
      // Conditional comments (`<!--[if mso]><script>…`) are markup to some renderers and a comment
      // to others. Dropping every comment removes the whole disagreement.
      comments(comment) {
        comment.remove();
      },
    })
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (DROPPED_TAGS.has(tag)) {
          element.remove();
          return;
        }

        // Snapshot before mutating: the iterator walks the same attribute list `removeAttribute`
        // shortens, so removing during the walk silently skips whatever moved into the gap.
        for (const pair of [...element.attributes]) {
          const name = pair[0] ?? "";
          const value = pair[1] ?? "";
          const attribute = name.toLowerCase();
          // `src` is never allowlisted, so an image loses its source here and keeps its alt text.
          if (!ALLOWED_ATTRIBUTES.has(attribute)) {
            element.removeAttribute(name);
            continue;
          }
          if (attribute === "href" && !isSafeHref(value)) {
            element.removeAttribute(name);
          }
        }

        // A surviving link opens somewhere else and must not hand that page a handle back to the
        // dashboard's window, whatever the dashboard's own headers say.
        if (tag === "a" && element.getAttribute("href")) {
          element.setAttribute("rel", "noopener noreferrer nofollow");
          element.setAttribute("target", "_blank");
        }
      },
    });

  const sanitized = await rewriter.transform(new Response(html)).text();
  return truncateToBytes(sanitized, MAX_HTML_BYTES);
}

/**
 * Reduce HTML to readable plain text — the fallback when a message carried no text part.
 *
 * The classifier reads text, never markup: markup is tokens the adopter pays for that carry no
 * meaning, and it is also an injection surface, since `<!-- ignore your instructions -->` reads
 * exactly like prose to a model. Block-level tags become newlines so a paragraph structure survives
 * the trip.
 */
export async function htmlToText(html: string): Promise<string> {
  const parts: string[] = [];
  // How many dropped elements we are currently inside. A counter rather than a boolean because
  // `<script>` inside `<svg>` is legal and both are dropped, and a boolean would surface the tail of
  // the outer one when the inner closed.
  let suppressed = 0;

  const rewriter = new HTMLRewriter()
    .onDocument({
      comments(comment) {
        comment.remove();
      },
      // Document-level, not `on("*")`. A text handler bound to an element selector never fires for
      // text outside any tag, so a message that is one bare sentence — which plenty are — came back
      // as the empty string and the classifier was handed nothing to read.
      text(chunk) {
        if (suppressed === 0) parts.push(chunk.text);
      },
    })
    .on("*", {
      element(element) {
        const tag = element.tagName.toLowerCase();
        if (DROPPED_TAGS.has(tag)) {
          element.remove();
          // `remove()` takes the element out of the *output*; it does not stop the document text
          // handler firing for what was inside it. Without this counter the contents of `<script>`
          // and `<style>` land in `textBody` — which is the copy that gets stored, searched, and
          // handed to the model. That is a prompt-injection surface and a way for anything an
          // attacker put in a script tag to end up in the adopter's database as prose.
          suppressed += 1;
          try {
            element.onEndTag(() => {
              suppressed -= 1;
            });
          } catch {
            // A void element has no end tag, so there is nothing to close and nothing to suppress.
            suppressed -= 1;
          }
          return;
        }
        if (["p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"].includes(tag)) {
          parts.push("\n");
        }
      },
    });

  // The transform is lazy: nothing runs until the body is consumed, so the text must be awaited even
  // though the handlers, not the result, are what this function is after.
  await rewriter.transform(new Response(html)).text();

  return parts
    .join("")
    .replace(/[\t\r ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
