import { useEffect, useState } from 'react';

/**
 * The ride-hailing moments — a buzz you feel in your pocket and a chime you
 * hear across the room: your seat was accepted, the van is minutes away, the
 * van is here; for a driver, a new seat request or a rider who's outside;
 * for the desk, something needing attention.
 *
 * Sounds are synthesized (Web Audio — no files to load), play only once the
 * page has had a tap (browsers require it), and follow one mute switch per
 * device. Vibration is Android's (iOS Safari has none — silently skipped).
 */

export type RideAlert = 'confirmed' | 'near' | 'arrived' | 'aboard' | 'request' | 'signal' | 'attention';

const PATTERNS: Record<RideAlert, number[]> = {
  confirmed: [40, 60, 40],
  near: [120, 80, 120],
  arrived: [250, 100, 250, 100, 250],
  aboard: [30],
  request: [80, 60, 80, 60, 80],
  signal: [60, 40, 60],
  attention: [120, 80, 120],
};

/** Notes (Hz) and their lengths (s) — rising for good news, a double ping
 *  for "look at me". */
const TONES: Record<RideAlert, Array<[number, number]>> = {
  confirmed: [
    [660, 0.12],
    [880, 0.18],
  ],
  near: [
    [740, 0.12],
    [740, 0.12],
  ],
  arrived: [
    [660, 0.12],
    [880, 0.12],
    [1175, 0.24],
  ],
  aboard: [[880, 0.1]],
  request: [
    [988, 0.1],
    [1319, 0.1],
    [988, 0.1],
    [1319, 0.16],
  ],
  signal: [
    [880, 0.1],
    [660, 0.14],
  ],
  attention: [
    [587, 0.14],
    [440, 0.2],
  ],
};

const KEY = 'alto:rideSounds';

export function soundsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundsOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked — the choice just doesn't persist */
  }
  window.dispatchEvent(new CustomEvent('alto:rideSounds'));
}

let ctx: AudioContext | null = null;
let unlocked = false;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

/** Browsers only play sound after a tap: arm on the first one. */
export function armRideSounds(): void {
  if (unlocked || typeof window === 'undefined') return;
  const unlock = () => {
    unlocked = true;
    void audio()?.resume().catch(() => {});
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

function chime(kind: RideAlert): void {
  const a = audio();
  if (!a || !unlocked || a.state !== 'running') return;
  let t = a.currentTime + 0.01;
  for (const [freq, len] of TONES[kind]) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + len + 0.02);
    t += len + 0.03;
  }
}

/** Buzz and chime for one moment. */
export function rideAlert(kind: RideAlert): void {
  try {
    navigator.vibrate?.(PATTERNS[kind]);
  } catch {
    /* no vibration here */
  }
  if (soundsOn() && (typeof document === 'undefined' || document.visibilityState === 'visible')) chime(kind);
}

/** The mute switch's state, kept in step across the page. */
export function useRideSounds(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(soundsOn);
  useEffect(() => {
    armRideSounds();
    const sync = () => setOn(soundsOn());
    window.addEventListener('alto:rideSounds', sync);
    return () => window.removeEventListener('alto:rideSounds', sync);
  }, []);
  return [on, setSoundsOn];
}

/**
 * Fire an alert when something becomes true that wasn't on the last look —
 * a set of keys ("ride r1 accepted", "request r7") seen before is remembered,
 * so a refresh never repeats an alert, and the first look (page open) is
 * silent: it's the news since then that buzzes.
 */
export function useNewKeys(keys: string[] | null, onNew: (fresh: string[]) => void): void {
  const [seen] = useState(() => ({ ready: false, set: new Set<string>() }));
  const sig = keys?.slice().sort().join('|') ?? null;
  useEffect(() => {
    if (keys === null) return;
    const fresh = keys.filter((k) => !seen.set.has(k));
    for (const k of keys) seen.set.add(k);
    if (seen.ready && fresh.length > 0) onNew(fresh);
    seen.ready = true;
    // Keyed on the signature — a new array with the same keys is no news.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}
