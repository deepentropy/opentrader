/*
 * The way to live data in the usage statistics (src/data/analytics.ts): `live_offer_shown` each time the live data
 * dialog opens (what it showed, what opened it, signed in or not) and `live_offer_sign_in` for a sign-in started
 * from it (provider, and done, cancelled or failed). Shown minus signed in = who saw the offer and did not take it.
 */
import { track } from "../analytics";
import { me, signIn } from "../community/session";

/** What opened the dialog: the data badge, the beta's first notice or its reminder a week later, or the dialog itself
 *  again after a step (signed in, subscription changed). */
export type PlanDialogFrom = "badge" | "notice" | "reminder" | "after";

/** What the dialog showed: live data in use elsewhere, the beta, the subscription, sign in to upgrade, or upgrade. */
export type PlanDialogView = "elsewhere" | "beta" | "subscription" | "sign_in" | "upgrade";

export function offerShown(from: PlanDialogFrom, view: PlanDialogView): void {
  track("live_offer_shown", { from, view, signed_in: !!me() });
}

/** Signs in from the dialog and counts how it ended; rejects as signIn does. */
export function signInFromOffer(provider: string, beta: boolean): Promise<void> {
  return signIn(provider).then(
    () => track("live_offer_sign_in", { provider, beta, outcome: "done" }),
    (e: unknown) => {
      const cancelled = e instanceof Error && e.message === "cancelled";
      track("live_offer_sign_in", { provider, beta, outcome: cancelled ? "cancelled" : "failed" });
      throw e;
    },
  );
}
