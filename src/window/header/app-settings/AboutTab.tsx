import { dateText } from "../../../i18n/format";
/*
 * Settings > About: version, update status, notices and funding.
 */
import { createSignal, onMount, Show, type JSX } from "solid-js";
import { Icon } from "../../../components/Icon";
import { appUpdateStatus, buildInfo, checkForUpdates, installUpdate } from "../../../data/app-update";
import type { BuildInfo } from "../../../bindings";
import { COMMUNITY_ENABLED, COMMUNITY_URL } from "../../../data/community/api";
import { ECONOMIC_DATA_NOTICE, ECONOMIC_DATA_TERMS_URL } from "../../../data/economic-notice";
import { fundingStatus, type Funding } from "../../../data/funding";
import { openLink } from "./io";
import { translateWith } from "../../../i18n/translator";

export function AboutTab() {
  const [info, setInfo] = createSignal<BuildInfo | null>(null);
  onMount(() => {
    void buildInfo().then(setInfo);
    // The reference app checks for an update each time About opens.
    checkForUpdates();
  });
  /** "2026-09-30" → "30/09/2026". */
  const date = (iso: string) => iso.split("-").reverse().join("/");
  return (
    <div class="app-settings-about">
      <div class="app-settings-about-app">OpenTrader</div>
      <Show when={info()}>
        {(i) => <div class="app-settings-about-version">{translateWith("Version {0} · {1}", i().version, date(i().buildDate))}</div>}
      </Show>
      {/* The reference app hides its update block on Linux (no in-app update there). */}
      <Show when={!/Linux/.test(navigator.userAgent)}>
        <UpdateAppBlock />
      </Show>
      <div class="app-settings-about-copyright">Copyright © 2026 OpenTrader</div>
      <Show when={COMMUNITY_ENABLED}>
        <SuggestLink />
      </Show>
      <EconomicDataNotice />
      <FundingBlock />
    </div>
  );
}

/** Notice and terms of the economic data source (its API terms of use). */
function EconomicDataNotice() {
  return (
    <div class="app-settings-about-notice">
      <div>{ECONOMIC_DATA_NOTICE}</div>
      <div>
        By using the economic series in OpenTrader you agree to the{" "}
        <a class="app-settings-about-link" href={ECONOMIC_DATA_TERMS_URL} onClick={(e) => { e.preventDefault(); openLink(ECONOMIC_DATA_TERMS_URL, "terms"); }}>
          FRED® API Terms of Use
        </a>
        .
      </div>
    </div>
  );
}

/** Members ask for features on the Community website, no GitHub account needed. */
function SuggestLink() {
  const url = `${COMMUNITY_URL}/suggestions`;
  return (
    <div class="app-settings-about-notice">
      <span>
        Missing something?{" "}
        <a
          class="app-settings-about-link"
          href={url}
          onClick={(e) => {
            e.preventDefault();
            openLink(url, "suggestions");
          }}
        >
          Suggest a feature
        </a>
      </span>
    </div>
  );
}

/** This month's running cost and how much donations cover (data/funding.ts).
 *  Hidden while loading and when the gateway has no status. */
function FundingBlock() {
  const [status, setStatus] = createSignal<Funding | null>(null);
  onMount(() => void fundingStatus().then(setStatus));
  const money = (n: number, currency: string) => `${Math.round(n)} ${currency}`;
  const monthName = (m: string) => dateText(new Date(`${m}-01T00:00:00Z`), { month: "long", year: "numeric", timeZone: "UTC" });
  const open = (url: string) => openLink(url, "funding link");
  return (
    <Show when={status()}>
      {(s) => (
        <div class="app-settings-funding">
          <div class="app-settings-funding-title">Support OpenTrader</div>
          <div class="app-settings-funding-text">
            {translateWith("OpenTrader is free. Market data, servers and development tools cost {0} in {1}.", money(s().total, s().currency), monthName(s().month))}
          </div>
          <div class="app-settings-funding-bar">
            <div
              class="app-settings-funding-fill"
              style={{ width: `${s().total > 0 ? Math.min(100, (s().raised / s().total) * 100) : 100}%` }}
            />
          </div>
          <div class="app-settings-funding-numbers">
            <span>{translateWith("{0} covered", money(s().raised, s().currency))}</span>
            <span>
              {s().remaining > 0 ? translateWith("{0} left to cover", money(s().remaining, s().currency)) : "Covered, thank you"}
            </span>
          </div>
          <div class="app-settings-funding-links">
            <Show when={s().links.github}>
              <button type="button" class="app-settings-btn" onClick={() => open(s().links.github)}>
                Sponsor on GitHub
              </button>
            </Show>
            <Show when={s().links.bmc}>
              <button type="button" class="app-settings-btn" onClick={() => open(s().links.bmc)}>
                Buy Me a Coffee
              </button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

/** The reference app's About update status block (`update-app`): one row per update state,
 *  "Relaunch" once the new version is downloaded. Error shows as up to date,
 *  like the reference app. */
function UpdateAppBlock() {
  const state = () => appUpdateStatus().state;
  const view = (): { text: string; icon: JSX.Element } => {
    switch (state()) {
      case "checking":
        return { text: "Checking for updates", icon: <UpdateSpinner /> };
      case "downloading":
        return { text: "New version is downloading", icon: <Icon name="update-app-download" size={28} /> };
      case "ready-to-install":
        return { text: "Relaunch to update the app", icon: <Icon name="update-app-check" size={28}/> };
      case "installing":
        return { text: "Relaunching the app to install new version", icon: <Icon name="update-app-check" size={28}/> };
      // The update check failed (offline, server down): checked again the
      // next time About opens.
      case "error":
        return { text: "Couldn't check for updates", icon: <Icon name="update-app-error" size={28}/> };
      default:
        return { text: "OpenTrader is up to date", icon: <Icon name="update-app-check" size={28}/> };
    }
  };
  return (
    <div class={`update-app ${state()}`}>
      <div class="update-app-text-container">
        <div class="update-app-status-icon">{view().icon}</div>
        <span class="update-app-status-text">{view().text}</span>
      </div>
      <Show when={state() === "installing"}>
        <UpdateSpinner />
      </Show>
      <Show when={state() === "ready-to-install"}>
        <button type="button" class="update-app-relaunch" onClick={installUpdate}>
          Relaunch
        </button>
      </Show>
    </div>
  );
}

/** The reference app ui-lib progress spinner, size small (24px), intent neutral. */
function UpdateSpinner() {
  return (
    <svg class="update-app-spinner" width="24" height="24" viewBox="0 0 24 24" role="progressbar" aria-label="Loading">
      <circle class="update-app-spinner-bg" cx="12" cy="12" r="11" />
      <circle class="update-app-spinner-fg" cx="12" cy="12" r="11" />
    </svg>
  );
}
