/*
 * Economy tab: the countries panel over the symbol search (Back returns to the list).
 */
import { For, Show } from "solid-js";
import { flagUrl } from "../../../data/country-flags";
import { econCountry, setEconCountry, type SymbolSearch } from "./search-model";

export function CountryPanel(props: { s: SymbolSearch; onClose: () => void; onPicked: () => void }) {
  const s = props.s;
  const pickCountry = (code: string | null) => {
    setEconCountry(code);
    s.setCountryPanel(false);
    props.onPicked();
  };
  return (
    <Show when={s.countryPanel()}>
      <div class="symbol-search-country-panel" data-name="economy-countries">
        <header class="symbol-search-header symbol-search-panel-header">
          <button type="button" aria-label="Back" class="symbol-search-close symbol-search-back" onClick={() => s.setCountryPanel(false)}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
              <path stroke="currentColor" stroke-width="1.2" fill="none" d="M11.5 3.5 6 9l5.5 5.5" />
            </svg>
          </button>
          <span class="symbol-search-title">Sources</span>
          <button type="button" aria-label="Close menu" class="symbol-search-close" onClick={() => props.onClose()}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
              <path stroke="currentColor" stroke-width="1.2" fill="none" d="m1.5 1.5 15 15m0-15-15 15" />
            </svg>
          </button>
        </header>
        <div class="symbol-search-panel-search">
          <svg class="symbol-search-panel-search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" fill="none">
            <path stroke="currentColor" stroke-width="1.4" d="M19.5 19.5 24 24M21 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" />
          </svg>
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            type="search"
            class="symbol-search-panel-input"
            placeholder="Search"
            value={s.countryQuery()}
            onInput={(e) => s.setCountryQuery(e.currentTarget.value)}
            autocomplete="off"
            spellcheck={false}
          />
        </div>
        <div class="symbol-search-panel-list">
          <Show when={!s.countryQuery().trim()}>
            <div class="symbol-search-panel-grid">
              <button type="button" class={"symbol-search-panel-item" + (!econCountry() ? " selected" : "")} onClick={() => pickCountry(null)}>
                <svg class="symbol-search-panel-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none">
                  <circle cx="12" cy="12" r="8.5" stroke="currentColor" />
                  <ellipse cx="12" cy="12" rx="3.5" ry="8.5" stroke="currentColor" />
                  <path stroke="currentColor" d="M3.5 12h17" />
                </svg>
                <span>All countries</span>
              </button>
            </div>
          </Show>
          <For each={s.countryRegions()}>
            {(r) => (
              <>
                <div class="symbol-search-panel-group">{r.title}</div>
                <div class="symbol-search-panel-grid">
                  <For each={r.countries}>
                    {(c) => (
                      <button type="button" class={"symbol-search-panel-item" + (econCountry() === c.code ? " selected" : "")} onClick={() => pickCountry(c.code)}>
                        <span class="symbol-search-panel-flag" aria-hidden="true">
                          <Show when={flagUrl(c.code)}>{(src) => <img src={src()} alt="" />}</Show>
                        </span>
                        <span>{c.name}</span>
                      </button>
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
