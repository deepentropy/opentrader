/*
 * The tickers: the member's (from a ticker's page, or synced from the app's
 * watchlist), the most discussed of the last month, and a box to go to any
 * US stock or ETF.
 */
import { For, Show, createResource, createSignal } from "solid-js";
import { api, tickerCommunityId, type TickerRow } from "../data/community/api";
import { me, refreshMe } from "../data/community/session";
import { errorText } from "../window/right-rail/community/parts";
import { go, navigate } from "./router";
import { TickerTag } from "./ui";

export function TickersPage() {
  const [data, { refetch }] = createResource(() => me()?.user.name ?? "", () => api.tickers());
  const [ticker, setTicker] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const open = (e: Event) => {
    e.preventDefault();
    const id = tickerCommunityId(ticker().replace(/^\$/, ""));
    if (id) navigate(`/t/${encodeURIComponent(id.slice(2))}`);
  };
  const remove = async (id: string) => {
    try {
      await api.follow(id, false);
      await refreshMe();
      void refetch();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const Table = (tp: { rows: TickerRow[]; mine?: boolean }) => (
    <table class="cs-table">
      <thead><tr><th>Ticker</th><th>Posts, 30 days</th><th>Open ideas</th><Show when={tp.mine}><th /></Show></tr></thead>
      <tbody>
        <For each={tp.rows}>
          {(r) => (
            <tr>
              <td><TickerTag id={r.id} /></td>
              <td>{r.posts30}</td>
              <td>{r.open_ideas}</td>
              <Show when={tp.mine}><td class="cs-right-al"><button type="button" class="cs-act" onClick={() => remove(r.id)}>Remove</button></td></Show>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
  return (
    <div class="cs-grid is-ticker">
      <main id="cs-main" class="cs-center is-wide cs-stack">
        <form class="cs-row" onSubmit={open}>
          <input class="cs-input is-strong cs-goto" placeholder="Go to a ticker, like NVDA" maxLength={16} value={ticker()} onInput={(e) => setTicker(e.currentTarget.value.toUpperCase())} />
          <button type="submit" class="cs-btn is-primary">Open</button>
        </form>
        <Show when={error()}><p class="cs-error">{error()}</p></Show>
        <Show when={me()}>
          <div>
            <div class="cs-head is-strong is-sub"><h4>Your tickers</h4><span class="cs-fog cs-small">Synced from your OpenTrader watchlist, or added on a ticker's page</span></div>
            <Show when={(data()?.mine ?? []).length} fallback={<p class="cs-note">None yet. Open a ticker and choose "Add to my tickers", or sync your watchlist from the app's Community panel.</p>}>
              <Table rows={data()!.mine} mine />
            </Show>
          </div>
        </Show>
        <div>
          <div class="cs-head is-strong is-sub"><h4>Most discussed</h4><span class="cs-fog cs-small">Posts over the last 30 days</span></div>
          <Show when={(data()?.active ?? []).length} fallback={<p class="cs-note">{data.loading ? "Loading…" : "Nothing yet."}</p>}>
            <Table rows={data()!.active} />
          </Show>
        </div>
      </main>
      <aside class="cs-right is-ticker">
        <section class="cs-quiet">
          Every US stock and ETF has its page, with the open ideas on it and their levels. <a href="/c/general" onClick={go("/c/general")}>General</a> holds the posts about no one ticker.
        </section>
      </aside>
    </div>
  );
}
