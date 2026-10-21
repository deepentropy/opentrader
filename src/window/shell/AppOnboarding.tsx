/*
 * App onboarding — the reference desktop app's "Workspace setup & tips"
 * dialog, without its sign-in stage: theme, multi-monitor support, crosshair
 * sync, tabs linking by symbol. A progress bar on top, Prev / Next at the
 * bottom; the last stage's Next reads "Got it" and closes the dialog.
 *
 * Shown once on the first start of the desktop app (app-dialogs.ts,
 * kv ot:app-onboarding) and from the main menu's "App onboarding..." row.
 * The clips are recordings of this app (src/assets/onboarding, a dark and a
 * light take each); a clip loads when its stage shows. App loads this module
 * lazily.
 */
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Icon } from "../../components/Icon";
import { ThemePicker } from "../header/AppSettingsDialog";
import type { ThemeSetting } from "./app-theme";
import type { StdTheme } from "../header/chart-settings";

const CLIPS: Record<string, string> = {
  "multi-monitor-dark": new URL("../../assets/onboarding/multi-monitor-dark.webm", import.meta.url).href,
  "multi-monitor-light": new URL("../../assets/onboarding/multi-monitor-light.webm", import.meta.url).href,
  "crosshair-sync-dark": new URL("../../assets/onboarding/crosshair-sync-dark.webm", import.meta.url).href,
  "crosshair-sync-light": new URL("../../assets/onboarding/crosshair-sync-light.webm", import.meta.url).href,
  "tabs-linking-dark": new URL("../../assets/onboarding/tabs-linking-dark.webm", import.meta.url).href,
  "tabs-linking-light": new URL("../../assets/onboarding/tabs-linking-light.webm", import.meta.url).href,
};
const clip = (name: string, theme: StdTheme): string => CLIPS[`${name}-${theme}`];

type Stage = { title: string; subtitle: () => JSX.Element; clip?: string };

const STAGES: Stage[] = [
  {
    title: "Let's start with the theme",
    subtitle: () => "At first the app follows your system's theme, but you can change it here.",
  },
  {
    title: "Native multi-monitor support",
    subtitle: () => (
      <>
        Set up your workspace across several monitors, and get it back on the next start. Open a new window with{" "}
        <span class="onboarding-multi-monitor-icon-wrapper">
          <Icon name="tab-new-window" size={28} class="onboarding-multi-monitor-icon" />
        </span>{" "}
        or just drag a tab out of the window.
      </>
    ),
    clip: "multi-monitor",
  },
  {
    title: "Crosshair sync",
    subtitle: () => "The crosshair moves in sync across all your windows and displays, to compare charts at the same time.",
    clip: "crosshair-sync",
  },
  {
    title: "Tabs linking by symbol",
    subtitle: () => "Give several tabs the same color: a symbol change in one of them loads in all tabs of that color.",
    clip: "tabs-linking",
  },
];

type Props = {
  theme: StdTheme;
  themeSetting: ThemeSetting;
  onThemeChange: (s: ThemeSetting) => void;
  onClose: () => void;
};

export function AppOnboarding(props: Props) {
  let video: HTMLVideoElement | undefined;
  const [stage, setStage] = createSignal(0);
  const current = () => STAGES[stage()];
  const last = () => stage() === STAGES.length - 1;

  const next = () => (last() ? props.onClose() : setStage(stage() + 1));
  const prev = () => { if (stage() > 0) setStage(stage() - 1); };

  // Each stage's clip starts over.
  createEffect(on([stage, () => props.theme], () => {
    if (!video) return;
    video.currentTime = 0;
    void video.play().catch(() => { /* not loaded yet: autoplay starts it */ });
  }));

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  return (
    <div class="onboarding-overlay" data-qa-id="app-onboarding">
      <div class="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div class="onboarding">
          <div class="onboarding-progress-bar">
            <div class="onboarding-progress-bar-section">
              <p class="onboarding-progress-bar-section-title active">Workspace setup &amp; tips</p>
              <div class="onboarding-progress-bar-stages">
                <For each={STAGES}>
                  {(_, i) => <div class={`onboarding-progress-bar-stage tip${stage() === i() ? " active" : ""}`} />}
                </For>
              </div>
            </div>
          </div>
          <div class="onboarding-content">
            <h1 class="onboarding-content-title" id="onboarding-title">{current().title}</h1>
            <p class={`onboarding-content-subtitle${current().clip ? "" : " before-theme-picker"}`}>{current().subtitle()}</p>
            <div class="onboarding-content-content">
              <Show
                when={current().clip}
                fallback={<ThemePicker large setting={props.themeSetting} onChange={props.onThemeChange} />}
              >
                {(name) => (
                  <video
                    ref={video}
                    class="onboarding-video"
                    width={700}
                    height={278}
                    src={clip(name(), props.theme)}
                    autoplay
                    loop
                    muted
                    playsinline
                  />
                )}
              </Show>
            </div>
          </div>
          <Show when={stage() > 0}>
            <button type="button" class="onboarding-navigation-button onboarding-btn is-gray prev" onClick={prev}>
              Prev
            </button>
          </Show>
          <button type="button" class="onboarding-navigation-button onboarding-btn is-primary next" onClick={next}>
            {last() ? "Got it" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
