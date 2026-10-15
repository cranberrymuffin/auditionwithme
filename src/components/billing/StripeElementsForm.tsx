import { useState } from "react";
import {
  CheckoutElementsProvider,
  PaymentElement,
  useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import type { Appearance } from "@stripe/stripe-js";
import { stripePromise } from "../../lib/stripe";

// Matches the app's night palette (index.css .modal-content) so the card
// fields read as part of the modal rather than a white box dropped into it.
const appearance: Appearance = {
  theme: "night",
  variables: {
    colorPrimary: "#f4a583",
    colorBackground: "#0f1b2b",
    colorText: "#f8f1e6",
    colorTextSecondary: "rgba(248, 241, 230, 0.68)",
    colorTextPlaceholder: "rgba(248, 241, 230, 0.38)",
    colorDanger: "#ffb1a0",
    fontFamily: '"Britti Sans", ui-sans-serif, system-ui, sans-serif',
    fontSizeBase: "15px",
    borderRadius: "9px",
    spacingUnit: "4px",
  },
  rules: {
    ".Input": {
      border: "1px solid rgba(255, 255, 255, 0.17)",
      boxShadow: "none",
    },
    ".Input:focus": {
      border: "1px solid #ef9a78",
      boxShadow: "0 0 0 3px rgba(239, 154, 120, 0.18)",
    },
    ".Label": { fontWeight: "600" },
    ".AccordionItem": {
      border: "1px solid rgba(255, 255, 255, 0.14)",
      backgroundColor: "rgba(255, 255, 255, 0.02)",
      boxShadow: "none",
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
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
        <button type="submit" disabled={submitting}>
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
