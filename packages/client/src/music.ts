import { regionOf, settlementsIn, type OstraDefinition } from "@mmo/shared";
import type { SoundBoard } from "./audio.js";

/**
 * Music, composed as it plays.
 *
 * The rule is the art's and the sound's: nothing is loaded. So there are no
 * tracks, only a small composer — a key, a mode and a pace for each place, a
 * four-chord round in it, and a few voices that play that round a little
 * differently every time: a slow pad, a bass under it, sparse plucked notes,
 * and now and then a short tune wandering over the top. Everything goes
 * through one long reverb, which is most of what turns oscillators into a
 * room.
 *
 * It follows you. The Westwood is a warm dorian, Ashfall a slow phrygian over
 * a drone, the Brightwater a bright lydian, a town a little livelier than the
 * woods round it, a dungeon almost nothing but a low hum. A change of place
 * waits for the next bar, so it turns rather than cuts. In a fight a second
 * layer comes in — a pulse and a driving bass on the same chords — and goes
 * again when the fight does.
 *
 * Scheduling is Web Audio's usual lookahead: each frame, every note due in
 * the next few tenths of a second is queued at its exact time on the audio
 * clock, so frame hitches never make it stumble. When the page is hidden the
 * frames stop and so, after the queued notes, does the music.
 */

/** Semitone steps of each mode from its root. */
const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
} as const;

interface Piece {
  /** MIDI note of the key's root, around the bass register. */
  root: number;
  mode: keyof typeof MODES;
  /** Scale degrees (0-based) of the four chords in the round. */
  round: readonly [number, number, number, number];
  bpm: number;
  /** Chance of a plucked note on each half-beat. */
  pluck: number;
  /** Chance a bar carries a phrase of tune. */
  tune: number;
  /** The tune's voice. */
  lead: OscillatorType;
  /** Lowpass on everything, in Hz: how bright the place sounds. */
  brightness: number;
  /** A low fifth held under it all. */
  drone: boolean;
}

const PIECES: Record<string, Piece> = {
  town: { root: 50, mode: "dorian", round: [0, 3, 6, 4], bpm: 76, pluck: 0.5, tune: 0.4, lead: "triangle", brightness: 2400, drone: false },
  westwood: { root: 45, mode: "dorian", round: [0, 5, 3, 4], bpm: 66, pluck: 0.32, tune: 0.22, lead: "triangle", brightness: 1800, drone: false },
  heartland: { root: 43, mode: "mixolydian", round: [0, 6, 3, 0], bpm: 70, pluck: 0.38, tune: 0.25, lead: "sine", brightness: 2100, drone: false },
  greywood: { root: 40, mode: "aeolian", round: [0, 5, 6, 4], bpm: 58, pluck: 0.22, tune: 0.12, lead: "sine", brightness: 1300, drone: true },
  highmoor: { root: 38, mode: "aeolian", round: [0, 3, 0, 4], bpm: 54, pluck: 0.14, tune: 0.32, lead: "sine", brightness: 1900, drone: true },
  sunward: { root: 41, mode: "ionian", round: [0, 3, 4, 0], bpm: 80, pluck: 0.48, tune: 0.3, lead: "triangle", brightness: 2800, drone: false },
  brightwater: { root: 51, mode: "lydian", round: [0, 1, 4, 0], bpm: 64, pluck: 0.42, tune: 0.26, lead: "sine", brightness: 3200, drone: false },
  redstep: { root: 40, mode: "phrygian", round: [0, 1, 0, 6], bpm: 62, pluck: 0.28, tune: 0.14, lead: "triangle", brightness: 1500, drone: true },
  ashfall: { root: 35, mode: "phrygian", round: [0, 1, 5, 1], bpm: 50, pluck: 0.14, tune: 0.08, lead: "sine", brightness: 950, drone: true },
  lowfen: { root: 37, mode: "aeolian", round: [0, 5, 0, 6], bpm: 52, pluck: 0.18, tune: 0.1, lead: "sine", brightness: 1050, drone: true },
  ascendant: { root: 48, mode: "lydian", round: [0, 4, 1, 0], bpm: 60, pluck: 0.3, tune: 0.3, lead: "sine", brightness: 3000, drone: true },
  barals: { root: 36, mode: "phrygian", round: [0, 1, 4, 1], bpm: 48, pluck: 0.12, tune: 0.06, lead: "sine", brightness: 850, drone: true },
  dungeon: { root: 36, mode: "harmonicMinor", round: [0, 1, 0, 4], bpm: 46, pluck: 0.1, tune: 0.04, lead: "sine", brightness: 700, drone: true },
};

/** Within this of a town's edge, you hear the town. */
const TOWN_REACH = 70;

/** Where you are, musically. */
function pieceFor(ostra: OstraDefinition, x: number, z: number): string {
  if (ostra.dungeon) return "dungeon";
  if (settlementsIn(ostra).some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + TOWN_REACH)) return "town";
  if (ostra.wilds) {
    const region = regionOf(ostra, x, z);
    if (region && PIECES[region.id]) return region.id;
  }
  return PIECES[ostra.id] ? ostra.id : "heartland";
}

function frequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Every voice's level, together. Rendered offline, the first mix sat about
 * 44 dB down — under a sword swing by more than a sword swing is under a
 * shout. This puts the calm places around -36 dB of RMS with the reverb on,
 * which is background: there, but never over a telegraph's warning.
 */
const VOICE_LEVEL = 2.2;

/** How far ahead notes are queued, in seconds. */
const LOOKAHEAD = 0.35;

export class Music {
  private piece: Piece = PIECES["westwood"]!;
  private pieceId = "westwood";
  /** The piece to turn to at the next bar. */
  private wantedId = "westwood";
  /** Audio-clock time of the next half-beat, and which one it is. */
  private nextStep = 0;
  private step = 0;
  /** 0..1, eased towards whether you are fighting. */
  private fight = 0;
  private fighting = false;
  /** Where the tune is, as a scale step, so a phrase wanders rather than jumps. */
  private tuneStep = 7;
  /** A bar of the round played thin, now and then, so it breathes. */
  private sparse = false;
  private skinBuffer: AudioBuffer | undefined;

  constructor(private readonly board: SoundBoard) {}

  /** Once a frame, with where you are and whether you are in a fight. */
  update(ostra: OstraDefinition | undefined, x: number, z: number, inCombat: boolean): void {
    const bus = this.board.musicBus();
    if (!bus || !ostra || this.board.isMuted || this.board.musicLevel <= 0) return;
    const ctx = bus.context;

    this.wantedId = pieceFor(ostra, x, z);
    this.fighting = inCombat;

    // After a silence (a hidden tab, a long hitch, the first frame) start a
    // little ahead rather than playing every missed note at once.
    if (this.nextStep < ctx.currentTime) {
      this.nextStep = ctx.currentTime + 0.1;
      this.step = 0;
    }

    while (this.nextStep < ctx.currentTime + LOOKAHEAD) {
      this.playStep(bus, this.nextStep);
      const half = 30 / this.piece.bpm;
      this.nextStep += half * (this.fight > 0.5 ? 0.85 : 1);
      this.step++;
    }
  }

  /** One half-beat. 8 to a bar, 32 to a round of four chords. */
  private playStep(bus: { context: AudioContext; dry: GainNode; wet: GainNode }, t: number): void {
    const half = 30 / this.piece.bpm;
    const inBar = this.step % 8;

    if (inBar === 0) {
      // Bar lines are where things change: the place, the fight, the texture.
      if (this.wantedId !== this.pieceId) {
        this.pieceId = this.wantedId;
        this.piece = PIECES[this.pieceId]!;
        this.step = 0;
      }
      if (this.step % 32 === 0) this.sparse = Math.random() < 0.2;
    }
    // The fight eases in and out a beat at a time: a bar is three seconds or
    // more, far too slow to answer the first blow.
    if (inBar % 2 === 0) {
      this.fight += ((this.fighting ? 1 : 0) - this.fight) * 0.35;
      if (this.fight < 0.03) this.fight = 0;
    }

    const piece = this.piece;
    const chord = piece.round[Math.floor((this.step % 32) / 8)]!;
    const bar = half * 8;

    if (inBar === 0) {
      // The pad: the chord's triad, voiced an octave above the bass, swelling
      // in and fading out past the bar so one chord leans into the next.
      for (const degree of [0, 2, 4]) {
        this.voice(bus, t, this.note(chord + degree, 12), bar * 1.25, "triangle", 0.035, piece.brightness * 0.6, 0.9, 0.55);
      }
      this.voice(bus, t, this.note(chord, 0), bar, "sine", 0.07, 400, 0.2, 0.15);
      if (piece.drone) {
        this.voice(bus, t, piece.root - 12, bar * 1.1, "sawtooth", 0.018, 220, 1.2, 0.2);
        this.voice(bus, t, piece.root - 5, bar * 1.1, "sine", 0.02, 300, 1.2, 0.2);
      }
      if (!this.sparse && Math.random() < piece.tune) this.phrase(bus, t, half, chord);
    }

    if (!this.sparse && Math.random() < piece.pluck) {
      const degree = chord + [0, 2, 4, 7][Math.floor(Math.random() * 4)]!;
      this.voice(bus, t, this.note(degree, 24), 0.9, "triangle", 0.05, piece.brightness, 0.004, 0.45);
    }

    // The fight: a pulse on the beat, a driving bass on the half-beats, and a
    // skin struck on the offbeats. Faded by `fight`, so it arrives over a bar
    // or two rather than on the first blow.
    if (this.fight > 0.05) {
      const f = this.fight;
      if (inBar % 2 === 0) this.kick(bus, t, 0.35 * f);
      if (inBar % 4 === 3) this.skin(bus, t, 0.12 * f);
      const bassDegree = inBar % 4 === 2 ? chord + 4 : chord;
      this.voice(bus, t, this.note(bassDegree, -12), half * 0.9, "sawtooth", 0.05 * f, 500, 0.005, 0.05);
    }
  }

  /** A few notes of tune across a bar, stepping through the scale. */
  private phrase(bus: { context: AudioContext; dry: GainNode; wet: GainNode }, t: number, half: number, chord: number): void {
    const piece = this.piece;
    // Start on or near the chord, so the tune agrees with the harmony.
    this.tuneStep = chord + 7 + [0, 2, 4][Math.floor(Math.random() * 3)]!;
    let at = t;
    const notes = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < notes; i++) {
      const long = Math.random() < 0.35 ? 2 : 1;
      this.voice(bus, at, this.note(this.tuneStep, 12), half * long * 1.6, piece.lead, 0.045, piece.brightness * 1.2, 0.03, 0.6);
      at += half * long;
      this.tuneStep += [-2, -1, -1, 1, 1, 2][Math.floor(Math.random() * 6)]!;
    }
  }

  /** A scale degree (any integer; octaves wrap) as a MIDI note, `octave` semitones up. */
  private note(degree: number, octave: number): number {
    const mode = MODES[this.piece.mode];
    const wrapped = ((degree % 7) + 7) % 7;
    return this.piece.root + mode[wrapped]! + 12 * Math.floor(degree / 7) + octave;
  }

  private voice(
    bus: { context: AudioContext; dry: GainNode; wet: GainNode },
    t: number, midi: number, length: number, type: OscillatorType,
    gain: number, lowpass: number, attack: number, reverb: number,
  ): void {
    const ctx = bus.context;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency(midi);
    // A breath of detune, so two voices on one note beat against each other.
    osc.detune.value = (Math.random() - 0.5) * 8;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain * VOICE_LEVEL, t + Math.max(0.003, attack));
    env.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.05, length));
    osc.connect(filter).connect(env);
    env.connect(bus.dry);
    if (reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      env.connect(send).connect(bus.wet);
    }
    osc.start(t);
    osc.stop(t + length + 0.1);
  }

  /** A low drum: a sine falling fast. */
  private kick(bus: { context: AudioContext; dry: GainNode; wet: GainNode }, t: number, gain: number): void {
    const ctx = bus.context;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(env).connect(bus.dry);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  /** A hand on a drum skin: a short burst of band-passed noise. */
  private skin(bus: { context: AudioContext; dry: GainNode; wet: GainNode }, t: number, gain: number): void {
    const ctx = bus.context;
    if (!this.skinBuffer) {
      const length = Math.floor(ctx.sampleRate * 0.12);
      this.skinBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.skinBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }
    const source = ctx.createBufferSource();
    source.buffer = this.skinBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 320;
    filter.Q.value = 2;
    const env = ctx.createGain();
    env.gain.value = gain;
    source.connect(filter).connect(env);
    env.connect(bus.dry);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    env.connect(send).connect(bus.wet);
    source.start(t);
  }
}
