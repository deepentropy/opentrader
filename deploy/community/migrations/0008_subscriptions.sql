-- Paid tier (#252): one subscription per account, as the payment provider
-- last reported it. Read by POST /auth/pass; written by the payment webhook
-- and the nightly reconciliation (billing.ts). Times are UNIX seconds.

CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL UNIQUE,
  -- NULL until the first checkout completes.
  subscription_id TEXT,
  -- The provider's status: active, trialing, past_due, canceled, unpaid,
  -- incomplete, incomplete_expired, paused; 'none' before the first checkout.
  status TEXT NOT NULL DEFAULT 'none',
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Webhook events already applied: a delivery sent again is answered and skipped.
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
