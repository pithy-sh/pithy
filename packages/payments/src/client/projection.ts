// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * One product, browser-safe — an element of {@link PaymentsClientProjection}'s catalog.
 *
 * Declared as its own type because the element type is the half a value-derived shape loses first: a
 * catalog of one product infers one product's shape, and every branch the next product would have taken
 * — an empty `entitlements`, a SKU on a rail the first product does not sell — is simply not in it.
 *
 * **It is annotated on the `.map` callback, not on the array it builds.** Measured, and the difference
 * matters: `const products: PaymentsClientProduct[] = …map(…)` type-checks the *result*, by which point
 * the element literals are no longer fresh, so a product that grew an `apple` SKU passed silently. On the
 * callback's own return type the literal is checked where it is written, and the store-only field is a
 * compile error at the line that added it.
 */
export type PaymentsClientProduct = {
  /** The logical product id — what `/payments/checkout` is asked for. */
  id: string;
  /** What kind of product it is. */
  type: "consumable" | "non_consumable" | "subscription";
  /** The entitlement keys it grants. Gating code names these, never the product. */
  entitlements: string[];
  /** The display name a paywall renders. */
  name: string;
  /**
   * This product's SKU on each web rail, or null where it is not sold. Keyed by rail rather than one
   * field per rail, so a screen asks `skus[rail]` and a new rail cannot leave a `purchasable()` check
   * silently out of date. Every id here is publishable by design — each is what a checkout names.
   *
   * Apple's and Google's product ids are deliberately absent: a browser cannot open either store.
   */
  skus: {
    /** The Stripe price id. */
    stripe: string | null;
    /** The Lemon Squeezy variant id. */
    lemonSqueezy: string | null;
    /** The Paddle price id. */
    paddle: string | null;
  };
};

/**
 * What a browser may know about this project's payments — the shape of `virtual:pithy/payments`.
 *
 * **This declaration is the contract, and the projection is checked against it.** It is written here
 * rather than inferred from the closure that builds it, and that is the whole point: an inferred type
 * follows whatever the producer last happened to say, so a projection that dropped `basePath`, or that
 * widened `type` because `PaymentsConfig` learned a fourth product kind, or that started passing a
 * product's Apple id through, would take the type with it and nothing would go red. Declared, the
 * function is the thing that has to change — every widening of what a browser sees is decided here.
 *
 * Nothing sensitive is in reach of the producer to begin with: Apple's issuer key, Google's service
 * account, and Stripe's secret and signing keys live in the secrets store behind
 * `paymentsSecretsRegistry`, not in the config the closure can see. What this type covers is the rest of
 * the catalog — the `grants` block and the store-only SKUs, which are omissions of judgement rather than
 * of reach, and so are the ones worth writing down.
 *
 * **`billingSubject` is a third omission of judgement, and it is deliberate.** The subject *id* obviously
 * never crosses — it is a fact about one caller, and this projection is inlined into a bundle every caller
 * receives, so there is no request here to be right about. But the mode is not a secret and is left out
 * anyway, on the plainer ground that nothing in a browser can use it. A paywall renders products and buy
 * buttons; who holds what it buys is decided on the server, on the request, by the subject seam, and a
 * screen that branched on the mode would be a second copy of that decision drifting from the first. The
 * shape is also not free: this type is what `@pithy-sh/vite` generates `templates/client-env.d.ts` from, so
 * a key added here is a key added to every adopter's ambient declaration. It goes in the day something in
 * a browser genuinely cannot be written without it, and not before.
 *
 * **This is the only statement of the shape.** `@pithy-sh/ui-react`'s `templates/client-env.d.ts` — the
 * ambient declaration `pithy ui add react` copies into an adopter's Worker — is generated from this type
 * by `@pithy-sh/vite`'s `clientEnvDeclaration.ts` (#398). The unions and the per-field doc comments below
 * are emitted verbatim, so what is written here is what a screen author reads.
 */
export type PaymentsClientProjection =
  | {
      /**
       * Payments is not composed, or has no catalog this environment can render. Both read the same on
       * purpose: "composed with nothing to sell" is a paywall with nothing on it, exactly like "not
       * composed", and a screen branches on one value rather than guarding.
       */
      enabled: false;
    }
  | {
      /** Payments is composed AND has a catalog this environment can render. */
      enabled: true;
      /** The environment this bundle was built for. */
      environment: string;
      /**
       * Which rails this project sells through. Apple and Google are display-only on the web — a
       * paywall shows such a product as owned-elsewhere rather than offering a buy button nothing on
       * the web can honour.
       */
      rails: {
        /** Whether the App Store rail is on. Display-only in a browser. */
        apple: boolean;
        /** Whether the Play Store rail is on. Display-only in a browser. */
        google: boolean;
        /** Whether the Stripe rail is on. */
        stripe: boolean;
        /** Whether the Lemon Squeezy rail is on. */
        lemonSqueezy: boolean;
        /** Whether the Paddle rail is on. */
        paddle: boolean;
      };
      /**
       * What Paddle.js needs to initialize, or null when the rail is off. The client token is
       * publishable by design — it is what a browser opens a checkout with — and the API key and the
       * webhook signing secret are neither here nor expressible here.
       */
      paddle: {
        /** The publishable client token Paddle.js initializes with. */
        clientToken: string;
        /** Which Paddle account the token belongs to. */
        environment: "sandbox" | "production";
        /**
         * How checkout is presented: `overlay` opens Paddle.js over your own page, `inline` renders it
         * into a container the screen provides, `hosted` redirects to Paddle's own page.
         *
         * The union is stated, not `string`. A screen switches on this to decide whether to render a
         * container at all, and the exhaustiveness is the point. It was the one field the hand-written
         * `templates/client-env.d.ts` widened, and generating that file from here is what closed it.
         */
        checkout: "overlay" | "inline" | "hosted";
      } | null;
      /** Where the payments routes mount, e.g. `/payments`. */
      basePath: string;
      /**
       * The catalog, browser-safe, in the order the adopter wrote it. A web rail's price id is
       * publishable by design — a checkout names one. Apple's and Google's SKUs, and anything a
       * purchase fulfils beyond its entitlements, stay server-side.
       */
      products: PaymentsClientProduct[];
    };
