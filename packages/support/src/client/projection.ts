// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a browser may know about this project's support inbox — the shape of `virtual:pithy/support`.
 *
 * **This declaration is the contract, and the projection is checked against it.** It is written here
 * rather than inferred from the closure that builds it, and that is the whole point: an inferred type
 * follows whatever the producer last happened to say, so a projection that dropped `maxBodyChars`, or
 * that started passing the mail path's attachment bounds through because `SupportConfig` moved a field,
 * would take the type with it and nothing would go red. Declared, the arrow is the thing that has to
 * change — and every widening of what a browser sees is a decision made here, on purpose.
 *
 * The list is short on purpose and `clientProjection`'s own comment says at length what stays behind:
 * the taxonomy, the inbound addresses, the reply snippets, the per-account rate, and the whole `ai`,
 * `guard`, mail-`attachments` and `search` blocks.
 *
 * `@pithy-sh/ui-react`'s `templates/client-env.d.ts` states the same shape for an adopter, and
 * `@pithy-sh/vite`'s `clientEnv.test.ts` holds the two together (#392).
 */
export type SupportClientProjection =
  | {
      /**
       * Support is not composed, or is not serving the in-app submission routes — the only ones a
       * browser calls. A screen branches rather than rendering a compose form nothing will accept.
       */
      enabled: false;
    }
  | {
      /** Support is composed AND serving the in-app submission routes. */
      enabled: true;
      /** Where the support routes mount, e.g. `/support`. `POST {basePath}/feedback` writes in. */
      basePath: string;
      /**
       * What one submission may carry. Hold a compose form to these so the handler does not have to
       * refuse after somebody pressed Send. The taxonomy is not here: a category's text is the
       * instruction a classifier reads, not copy for a chooser.
       */
      submission: {
        /** The longest subject accepted. It becomes the thread's name in the inbox. */
        maxSubjectChars: number;
        /** The longest report body accepted. */
        maxBodyChars: number;
        /**
         * What an upload control may offer, or null when attachments are off and it renders none.
         * Null rather than absent: the projection is inlined with `JSON.stringify`, which drops an
         * undefined value and leaves a screen reading a key that is simply gone.
         */
        attachments: {
          /** How many files one submission may carry. */
          maxCount: number;
          /** The largest single file, measured on the decoded bytes. */
          maxBytes: number;
          /** The exact MIME types accepted — an allowlist, and the `accept` a file input wants. */
          allowedContentTypes: string[];
        } | null;
      };
    };
