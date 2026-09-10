/**
 * Sound, synthesised.
 *
 * The same rule as the art: nothing is loaded from a file. Every sound is a few
 * oscillators and a burst of filtered noise, shaped by an envelope — which is
 * crude, but a crude thud on the frame a blade lands is worth more to how a
 * fight feels than anything drawn. Silence was a large part of why hitting
 * things felt like nothing.
 *
 * Browsers refuse to start audio before the user has interacted with the page,
 * so the context is created lazily on the first key or click.
 */

export type Sound =
  | "swing" | "swingHeavy" | "hit" | "hitHeavy" | "crit"
  | "bolt" | "boltHit" | "sunder" | "hurt" | "evade"
  | "windup" | "kill" | "pickup" | "death";

const STORAGE_KEY = "ostracon.muted";

export class SoundBoard {
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private noise: AudioBuffer | undefined;
  private muted: boolean;

  constructor() {
    let stored: string | null = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
    this.muted = stored === "1";
    const unlock = (): void => {
      this.ensure();
      if (this.context?.state === "suspended") void this.context.resume();
    };
    window.addEventListener("keydown", unlock);
    window.addEventListener("pointerdown", unlock);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try { localStorage.setItem(STORAGE_KEY, this.muted ? "1" : "0"); } catch { /* storage blocked */ }
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  private ensure(): AudioContext | undefined {
    if (this.context) return this.context;
    try {
      this.context = new AudioContext();
    } catch {
      return undefined;
    }
    this.master = this.context.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    // A gentle limiter, so twenty things dying at once is loud, not broken.
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 8;
    this.master.connect(limiter);
    limiter.connect(this.context.destination);

    const length = this.context.sampleRate;
    this.noise = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return this.context;
  }

  /**
   * @param volume 0..1, scaled further by distance by the caller.
   */
  play(sound: Sound, volume = 1): void {
    if (this.muted || volume <= 0.01) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== "running" || !this.master) return;
    const t = ctx.currentTime;
    // Slight pitch variety, so the same sound twice is not a machine gun.
    const pitch = 0.92 + Math.random() * 0.16;

    switch (sound) {
      case "swing":
        this.whoosh(t, 700 * pitch, 2600 * pitch, 0.13, 0.35 * volume);
        break;
      case "swingHeavy":
        this.whoosh(t, 400 * pitch, 1800 * pitch, 0.22, 0.5 * volume);
        break;
      case "hit":
        this.thud(t, 150 * pitch, 55, 0.12, 0.7 * volume);
        this.crack(t, 2400 * pitch, 0.05, 0.35 * volume);
        break;
      case "hitHeavy":
        this.thud(t, 120 * pitch, 40, 0.22, 0.95 * volume);
        this.crack(t, 1600 * pitch, 0.09, 0.5 * volume);
        break;
      case "crit":
        this.thud(t, 170 * pitch, 50, 0.16, 0.9 * volume);
        this.crack(t, 3200 * pitch, 0.06, 0.45 * volume);
        this.tone(t, 1320 * pitch, 1760 * pitch, 0.16, "triangle", 0.18 * volume);
        break;
      case "bolt":
        this.tone(t, 900 * pitch, 260 * pitch, 0.22, "sawtooth", 0.14 * volume, 2400);
        this.whoosh(t, 1200, 3800, 0.14, 0.14 * volume);
        break;
      case "boltHit":
        this.tone(t, 520 * pitch, 110, 0.2, "square", 0.12 * volume, 1400);
        this.crack(t, 2800, 0.07, 0.3 * volume);
        break;
      case "sunder":
        this.thud(t, 90 * pitch, 32, 0.45, 1.0 * volume);
        this.rumble(t, 0.5, 0.5 * volume);
        break;
      case "hurt":
        this.thud(t, 110 * pitch, 60, 0.14, 0.8 * volume);
        this.tone(t, 260 * pitch, 140, 0.16, "square", 0.1 * volume, 900);
        break;
      case "evade":
        this.whoosh(t, 500, 1400, 0.18, 0.25 * volume);
        this.tone(t, 880, 1320, 0.1, "triangle", 0.08 * volume);
        break;
      case "windup":
        // A low rising growl: something is about to happen to you.
        this.tone(t, 70 * pitch, 130 * pitch, 0.38, "sawtooth", 0.09 * volume, 420);
        break;
      case "kill":
        this.thud(t, 90, 30, 0.3, 0.7 * volume);
        this.tone(t, 600 * pitch, 200 * pitch, 0.3, "triangle", 0.12 * volume);
        break;
      case "pickup":
        this.tone(t, 880, 880, 0.08, "triangle", 0.16 * volume);
        this.tone(t + 0.08, 1320, 1320, 0.12, "triangle", 0.16 * volume);
        break;
      case "death":
        this.tone(t, 330, 80, 0.9, "triangle", 0.22 * volume);
        this.rumble(t, 0.6, 0.3 * volume);
        break;
    }
  }

  /** Filtered noise swept upward: air being cut. */
  private whoosh(t: number, from: number, to: number, length: number, gain: number): void {
    const ctx = this.context!;
    const source = ctx.createBufferSource();
    source.buffer = this.noise!;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + length);
    const env = this.envelope(t, 0.015, length, gain);
    source.connect(filter).connect(env).connect(this.master!);
    source.start(t, Math.random() * 0.5, length + 0.05);
  }

  /** A pitched drop: the body of an impact. */
  private thud(t: number, from: number, to: number, length: number, gain: number): void {
    const ctx = this.context!;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + length);
    const env = this.envelope(t, 0.003, length, gain);
    osc.connect(env).connect(this.master!);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }

  /** A short bright click: the edge of an impact. */
  private crack(t: number, frequency: number, length: number, gain: number): void {
    const ctx = this.context!;
    const source = ctx.createBufferSource();
    source.buffer = this.noise!;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = frequency;
    const env = this.envelope(t, 0.001, length, gain);
    source.connect(filter).connect(env).connect(this.master!);
    source.start(t, Math.random() * 0.5, length + 0.02);
  }

  private rumble(t: number, length: number, gain: number): void {
    const ctx = this.context!;
    const source = ctx.createBufferSource();
    source.buffer = this.noise!;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(60, t + length);
    const env = this.envelope(t, 0.01, length, gain);
    source.connect(filter).connect(env).connect(this.master!);
    source.start(t, Math.random() * 0.3, length + 0.05);
  }

  private tone(
    t: number, from: number, to: number, length: number,
    type: OscillatorType, gain: number, lowpass?: number,
  ): void {
    const ctx = this.context!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + length);
    const env = this.envelope(t, 0.005, length, gain);
    if (lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = lowpass;
      osc.connect(filter).connect(env).connect(this.master!);
    } else {
      osc.connect(env).connect(this.master!);
    }
    osc.start(t);
    osc.stop(t + length + 0.05);
  }

  private envelope(t: number, attack: number, length: number, gain: number): GainNode {
    const env = this.context!.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + length);
    return env;
  }
}
