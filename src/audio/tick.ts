/**
 * Ambient clock tick — WebAudio, fully synthesized, no asset files.
 *
 * SPEC DEVIATION (no ADR): comprehensive §7 / v3.2 §4 reference a "background
 * ambient clock ticking sound" that the explainer modal "halts", but neither
 * spec defines the sound, how it is produced, or its lifecycle. We synthesize it
 * at runtime so the bundle ships no audio assets, and expose the minimal control
 * surface the UI needs: start / stop / isRunning, plus mute and dispose.
 *
 * Two browser constraints shape the design:
 *   1. Autoplay policy — an `AudioContext` created before a user gesture starts
 *      `suspended` and produces no sound. So the context is created LAZILY on the
 *      first `start()`, which the UI only calls from within a user gesture.
 *   2. Timer drift — `setInterval` is not sample-accurate. We use a lookahead
 *      scheduler: a coarse interval wakes up and schedules any ticks due within a
 *      small horizon against the audio clock (`ctx.currentTime`), so tick timing
 *      is driven by the audio hardware, not the JS event loop.
 *
 * Each tick is a short band-limited click — a fast-decaying tone through a
 * bandpass — kept deliberately quiet and sober (this is an instrument panel, not
 * an alarm). The modal halts it by calling `stop()`.
 */

export interface TickEngineOptions {
  /** Seconds between ticks. Default 1.0 — one tick per second. */
  readonly intervalSeconds?: number;
  /** Peak gain of a tick, 0..1. Default 0.06 — intentionally faint. */
  readonly volume?: number;
  /** Centre frequency of the click's bandpass, Hz. Default 1750. */
  readonly frequency?: number;
}

export interface TickEngine {
  /** Begin ticking. Lazily creates/resumes the AudioContext. Call from a gesture. */
  start(): void;
  /** Stop ticking. Keeps the AudioContext alive for a cheap restart. */
  stop(): void;
  /** Whether ticks are currently scheduling. */
  isRunning(): boolean;
  /** Mute without changing running state; unmuting restores audible ticks. */
  setMuted(muted: boolean): void;
  /** Whether muted. */
  isMuted(): boolean;
  /** Tear down all audio resources. The engine is unusable afterwards. */
  dispose(): void;
}

const DEFAULTS = {
  intervalSeconds: 1.0,
  volume: 0.06,
  frequency: 1750,
} as const;

/** How often the scheduler wakes to look ahead, ms. */
const SCHEDULER_INTERVAL_MS = 120;
/** How far ahead of the audio clock we schedule ticks, seconds. */
const SCHEDULE_AHEAD_SECONDS = 0.25;
/** Envelope duration of a single tick, seconds. */
const TICK_DURATION_SECONDS = 0.045;

type AudioContextCtor = typeof AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function createTickEngine(options: TickEngineOptions = {}): TickEngine {
  const intervalSeconds = options.intervalSeconds ?? DEFAULTS.intervalSeconds;
  const volume = options.volume ?? DEFAULTS.volume;
  const frequency = options.frequency ?? DEFAULTS.frequency;

  let ctx: AudioContext | null = null;
  /** Master gain — set to 0 when muted, `volume` otherwise. */
  let master: GainNode | null = null;
  let running = false;
  let muted = false;
  let schedulerId: ReturnType<typeof setInterval> | null = null;
  /** Audio-clock time of the next tick to be scheduled. */
  let nextTickTime = 0;

  function ensureContext(): AudioContext | null {
    if (ctx) return ctx;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);
    return ctx;
  }

  /** Synthesize one click at absolute audio-clock time `when`. */
  function scheduleTick(audio: AudioContext, out: GainNode, when: number): void {
    const osc = audio.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = frequency;

    const band = audio.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = frequency;
    band.Q.value = 6;

    // Percussive envelope: near-instant attack, fast exponential decay. Gives the
    // dry "tick" transient rather than a sustained beep.
    const env = audio.createGain();
    const peak = 1;
    const floor = 0.0001;
    env.gain.setValueAtTime(floor, when);
    env.gain.exponentialRampToValueAtTime(peak, when + 0.001);
    env.gain.exponentialRampToValueAtTime(
      floor,
      when + TICK_DURATION_SECONDS,
    );

    osc.connect(band);
    band.connect(env);
    env.connect(out);

    osc.start(when);
    osc.stop(when + TICK_DURATION_SECONDS + 0.01);

    // Release node graph once the tick has sounded so nodes don't accumulate.
    osc.onended = () => {
      osc.disconnect();
      band.disconnect();
      env.disconnect();
    };
  }

  function tickLoop(): void {
    if (!running || !ctx || !master) return;
    const horizon = ctx.currentTime + SCHEDULE_AHEAD_SECONDS;
    while (nextTickTime < horizon) {
      // Only spend an oscillator when audible; still advance the schedule so
      // unmuting resumes on the beat rather than mid-interval.
      if (!muted) scheduleTick(ctx, master, nextTickTime);
      nextTickTime += intervalSeconds;
    }
  }

  function start(): void {
    if (running) return;
    const audio = ensureContext();
    if (!audio || !master) return;

    // A context created before a gesture is suspended; resume is what the gesture
    // actually authorizes. The promise is intentionally not awaited — scheduling
    // against `currentTime` is correct whether or not resume has resolved yet.
    if (audio.state === 'suspended') void audio.resume();

    running = true;
    nextTickTime = audio.currentTime + 0.06;
    tickLoop();
    schedulerId = setInterval(tickLoop, SCHEDULER_INTERVAL_MS);
  }

  function stop(): void {
    if (!running) return;
    running = false;
    if (schedulerId !== null) {
      clearInterval(schedulerId);
      schedulerId = null;
    }
  }

  function setMuted(next: boolean): void {
    muted = next;
    if (master && ctx) {
      // Ramp to avoid a click on the master gain itself.
      master.gain.setTargetAtTime(next ? 0 : volume, ctx.currentTime, 0.01);
    }
  }

  function dispose(): void {
    stop();
    master?.disconnect();
    master = null;
    if (ctx) {
      void ctx.close();
      ctx = null;
    }
  }

  return {
    start,
    stop,
    isRunning: () => running,
    setMuted,
    isMuted: () => muted,
    dispose,
  };
}
