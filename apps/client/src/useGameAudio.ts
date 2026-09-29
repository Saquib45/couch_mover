import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RoomPhase } from "@couch-movers/shared";

const MIN_GAIN = 0.0001;
const MUSIC_LOOKAHEAD_SECONDS = 0.24;
const SCHEDULER_INTERVAL_MS = 100;

type Waveform = OscillatorType;

export interface UseGameAudioOptions {
  muted: boolean;
  phase?: RoomPhase | null;
  level?: number | null;
}

export interface GameAudio {
  /** Call from a pointer, keyboard, or touch handler to unlock audio and begin music. */
  activate: () => Promise<boolean>;
  stop: () => void;
  playUiTap: () => void;
  playGrip: (engaged?: boolean) => void;
  playShout: (variant?: number) => void;
  playCollision: (strength?: number) => void;
  playBreak: () => void;
  playComplete: () => void;
}

interface MusicSettings {
  tempo: number;
  volume: number;
  density: number;
}

interface AudioState {
  muted: boolean;
  phase: RoomPhase | null;
  level: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function midiToFrequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

function normalizeLevel(level: number | null | undefined): number {
  return Number.isFinite(level) ? Math.max(1, level ?? 1) : 1;
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const audioWindow = window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  };
  return window.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function musicSettings(phase: RoomPhase | null, level: number): MusicSettings {
  // The full campaign ramps continuously, with the final job reaching maximum urgency.
  const difficulty = clamp((level - 1) / 11);
  switch (phase) {
    case "lobby":
      return { tempo: 88, volume: 0.36, density: 0.38 };
    case "countdown":
      return { tempo: 112 + difficulty * 5, volume: 0.68, density: 0.7 };
    case "playing":
      return {
        tempo: 100 + difficulty * 24,
        volume: 0.58 + difficulty * 0.16,
        density: 0.58 + difficulty * 0.34,
      };
    case "paused":
      return { tempo: 76, volume: 0.23, density: 0.22 };
    case "complete":
      return { tempo: 86, volume: 0.3, density: 0.3 };
    case "failed":
      return { tempo: 68, volume: 0.2, density: 0.18 };
    default:
      return { tempo: 88, volume: 0, density: 0 };
  }
}

class GameAudioEngine {
  readonly context: AudioContext;

  private readonly master: GainNode;
  private readonly musicBus: GainNode;
  private readonly effectsBus: GainNode;
  private readonly noiseBuffer: AudioBuffer;
  private state: AudioState = { muted: false, phase: null, level: 1 };
  private schedulerId: number | null = null;
  private nextStepTime = 0;
  private step = 0;
  private hidden = false;
  private manuallyStopped = false;
  private disposed = false;
  private lastCollisionAt = -Infinity;

  constructor(Context: typeof AudioContext) {
    this.context = new Context({ latencyHint: "interactive" });
    this.master = this.context.createGain();
    this.musicBus = this.context.createGain();
    this.effectsBus = this.context.createGain();
    const limiter = this.context.createDynamicsCompressor();

    this.master.gain.value = 0.72;
    this.musicBus.gain.value = MIN_GAIN;
    this.effectsBus.gain.value = 0.78;
    limiter.threshold.value = -8;
    limiter.knee.value = 12;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.12;

    this.musicBus.connect(this.master);
    this.effectsBus.connect(this.master);
    this.master.connect(limiter).connect(this.context.destination);

    const sampleCount = Math.floor(this.context.sampleRate * 0.32);
    this.noiseBuffer = this.context.createBuffer(1, sampleCount, this.context.sampleRate);
    const samples = this.noiseBuffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.random() * 2 - 1;
    }
  }

  update(nextState: AudioState): void {
    if (this.disposed) return;
    this.state = nextState;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(nextState.muted ? MIN_GAIN : 0.72, now, 0.025);

    const settings = musicSettings(nextState.phase, nextState.level);
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setTargetAtTime(
      nextState.muted ? MIN_GAIN : Math.max(MIN_GAIN, settings.volume * 0.22),
      now,
      0.08,
    );

    if (this.canPlayMusic()) this.startScheduler();
    else this.stopScheduler();
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.stopScheduler();
    else if (this.canPlayMusic()) this.startScheduler();
  }

  async activate(): Promise<boolean> {
    if (this.disposed || this.state.muted) return false;
    this.manuallyStopped = false;
    try {
      if (this.context.state !== "running") await this.context.resume();
    } catch {
      return false;
    }
    if (this.context.state !== "running") return false;
    if (this.canPlayMusic()) this.startScheduler();
    return true;
  }

  stop(): void {
    if (this.disposed) return;
    this.manuallyStopped = true;
    this.stopScheduler();
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(MIN_GAIN, now, 0.025);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopScheduler();
    void this.context.close().catch(() => undefined);
  }

  playUiTap(): void {
    const now = this.context.currentTime;
    this.tone(520, now, 0.055, 0.11, "sine", this.effectsBus, 690);
  }

  playGrip(engaged: boolean): void {
    const now = this.context.currentTime;
    if (engaged) {
      this.tone(145, now, 0.1, 0.22, "triangle", this.effectsBus, 112);
      this.tone(218, now + 0.035, 0.085, 0.12, "sine", this.effectsBus, 174);
    } else {
      this.tone(172, now, 0.075, 0.16, "triangle", this.effectsBus, 245);
    }
  }

  playShout(variant: number): void {
    const now = this.context.currentTime;
    const safeVariant = Math.abs(Math.round(variant)) % 4;
    const starts = [330, 392, 294, 247] as const;
    const finishes = [440, 523, 220, 330] as const;
    const start = starts[safeVariant] ?? starts[0];
    const finish = finishes[safeVariant] ?? finishes[0];
    this.tone(start, now, 0.1, 0.13, "square", this.effectsBus, finish);
    this.tone(finish, now + 0.085, 0.105, 0.09, "triangle", this.effectsBus);
  }

  playCollision(strength: number): void {
    const now = this.context.currentTime;
    const impact = clamp(Number.isFinite(strength) ? strength : 0.5);
    if (impact < 0.08 || now - this.lastCollisionAt < 0.065) return;
    this.lastCollisionAt = now;
    this.tone(76 + impact * 54, now, 0.06 + impact * 0.09, 0.08 + impact * 0.2, "sine", this.effectsBus, 48);
    this.noise(now, 0.035 + impact * 0.08, 0.025 + impact * 0.13, 180 + impact * 780);
  }

  playBreak(): void {
    const now = this.context.currentTime;
    this.noise(now, 0.23, 0.25, 1_450);
    this.noise(now + 0.055, 0.17, 0.17, 720);
    this.tone(235, now, 0.24, 0.2, "sawtooth", this.effectsBus, 72);
  }

  playComplete(): void {
    const now = this.context.currentTime + 0.015;
    const notes = [60, 64, 67, 72, 76] as const;
    notes.forEach((note, index) => {
      this.tone(
        midiToFrequency(note),
        now + index * 0.095,
        index === notes.length - 1 ? 0.42 : 0.18,
        0.14,
        index === notes.length - 1 ? "triangle" : "sine",
        this.effectsBus,
      );
    });
  }

  private canPlayMusic(): boolean {
    return (
      !this.disposed &&
      !this.manuallyStopped &&
      !this.hidden &&
      !this.state.muted &&
      this.state.phase !== null &&
      this.context.state === "running"
    );
  }

  private startScheduler(): void {
    if (this.schedulerId !== null || !this.canPlayMusic()) return;
    this.nextStepTime = this.context.currentTime + 0.035;
    this.scheduleMusic();
  }

  private stopScheduler(): void {
    if (this.schedulerId !== null) window.clearTimeout(this.schedulerId);
    this.schedulerId = null;
  }

  private readonly scheduleMusic = (): void => {
    this.schedulerId = null;
    if (!this.canPlayMusic()) return;

    while (this.nextStepTime < this.context.currentTime + MUSIC_LOOKAHEAD_SECONDS) {
      const settings = musicSettings(this.state.phase, this.state.level);
      this.scheduleMusicStep(this.step, this.nextStepTime, settings.density);
      this.nextStepTime += 30 / settings.tempo;
      this.step = (this.step + 1) % 32;
    }
    this.schedulerId = window.setTimeout(this.scheduleMusic, SCHEDULER_INTERVAL_MS);
  };

  private scheduleMusicStep(step: number, when: number, density: number): void {
    // A jaunty I-vi-IV-V loop, kept deliberately sparse for inexpensive mobile playback.
    const chordRoots = [48, 45, 41, 43] as const;
    const melody = [7, 12, 9, 7, 4, 7, 9, 4, 5, 9, 12, 9, 7, 11, 14, 11] as const;
    const root = chordRoots[Math.floor(step / 8) % chordRoots.length] ?? chordRoots[0];
    const phraseStep = step % melody.length;
    const melodyNote = melody[phraseStep] ?? melody[0];

    if (step % 2 === 0) {
      this.tone(midiToFrequency(root), when, 0.16, 0.48, "triangle", this.musicBus, undefined, 0.008);
    }
    if (step % 4 === 0) {
      this.tone(920, when, 0.025, 0.075, "square", this.musicBus, 620, 0.002);
    }
    if (step % 2 === 0 || (density > 0.78 && step % 4 === 3)) {
      const note = root + 12 + melodyNote;
      this.tone(midiToFrequency(note), when + 0.012, 0.1, 0.24, "square", this.musicBus, undefined, 0.006);
    }
    if (density > 0.85 && step % 4 === 2) {
      this.tone(midiToFrequency(root + 19), when, 0.07, 0.12, "sine", this.musicBus, undefined, 0.004);
    }
    if (this.state.level >= 6 && step % 8 === 4) {
      // A low rope-haul pulse gives the final jobs their own urgent cadence.
      this.tone(midiToFrequency(root - 5), when, 0.2, 0.18, "triangle", this.musicBus, midiToFrequency(root), 0.01);
    }
    if (this.state.level >= 7 && step % 8 === 6) {
      this.tone(midiToFrequency(root + 24), when, 0.085, 0.1, "square", this.musicBus, midiToFrequency(root + 19), 0.004);
    }
  }

  private tone(
    frequency: number,
    when: number,
    duration: number,
    volume: number,
    waveform: Waveform,
    destination: AudioNode,
    endFrequency?: number,
    attack = 0.005,
  ): void {
    if (this.disposed || this.state.muted) return;
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    const end = when + duration;
    oscillator.type = waveform;
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), when);
    if (endFrequency !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), end);
    }
    envelope.gain.setValueAtTime(MIN_GAIN, when);
    envelope.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, volume), when + attack);
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
    oscillator.connect(envelope).connect(destination);
    oscillator.addEventListener("ended", () => {
      oscillator.disconnect();
      envelope.disconnect();
    }, { once: true });
    oscillator.start(when);
    oscillator.stop(end + 0.01);
  }

  private noise(when: number, duration: number, volume: number, cutoff: number): void {
    if (this.disposed || this.state.muted) return;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    const end = when + duration;
    source.buffer = this.noiseBuffer;
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoff, when);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.35), end);
    envelope.gain.setValueAtTime(Math.max(MIN_GAIN, volume), when);
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
    source.connect(filter).connect(envelope).connect(this.effectsBus);
    source.addEventListener("ended", () => {
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
    }, { once: true });
    source.start(when);
    source.stop(end + 0.01);
  }
}

/**
 * Lightweight procedural game audio. No AudioContext is created until `activate`
 * or one of the sound methods is called from a user gesture.
 */
export function useGameAudio({ muted, phase = null, level = 1 }: UseGameAudioOptions): GameAudio {
  const engineRef = useRef<GameAudioEngine | null>(null);
  const stateRef = useRef<AudioState>({
    muted,
    phase,
    level: normalizeLevel(level),
  });
  stateRef.current = { muted, phase, level: normalizeLevel(level) };

  const getEngine = useCallback((): GameAudioEngine | null => {
    if (stateRef.current.muted) return null;
    const Context = getAudioContextConstructor();
    if (!Context) return null;
    if (!engineRef.current) {
      try {
        engineRef.current = new GameAudioEngine(Context);
      } catch {
        // Some embedded browsers expose Web Audio but still refuse construction.
        return null;
      }
    }
    engineRef.current.update(stateRef.current);
    return engineRef.current;
  }, []);

  const activate = useCallback(async (): Promise<boolean> => {
    const engine = getEngine();
    return engine ? engine.activate() : false;
  }, [getEngine]);

  const play = useCallback((effect: (engine: GameAudioEngine) => void): void => {
    const engine = getEngine();
    if (!engine) return;
    void engine.activate().then((active) => {
      if (active && !stateRef.current.muted) effect(engine);
    });
  }, [getEngine]);

  useEffect(() => {
    engineRef.current?.update(stateRef.current);
  }, [level, muted, phase]);

  useEffect(() => {
    if (muted) return;
    const handleFirstGesture = () => {
      window.removeEventListener("pointerdown", handleFirstGesture, true);
      window.removeEventListener("keydown", handleFirstGesture, true);
      void activate();
    };
    window.addEventListener("pointerdown", handleFirstGesture, true);
    window.addEventListener("keydown", handleFirstGesture, true);
    return () => {
      window.removeEventListener("pointerdown", handleFirstGesture, true);
      window.removeEventListener("keydown", handleFirstGesture, true);
    };
  }, [activate, muted]);

  useEffect(() => {
    const handleVisibility = () => engineRef.current?.setHidden(document.hidden);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => () => {
    engineRef.current?.dispose();
    engineRef.current = null;
  }, []);

  const stop = useCallback(() => engineRef.current?.stop(), []);
  const playUiTap = useCallback(() => play((engine) => engine.playUiTap()), [play]);
  const playGrip = useCallback((engaged = true) => play((engine) => engine.playGrip(engaged)), [play]);
  const playShout = useCallback((variant = 0) => play((engine) => engine.playShout(variant)), [play]);
  const playCollision = useCallback((strength = 0.5) => {
    play((engine) => engine.playCollision(strength));
  }, [play]);
  const playBreak = useCallback(() => play((engine) => engine.playBreak()), [play]);
  const playComplete = useCallback(() => play((engine) => engine.playComplete()), [play]);

  return useMemo(() => ({
    activate,
    stop,
    playUiTap,
    playGrip,
    playShout,
    playCollision,
    playBreak,
    playComplete,
  }), [activate, playBreak, playCollision, playComplete, playGrip, playShout, playUiTap, stop]);
}
