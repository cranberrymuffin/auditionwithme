import { useState } from "react";
import {
  CheckoutElementsProvider,
  PaymentElement,
  useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import type { Appearance } from "@stripe/stripe-js";
import { stripePromise } from "../../lib/stripe";

// Stripe draws the card fields in its own iframe, which can't read the
// page's CSS variables: these are the values of the tokens in
// src/styles/tokens.css, written out. Change one there, change it here.
const TOKENS = {
  surface1: "#151f2e",
  ink: "#f4eee4",
  inkSoft: "#c5bfb4",
  inkMuted: "#969188",
  line: "#283344",
  lineStrong: "#606e85",
  accent: "#ef8f6f",
  accentLine: "rgba(239, 143, 111, 0.55)",
  danger: "#f2646a",
};

// The fields are drawn like .input (components.css) on the modal's surface:
// same height, border, radius and focus ring, so the card form reads as
// part of the dialog rather than a box dropped into it.
const appearance: Appearance = {
  theme: "night",
  variables: {
    colorPrimary: TOKENS.accent,
    colorBackground: TOKENS.surface1,
    colorText: TOKENS.ink,
    colorTextSecondary: TOKENS.inkSoft,
    colorTextPlaceholder: TOKENS.inkMuted,
    colorDanger: TOKENS.danger,
    fontFamily: '"Britti Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
    // 16px: anything smaller makes iOS zoom the page on focus.
    fontSizeBase: "16px",
    fontSizeSm: "14px",
    borderRadius: "4px",
    spacingUnit: "4px",
    gridRowSpacing: "20px",
    gridColumnSpacing: "12px",
  },
  rules: {
    ".Label": {
      marginBottom: "6px",
      color: TOKENS.inkSoft,
      fontSize: "14px",
      fontWeight: "600",
    },
    ".Input": {
      padding: "12px 14px",
      border: `1px solid ${TOKENS.lineStrong}`,
      backgroundColor: TOKENS.surface1,
      boxShadow: "none",
      transition: "border-color 160ms",
    },
    ".Input:hover": {
      border: `1px solid ${TOKENS.inkMuted}`,
    },
    ".Input:focus": {
      border: `1px solid ${TOKENS.accent}`,
      boxShadow: `0 0 0 2px ${TOKENS.accentLine}`,
      outline: "none",
    },
    ".Input--invalid": {
      border: `1px solid ${TOKENS.danger}`,
      boxShadow: "none",
    },
    ".Error": {
      marginTop: "6px",
      color: TOKENS.danger,
      fontSize: "14px",
    },
    // Card is the only method, so its accordion frame is just a box around
    // the fields: flatten it to nothing.
    ".AccordionItem": {
      padding: "0",
      border: "none",
      backgroundColor: "transparent",
      boxShadow: "none",
    },
    ".Block": {
      border: `1px solid ${TOKENS.line}`,
      backgroundColor: "transparent",
      boxShadow: "none",
    },
    ".TermsText": {
      color: TOKENS.inkMuted,
      fontSize: "13px",
    },
  },
};

function formatDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  });
}

type Props = {
  clientSecret: string;
  submitLabel: string;
  onConfirmed: () => void;
  onCancel?: () => void;
  /** Show the live total from the Checkout Session (subscription mode only —
   * a setup-mode session has no line items to price). */
  showTotal?: boolean;
};

type Checkout = Extract<
  ReturnType<typeof useCheckoutElements>,
  { type: "success" }
>["checkout"];

// Sourced from the live session (not hardcoded) so this stays correct under
// Adaptive Pricing currency conversion and future price changes — and shows
// $0 today only when Stripe actually attached a trial to this session.
function OrderSummary({ checkout }: { checkout: Checkout }) {
  const recurring = checkout.recurring;
  const trial = recurring?.trial ?? null;
  const per = recurring ? `/${recurring.interval}` : "";
  const renewal = recurring?.dueNext.total.amount ?? checkout.total.total.amount;

  return (
    <div className="checkout-summary">
      <dl>
        <div>
          <dt>Audition Plus</dt>
          <dd>
            {renewal}
            {per}
          </dd>
        </div>
        {trial && (
          <div>
            <dt>{trial.trialPeriodDays}-day free trial</dt>
            <dd>Until {formatDay(trial.trialEnd)}</dd>
          </div>
        )}
        <div className="checkout-summary-total">
          <dt>Due today</dt>
          <dd>{checkout.total.total.amount}</dd>
        </div>
      </dl>
      {trial && (
        <p className="checkout-summary-note">
          Then {renewal}
          {per} starting {formatDay(trial.trialEnd)}. Cancel before then and
          you won't be charged.
        </p>
      )}
    </div>
  );
}

function InnerForm({ submitLabel, onConfirmed, onCancel, showTotal }: Omit<Props, "clientSecret">) {
  const checkoutState = useCheckoutElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (checkoutState.type === "loading") {
    return (
      <div className="stripe-elements-loading" aria-live="polite">
        <span className="billing-spinner" aria-hidden="true" />
        Loading secure checkout…
      </div>
    );
  }

  if (checkoutState.type === "error") {
    return (
      <p className="plan-error" role="alert">
        {checkoutState.error.message}
      </p>
    );
  }

  const { checkout } = checkoutState;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await checkout.confirm({ redirect: "if_required" });

    if (result.type === "error") {
      setError(result.error.message ?? "Something went wrong. Please try again.");
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    onConfirmed();
  }

  return (
    <form className="stripe-elements-form" onSubmit={handleSubmit}>
      <div className="stripe-elements-form-fields">
        {showTotal && <OrderSummary checkout={checkout} />}
        <PaymentElement
          options={{
            wallets: { applePay: "auto", googlePay: "auto", link: "never" },
            // Card is the only payment_method_type this Checkout Session
            // accepts, so there's nothing to choose between — expand its
            // fields immediately instead of collapsing them behind a click.
            layout: { type: "accordion", defaultCollapsed: false },
          }}
        />
        {error && (
          <p className="plan-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="stripe-elements-form-actions">
        {onCancel && (
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "Processing…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

export default function StripeElementsForm({ clientSecret, ...rest }: Props) {
  return (
    <CheckoutElementsProvider
      stripe={stripePromise}
      options={{ clientSecret, elementsOptions: { appearance } }}
    >
      <InnerForm {...rest} />
    </CheckoutElementsProvider>
  );
}
