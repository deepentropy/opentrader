/*
 * Alert sounds — the "Classic" sound bank, synthesized with Web Audio.
 *
 * There are no audio files: each sound key maps to a small synthesis recipe
 * (notes, partials, envelope) written to sound like its name. Keys are stored
 * bare on the rule ("fired", "hand_bell", …).
 *
 * Playing: a sound plays once; with a duration (3, 5, 10, 30, 60 s) it starts
 * again each time it ends until that time has passed (the run in progress
 * finishes). A sound that is already playing is not started a second time.
 * It can be stopped at any moment (the popup of its alert was closed).
 *
 * Volume + enabled come from alert-settings.ts.
 */
import { alertSettings } from "./alert-settings";

/** One partial of a note: frequency ratio to the note and relative level. */
type Partial = [ratio: number, level: number];
/** One note: frequency (Hz), start (s), full-level time (s), then an
 *  exponential decay with time constant `tau` (s) cut `tail` s later. */
type Note = {
  freq: number;
  at: number;
  hold: number;
  tau: number;
  tail: number;
  attack?: number;
  level?: number;
  partials?: Partial[];
  /** Glide to this frequency over the note. */
  to?: number;
  /** Tremolo: rate (Hz) and depth (0–1). */
  trem?: [rate: number, depth: number];
  /** Trill: alternate with this frequency at this rate (Hz). */
  trill?: [freq: number, rate: number];
};

const PURE: Partial[] = [[1, 1]];
const REED: Partial[] = [[1, 1], [2, 0.34], [3, 0.23], [4, 0.2], [5, 0.17], [6, 0.15]];
const ORGAN: Partial[] = [[1, 1], [2, 0.75], [3, 0.5], [4, 0.28]];
const CHIME: Partial[] = [[1, 1], [0.5, 0.25], [1.5, 0.3]];
/** Small hand bell: a low hum under bright, inharmonic partials. */
const BELL: Partial[] = [[0.35, 0.3], [1, 1], [1.715, 0.8], [1.85, 0.6], [2.17, 0.7]];

const bellStrike = (at: number, level = 1, tau = 0.13, tail = 0.4): Note => ({ freq: 5005, at, hold: 0.01, tau, tail, attack: 0.004, level: level * 0.5, partials: BELL });

/** Sound bank. */
const BANK: Record<string, Note[]> = {
  // "Thin": one high, short ping.
  fired: [{ freq: 3768, at: 0, hold: 0.11, tau: 0.06, tail: 0.16, attack: 0.02, partials: [[1, 1], [2, 0.5]] }],
  // Three descending chime notes ringing into each other.
  "3_notes_reverb": [
    { freq: 2110, at: 0, hold: 0.02, tau: 0.6, tail: 2.3, attack: 0.01, level: 0.6, partials: CHIME },
    { freq: 1964, at: 0.175, hold: 0.02, tau: 0.6, tail: 2.15, attack: 0.01, level: 0.6, partials: CHIME },
    { freq: 1312, at: 0.365, hold: 0.02, tau: 0.65, tail: 2.0, attack: 0.01, level: 0.6, partials: CHIME },
  ],
  // A very high buzzer ringing for a third of a second.
  alarm_clock: [{ freq: 7396, at: 0, hold: 0.27, tau: 0.01, tail: 0.03, attack: 0.008, trem: [20, 0.35] }],
  // Two reedy beeps, the second one longer.
  beep_beep: [
    { freq: 656, at: 0, hold: 0.08, tau: 0.004, tail: 0.012, attack: 0.008, level: 0.55, partials: REED },
    { freq: 656, at: 0.1, hold: 0.15, tau: 0.006, tail: 0.02, attack: 0.008, level: 0.55, partials: REED },
  ],
  // A falling major chord that builds up, then rings out.
  calling: [
    { freq: 746, at: 0, hold: 0.42, tau: 0.45, tail: 1.28, attack: 0.04, level: 0.5, partials: ORGAN },
    { freq: 494, at: 0, hold: 0.55, tau: 0.5, tail: 1.15, attack: 0.04, level: 0.3, partials: ORGAN },
    { freq: 624.5, at: 0.42, hold: 0.13, tau: 0.5, tail: 1.15, attack: 0.01, level: 0.3, partials: ORGAN },
    { freq: 370, at: 0.55, hold: 0.02, tau: 0.5, tail: 1.13, attack: 0.02, level: 0.2, partials: ORGAN },
  ],
  // One short rising chirp.
  chirpy: [{ freq: 2500, to: 3550, at: 0, hold: 0.03, tau: 0.02, tail: 0.06, attack: 0.012, partials: [[1, 1], [2, 0.3]] }],
  // A harsh two-tone warble.
  fault: [{ freq: 1905, at: 0, hold: 0.3, tau: 0.012, tail: 0.04, attack: 0.02, level: 0.7, trill: [2190, 36] }],
  // A small bell shaken: quick pairs of strikes, the last one ringing out.
  hand_bell: [
    bellStrike(0), bellStrike(0.11, 0.9), bellStrike(0.31, 0.75), bellStrike(0.42, 0.95), bellStrike(0.55, 0.9),
    bellStrike(0.64, 1), bellStrike(0.84, 1), bellStrike(0.95, 0.95), bellStrike(1.09, 0.9, 0.16, 0.5),
  ],
};

/** The sounds, in the dialog's order, under their group title. */
export const SOUND_GROUP = "Classic";
export const SOUND_OPTIONS: { key: string; label: string }[] = [
  { key: "", label: "No sound" },
  { key: "fired", label: "Thin" },
  { key: "3_notes_reverb", label: "3 Notes Reverb" },
  { key: "alarm_clock", label: "Alarm Clock" },
  { key: "beep_beep", label: "Beep-beep" },
  { key: "calling", label: "Calling" },
  { key: "chirpy", label: "Chirpy" },
  { key: "fault", label: "Fault" },
  { key: "hand_bell", label: "Hand Bell" },
];

/** How long a sound keeps playing, in seconds (0 = once). */
export const SOUND_DURATIONS: { value: number; label: string }[] = [
  { value: 0, label: "Once" },
  { value: 3, label: "3 seconds" },
  { value: 5, label: "5 seconds" },
  { value: 10, label: "10 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "Minute" },
];

/** Every sound plays at half of the volume set in the settings. */
const SOUND_VOLUME = 0.5;

/** Length of one run of a sound, in seconds. */
export function soundLength(key: string): number {
  const notes = BANK[key];
  return notes ? Math.max(...notes.map((n) => n.at + n.hold + n.tail)) : 0;
}

/** Schedule one run of `key` on `ac` into `out`, starting at `t0`. */
export function renderSound(ac: BaseAudioContext, out: AudioNode, key: string, t0: number): void {
  for (const n of BANK[key] ?? []) {
    try {
      const parts = n.partials ?? PURE;
      const total = parts.reduce((s, p) => s + p[1], 0);
      const start = t0 + n.at;
      const attack = n.attack ?? 0.005;
      const hold = start + Math.max(attack, n.hold);
      const end = hold + n.tail;
      const peak = (n.level ?? 1) / total;
      const env = ac.createGain();
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(1, start + attack);
      env.gain.setValueAtTime(1, hold);
      env.gain.setTargetAtTime(0, hold, n.tau);
      // The decay is cut at `end`: a short ramp down so it does not click.
      env.gain.setValueAtTime(Math.exp(-n.tail / n.tau), end);
      env.gain.linearRampToValueAtTime(0, end + 0.01);
      let dest: AudioNode = env;
      if (n.trem) {
        const trem = ac.createGain();
        trem.gain.value = 1 - n.trem[1] / 2;
        const lfo = ac.createOscillator();
        const depth = ac.createGain();
        lfo.frequency.value = n.trem[0];
        depth.gain.value = n.trem[1] / 2;
        lfo.connect(depth).connect(trem.gain);
        lfo.start(start);
        lfo.stop(end + 0.02);
        env.connect(trem);
        dest = trem;
      }
      dest.connect(out);
      for (const [ratio, level] of parts) {
        const osc = ac.createOscillator();
        const g = ac.createGain();
        g.gain.value = peak * level;
        osc.frequency.setValueAtTime(n.freq * ratio, start);
        if (n.to) osc.frequency.linearRampToValueAtTime(n.to * ratio, hold + n.tail);
        if (n.trill) {
          const step = 1 / n.trill[1] / 2;
          for (let k = 1, t = start + step; t < end; k++, t += step) osc.frequency.setValueAtTime((k % 2 ? n.trill[0] : n.freq) * ratio, t);
        }
        osc.connect(g).connect(env);
        osc.start(start);
        osc.stop(end + 0.02);
      }
    } catch {
      /* one bad note must not abort the rest of the sound */
    }
  }
}

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

/** The sounds playing now: their output (cut to stop them) and the timer of
 *  the next run / of the end. */
const playing = new Map<string, { out: GainNode; timer: number }>();

export function isAlertSoundPlaying(key: string): boolean {
  return playing.has(key);
}

/** Stop `key`, or every sound when no key is given. */
export function stopAlertSound(key?: string): void {
  for (const [k, p] of [...playing]) {
    if (key !== undefined && k !== key) continue;
    clearTimeout(p.timer);
    try {
      const ac = p.out.context;
      p.out.gain.cancelScheduledValues(ac.currentTime);
      p.out.gain.setTargetAtTime(0, ac.currentTime, 0.01);
      window.setTimeout(() => p.out.disconnect(), 100);
    } catch {
      /* already gone */
    }
    playing.delete(k);
  }
}

/** Play a sound-bank key, repeated for `duration` seconds (0 = once). No-op
 *  when sound is disabled (except a `preview`, the dialog's play buttons),
 *  the key is empty / unknown, it is already playing, or Web Audio is
 *  unavailable. */
export function playAlertSound(key: string, opts: { preview?: boolean; duration?: number } = {}): void {
  if (!key || (!opts.preview && !alertSettings.soundEnabled())) return;
  if (!BANK[key] || playing.has(key)) return;
  const ac = audioContext();
  if (!ac) return;
  const volume = Math.max(0, Math.min(1, alertSettings.volume() / 100)) * SOUND_VOLUME;
  if (volume <= 0) return;
  const out = ac.createGain();
  out.gain.value = volume;
  out.connect(ac.destination);
  const length = soundLength(key) + 0.03;
  const until = Date.now() + (opts.duration ?? 0) * 1000;
  const entry = { out, timer: 0 };
  playing.set(key, entry);
  const run = () => {
    renderSound(ac, out, key, ac.currentTime + 0.01);
    entry.timer = window.setTimeout(() => {
      if (playing.get(key) !== entry) return;
      if (Date.now() < until) run();
      else stopAlertSound(key);
    }, length * 1000);
  };
  run();
}
