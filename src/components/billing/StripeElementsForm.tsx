import { useState } from "react";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { stripePromise } from "../../lib/stripe";

type Props = {
  clientSecret: string;
  /** "payment" confirms a PaymentIntent (new subscription); "setup" confirms
   * a SetupIntent (updating the saved card) and returns a payment method id. */
  kind: "payment" | "setup";
  submitLabel: string;
  returnPath: string;
  onConfirmed: (paymentMethodId: string | null) => void;
  onCancel?: () => void;
};

function InnerForm({ kind, submitLabel, returnPath, onConfirmed, onCancel }: Omit<Props, "clientSecret">) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;

    setSubmitting(true);
    setError(null);

    const returnUrl = `${window.location.origin}${returnPath}`;
    const result =
      kind === "payment"
        ? await stripe.confirmPayment({
            elements,
            confirmParams: { return_url: returnUrl },
            redirect: "if_required",
          })
        : await stripe.confirmSetup({
            elements,
            confirmParams: { return_url: returnUrl },
            redirect: "if_required",
          });

    if (result.error) {
      setError(result.error.message ?? "Something went wrong. Please try again.");
      setSubmitting(false);
      return;
    }

    const paymentMethodId =
      "setupIntent" in result
        ? typeof result.setupIntent.payment_method === "string"
          ? result.setupIntent.payment_method
          : (result.setupIntent.payment_method?.id ?? null)
        : typeof result.paymentIntent.payment_method === "string"
          ? result.paymentIntent.payment_method
          : (result.paymentIntent.payment_method?.id ?? null);

    setSubmitting(false);
    onConfirmed(paymentMethodId);
  }

  return (
    <form className="stripe-elements-form" onSubmit={handleSubmit}>
      <PaymentElement options={{ wallets: { link: "never" } }} />
      {error && (
        <p className="plan-error" role="alert">
          {error}
        </p>
      )}
      <div className="stripe-elements-form-actions">
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
        <button type="submit" disabled={!stripe || submitting}>
          {submitting ? "Processing…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

export default function StripeElementsForm({ clientSecret, ...rest }: Props) {
  return (
    <Elements stripe={stripePromise} options={{ clientSecret }}>
      <InnerForm {...rest} />
    </Elements>
  );
}
