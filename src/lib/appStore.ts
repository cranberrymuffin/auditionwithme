import {
  INTRO_ELIGIBILITY_STATUS,
  Purchases,
  PURCHASES_ERROR_CODE,
  type PurchasesPackage,
} from "@revenuecat/purchases-capacitor";
import { apiFetch } from "./api";

// Subscriptions in the iOS app are Apple In-App Purchases through
// RevenueCat; the web keeps Stripe. RevenueCat's app user ID is always the
// Supabase user ID, which is how api/revenuecat-webhook.ts and the
// sync-apple action in api/billing.ts find the entitlements row.

const apiKey = import.meta.env.VITE_REVENUECAT_IOS_KEY as string | undefined;

/** Where Apple lets people cancel or change an App Store subscription. */
export const APP_STORE_SUBSCRIPTIONS_URL = "https://apps.apple.com/account/subscriptions";

let configured: Promise<void> | null = null;
let currentUserId: string | null = null;

/** Configures RevenueCat once, then makes sure it's acting as this user:
 * every call goes through here, so a sign-out and sign-in as someone else
 * can't buy or restore onto the previous account. */
async function actAs(userId: string): Promise<void> {
  if (!apiKey) throw new Error("VITE_REVENUECAT_IOS_KEY is not set");
  configured ??= Purchases.configure({ apiKey, appUserID: userId });
  await configured;
  if (currentUserId === null) {
    currentUserId = userId;
  } else if (currentUserId !== userId) {
    await Purchases.logIn({ appUserID: userId });
    currentUserId = userId;
  }
}

export type AppStoreOffer = {
  pkg: PurchasesPackage;
  /** Localized price for the user's storefront, e.g. "$9.99". */
  priceString: string;
  /** Free-trial length in days, or null when this Apple ID can't get one. */
  trialDays: number | null;
};

function introTrialDays(pkg: PurchasesPackage): number | null {
  const intro = pkg.product.introPrice;
  if (!intro || intro.price !== 0) return null;
  const perUnit = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 }[intro.periodUnit] ?? null;
  return perUnit === null ? null : intro.periodNumberOfUnits * perUnit;
}

/** The monthly plan from the current RevenueCat offering. */
export async function loadOffer(userId: string): Promise<AppStoreOffer | null> {
  await actAs(userId);
  const offerings = await Purchases.getOfferings();
  const pkg = offerings.current?.monthly ?? offerings.current?.availablePackages[0];
  if (!pkg) return null;

  // Apple decides trial eligibility per Apple ID (one intro offer per
  // subscription group), not our entitlements row.
  let trialDays = introTrialDays(pkg);
  if (trialDays !== null) {
    const eligibility = await Purchases.checkTrialOrIntroductoryPriceEligibility({
      productIdentifiers: [pkg.product.identifier],
    });
    const status = eligibility[pkg.product.identifier]?.status;
    if (status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE) trialDays = null;
  }
  return { pkg, priceString: pkg.product.priceString, trialDays };
}

/** Writes the user's App Store subscription to their entitlements row now,
 * rather than waiting for RevenueCat's webhook. */
async function syncEntitlement(): Promise<boolean> {
  const response = await apiFetch("/api/billing?action=sync-apple", { method: "POST" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error ?? "Could not confirm your App Store purchase");
  return payload?.active === true;
}

/** Runs Apple's purchase sheet. Returns false if the user backed out. */
export async function purchase(userId: string, pkg: PurchasesPackage): Promise<boolean> {
  await actAs(userId);
  try {
    await Purchases.purchasePackage({ aPackage: pkg });
  } catch (error) {
    if ((error as { code?: string }).code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) {
      return false;
    }
    throw error;
  }
  await syncEntitlement();
  return true;
}

/** Restores an App Store subscription bought on another device or account.
 * Returns whether one is active. */
export async function restore(userId: string): Promise<boolean> {
  await actAs(userId);
  await Purchases.restorePurchases();
  return syncEntitlement();
}
