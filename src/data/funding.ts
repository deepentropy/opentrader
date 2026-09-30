/*
 * Funding status for Settings > About: this month's running cost and how much
 * donations cover (gateway `GET /funding/v1`, via the `get_funding_status`
 * command). Read only when the About tab opens; one request per 5 minutes.
 */
import { commands, type FundingLinks } from "../bindings";

/** Amounts in `currency`; `month` = UTC `YYYY-MM`. */
export type Funding = {
  month: string;
  currency: string;
  total: number;
  raised: number;
  remaining: number;
  links: FundingLinks;
};

const TTL_MS = 5 * 60_000;
let cached: { at: number; value: Promise<Funding | null> } | null = null;

/** `null` when the gateway has no cost set or cannot be reached. */
export function fundingStatus(): Promise<Funding | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = commands.getFundingStatus().then((r) => {
    // specta types f64 as `number | null` (NaN); the gateway always sends numbers.
    if (r.status === "ok") {
      const d = r.data;
      return d && { ...d, total: d.total ?? 0, raised: d.raised ?? 0, remaining: d.remaining ?? 0 };
    }
    console.warn("[funding]", r.error);
    cached = null;
    return null;
  });
  cached = { at: Date.now(), value };
  return value;
}
