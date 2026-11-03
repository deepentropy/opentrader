export interface Env {
  DB: D1Database;
  /** The website (build of src/community-site); absent in a local run without it. */
  ASSETS?: Fetcher;
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
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
}
