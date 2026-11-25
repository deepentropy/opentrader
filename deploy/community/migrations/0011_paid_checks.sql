-- Paid tier (#252): what the plan depends on besides the subscription's status
-- (billing.ts planOf).

-- Start of the current period: a renewal that fails keeps real-time a few days from it.
ALTER TABLE subscriptions ADD COLUMN current_period_start INTEGER;
-- 1: paid in the payment provider's test mode.
ALTER TABLE subscriptions ADD COLUMN test INTEGER NOT NULL DEFAULT 0;
-- 1: a payment was disputed: no real-time, no new checkout, until the dispute is won.
ALTER TABLE subscriptions ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
