export interface Env {
  DB: D1Database;
  /** The website (build of src/community-site); absent in a local run without it. */
  ASSETS?: Fetcher;
  /** Live comments: one room per post (live.ts). */
  ROOMS?: DurableObjectNamespace;
  /** Pictures of the charts shared in posts. */
  IMAGES?: R2Bucket;
  /** This Worker's public address, without a trailing slash (OAuth callbacks). */
  PUBLIC_URL: string;
  /** Page origins allowed to call the API (comma-separated), besides the desktop app's. */
  ALLOWED_ORIGINS: string;
  /** Web pages a sign-in may end on (origin + path, comma-separated). */
  WEB_REDIRECTS?: string;
  /** Administrators: `provider:provider_id`, comma-separated. */
  ADMINS?: string;
  /** "1": the local test sign-in (never set in production). */
  DEV_LOGIN?: string;
  /** Administrators of the test sign-in: `dev:<name>`. */
  DEV_ADMINS?: string;
  /** Bot check at sign-in (Cloudflare Turnstile); no key: no check. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Market data gateway: ticker communities only for symbols it knows. No token: no check. */
  GATEWAY_URL?: string;
  GATEWAY_TOKEN?: string;
  /** Burst limits per connection (Workers rate limiting). */
  WRITE_LIMITER?: RateLimit;
  AUTH_LIMITER?: RateLimit;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  /** Opens GitHub issues from suggestions (Issues: read and write on the project). Unset: "Promote" opens a prefilled new issue page instead. */
  GITHUB_ISSUES_TOKEN?: string;
  /** Paid tier (billing.ts, pass.ts). Passes: Ed25519 PKCS #8, base64url. Unset = no passes. */
  PASS_PRIVATE_KEY?: string;
  /** The gateway's admin token: closes an account's real-time stream when it loses its plan. */
  GATEWAY_ADMIN_TOKEN?: string;
  /** Payment provider: secret key, webhook signing secret, the monthly price's id. Unset = no checkout. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID?: string;
  /** Local test only: the provider API's base URL. */
  STRIPE_API_URL?: string;
}
