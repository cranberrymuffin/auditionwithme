import { useState } from "react";
import {
  CheckoutElementsProvider,
  PaymentElement,
  useCheckoutElements,
} from "@stripe/react-stripe-js/checkout";
import { stripePromise } from "../../lib/stripe";

type Props = {
  clientSecret: string;
  submitLabel: string;
  onConfirmed: () => void;
  onCancel?: () => void;
  /** Show the live total from the Checkout Session (subscription mode only —
   * a setup-mode session has no line items to price). */
  showTotal?: boolean;
};

function InnerForm({ submitLabel, onConfirmed, onCancel, showTotal }: Omit<Props, "clientSecret">) {
  const checkoutState = useCheckoutElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (checkoutState.type === "loading") {
    return <p className="stripe-elements-loading">Loading…</p>;
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
        {showTotal && (
          // Sourced from the live session (not hardcoded) so this stays correct
          // under Adaptive Pricing currency conversion and future price changes.
          <p
            className="plan-price"
            aria-label={`${checkout.total.total.amount}${
              checkout.recurring ? ` per ${checkout.recurring.interval}` : ""
            }`}
          >
            <strong>{checkout.total.total.amount}</strong>
            {checkout.recurring && <span>/{checkout.recurring.interval}</span>}
          </p>
        )}
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
    <CheckoutElementsProvider stripe={stripePromise} options={{ clientSecret }}>
      <InnerForm {...rest} />
    </CheckoutElementsProvider>
  );
}
