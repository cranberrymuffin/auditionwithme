-- Subscriptions bought in the iOS app go through Apple (via RevenueCat,
-- api/revenuecat-webhook.ts) instead of Stripe. subscription_status keeps
-- its meaning for both; subscription_source says which store owns it, so
-- each webhook only ever ends a subscription its own store started.
alter table public.entitlements
  add column if not exists subscription_source text
    check (subscription_source in ('stripe', 'apple'));

-- Every subscription before this migration came through Stripe.
update public.entitlements
  set subscription_source = 'stripe'
  where subscription_source is null and stripe_subscription_id is not null;
