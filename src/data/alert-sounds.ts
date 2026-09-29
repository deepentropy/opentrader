/*
 * Alert sounds — Web Audio synth sound bank.
 *
 * There are no .mp3 sound assets, so each sound key (alert/fired,
 * alert/hand_bell, …) maps to a short synthesized tone pattern instead. The key
 * names stay stable so the rest of the system (and a future real-asset swap)
 * stays unchanged — drop mp3s in and switch playAlertSound to an <audio> source.
 *
 * Volume + enabled come from alert-settings.ts.
 */
import { alertSettings } from "./alert-settings";

/** One beep in a pattern: frequency (Hz), start offset (s), duration (s),
 *  optional waveform (defaults to sine) — the waveform gives each melody a
 *  distinct timbre on top of its distinct pitch contour. */
type Beep = { freq: number; at: number; dur: number; wave?: OscillatorType };

/** Sound bank — keys follow the `alert/<name>` scheme (stored without the
 *  `alert/` prefix here; the engine stores the bare key). Each melody has its
 *  own contour: single ping / bell dyad / rising triad / triple pulse / double
 *  beep / slow two-tone call / fast high chirps / falling minor pair. */
const BANK: Record<string, Beep[]> = {
  fired: [{ freq: 880, at: 0, dur: 0.18 }],
  hand_bell: [
    { freq: 1320, at: 0, dur: 0.12, wave: "triangle" },
    { freq: 1760, at: 0.1, dur: 0.3, wave: "triangle" },
  ],
  "3_notes_reverb": [
    { freq: 660, at: 0, dur: 0.14, wave: "triangle" },
    { freq: 880, at: 0.16, dur: 0.14, wave: "triangle" },
    { freq: 1100, at: 0.32, dur: 0.36, wave: "triangle" },
  ],
  alarm_clock: [
    { freq: 1050, at: 0, dur: 0.09, wave: "square" },
    { freq: 1050, at: 0.14, dur: 0.09, wave: "square" },
    { freq: 1050, at: 0.28, dur: 0.09, wave: "square" },
    { freq: 1050, at: 0.42, dur: 0.09, wave: "square" },
  ],
  beep_beep: [
    { freq: 760, at: 0, dur: 0.1 },
    { freq: 760, at: 0.18, dur: 0.1 },
  ],
  calling: [
    { freq: 480, at: 0, dur: 0.4 },
    { freq: 620, at: 0.45, dur: 0.4 },
    { freq: 480, at: 0.9, dur: 0.4 },
  ],
  chirpy: [
    { freq: 1500, at: 0, dur: 0.06 },
    { freq: 2000, at: 0.08, dur: 0.06 },
    { freq: 2500, at: 0.16, dur: 0.08 },
  ],
  fault: [
    { freq: 311, at: 0, dur: 0.22, wave: "triangle" },
    { freq: 233, at: 0.24, dur: 0.34, wave: "triangle" },
  ],
};

/** Dialog dropdown options (label + key). */
export const SOUND_OPTIONS: { key: string; label: string }[] = [
  { key: "", label: "No sound" },
  { key: "fired", label: "Fired" },
  { key: "hand_bell", label: "Hand bell" },
  { key: "3_notes_reverb", label: "Three notes" },
  { key: "alarm_clock", label: "Alarm clock" },
  { key: "beep_beep", label: "Beep beep" },
  { key: "calling", label: "Calling" },
  { key: "chirpy", label: "Chirpy" },
  { key: "fault", label: "Fault" },
];

let ctx: AudioContext | null = null;
function audioContext(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    // Browsers suspend the context until a user gesture; resume best-effort.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Play a sound-bank key. No-op when sound is disabled, the key is empty/
 *  unknown, or Web Audio is unavailable. */
export function playAlertSound(key: string): void {
  if (!key || !alertSettings.soundEnabled()) return;
  const pattern = BANK[key];
  if (!pattern) return;
  const ac = audioContext();
  if (!ac) return;
  const gainPeak = Math.max(0, Math.min(1, alertSettings.volume() / 100)) * 0.3;
  if (gainPeak <= 0) return;
  const t0 = ac.currentTime;
  for (const b of pattern) {
    try {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = b.wave ?? "sine";
      // Square carries far more energy than sine — pad it down so no melody
      // jumps out louder than the rest.
      const peak = osc.type === "square" ? gainPeak * 0.5 : gainPeak;
      osc.frequency.value = b.freq;
      // Short attack/decay envelope so each beep doesn't click. The sustain
      // point is clamped after the attack so very short beeps stay monotonic.
      const start = t0 + b.at;
      const end = start + b.dur;
      const sustain = Math.max(start + 0.01, end - 0.03);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.01);
      gain.gain.setValueAtTime(peak, sustain);
      gain.gain.linearRampToValueAtTime(0, end);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    } catch {
      /* one bad beep must not abort the rest of the pattern */
    }
  }
}
