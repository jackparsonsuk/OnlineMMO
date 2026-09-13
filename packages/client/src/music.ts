import { regionOf, settlementsIn, type OstraDefinition } from "@mmo/shared";
import type { SoundBoard } from "./audio.js";

/**
 * Music, composed as it plays.
 *
 * The rule is the art's and the sound's: nothing is loaded. So there are no
 * tracks, only a small composer — a key, a mode and a pace for each place,
 * a few four-chord rounds in it, and voices that play them a little
 * differently every time: a pad, a bass under it, plucked notes, now and then
 * a short tune. Everything goes through one long reverb, which is most of
 * what turns oscillators into a room.
 *
 * A place is more than its key. Each piece also chooses its instruments and
 * what else is in the air, so the zones sound like different places rather
 * than the same tune moved up or down: the Westwood a warm lute over a soft
 * pad; the Heartland open fifths and a flute; Sunward bright and quick;
 * the Brightwater glassy bells. And the hard country is meant to unsettle —
 * the Highmoor is a tritone drone under wind, a heartbeat, and a bell a long
 * way off that is never quite in tune; Redstep is a clashing semitone in the
 * pad, dry rasping plucks and war drums that never settle into a beat;
 * Ashfall groans; Lowfen drips and trembles.
 *
 * It varies as it goes. A piece has two or three rounds and takes one at
 * random each time round; how busy it is rises and falls from round to round;
 * and one round in five is played thin, so it breathes.
 *
 * It follows you: a change of place waits for the next bar, so it turns
 * rather than cuts. In a fight a second layer eases in a beat at a time — a
 * drum, a skin on the offbeats, a driving bass on the same chords — and eases
 * out again after.
 *
 * Scheduling is Web Audio's usual lookahead: each frame, every note due in
 * the next few tenths of a second is queued at its exact time on the audio
 * clock, so frame hitches never make it stumble.
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
  locrian: [0, 1, 3, 5, 6, 8, 10],
} as const;

type Round = readonly [number, number, number, number];

/** How a plucked note sounds. */
type PluckVoice = "lute" | "harp" | "bell" | "rasp";

interface Piece {
  /** MIDI note of the key's root, around the bass register. */
  root: number;
  mode: keyof typeof MODES;
  /** Scale degrees (0-based) of the chords; one round is chosen per time round. */
  rounds: readonly Round[];
  bpm: number;
  /** Chance of a plucked note on each half-beat, before the round's mood. */
  pluck: number;
  pluckVoice: PluckVoice;
  /** Chance a bar carries a phrase of tune. */
  tune: number;
  lead: OscillatorType;
  pad: OscillatorType;
  /** Lowpass on the pad and plucks, in Hz: how bright the place sounds. */
  brightness: number;
  /** A low drone held under it all: a fifth, or the tritone that will not settle. */
  drone?: "fifth" | "tritone";
  /** The pad also holds the note a semitone above the root: a clash. */
  cluster?: boolean;
  /** The pad trembles at this many times a second. */
  tremolo?: number;
  /** Chance per bar of wind rising and falling. */
  wind?: number;
  /** Chance per bar of a far bell, slightly out of tune. */
  farBell?: number;
  /** A slow heartbeat under everything. */
  heartbeat?: boolean;
  /** Chance per half-beat of a low war drum, off any beat. */
  warDrum?: number;
  /** Chance per half-beat of a drop of water. */
  drip?: number;
  /** Chance per bar of a low groan, bending down. */
  groan?: number;
}

const PIECES: Record<string, Piece> = {
  town: {
    root: 50, mode: "dorian", rounds: [[0, 3, 6, 4], [0, 4, 3, 6], [5, 3, 6, 4]], bpm: 78,
    pluck: 0.55, pluckVoice: "lute", tune: 0.45, lead: "triangle", pad: "triangle", brightness: 2600,
  },
  westwood: {
    root: 45, mode: "dorian", rounds: [[0, 5, 3, 4], [0, 3, 4, 0], [5, 3, 0, 4]], bpm: 66,
    pluck: 0.35, pluckVoice: "lute", tune: 0.22, lead: "triangle", pad: "triangle", brightness: 1800,
  },
  heartland: {
    root: 43, mode: "mixolydian", rounds: [[0, 6, 3, 0], [0, 4, 6, 3], [3, 0, 6, 0]], bpm: 70,
    pluck: 0.3, pluckVoice: "harp", tune: 0.3, lead: "sine", pad: "sine", brightness: 2100, drone: "fifth",
  },
  greywood: {
    root: 40, mode: "aeolian", rounds: [[0, 5, 6, 4], [0, 3, 5, 4]], bpm: 58,
    pluck: 0.2, pluckVoice: "harp", tune: 0.12, lead: "sine", pad: "triangle", brightness: 1300,
    drone: "fifth", wind: 0.25, farBell: 0.08,
  },
  sunward: {
    root: 41, mode: "ionian", rounds: [[0, 3, 4, 0], [0, 5, 3, 4], [3, 4, 0, 0]], bpm: 84,
    pluck: 0.55, pluckVoice: "lute", tune: 0.35, lead: "triangle", pad: "triangle", brightness: 3000,
  },
  brightwater: {
    root: 51, mode: "lydian", rounds: [[0, 1, 4, 0], [0, 5, 1, 4]], bpm: 62,
    pluck: 0.4, pluckVoice: "bell", tune: 0.25, lead: "sine", pad: "sine", brightness: 3400, drip: 0.03,
  },
  // Hard country. These should make you look over your shoulder.
  highmoor: {
    root: 38, mode: "locrian", rounds: [[0, 4, 0, 1], [0, 1, 4, 5]], bpm: 48,
    pluck: 0.06, pluckVoice: "harp", tune: 0.1, lead: "sine", pad: "sine", brightness: 1100,
    drone: "tritone", tremolo: 5.5, wind: 0.7, farBell: 0.3, heartbeat: true,
  },
  redstep: {
    root: 40, mode: "harmonicMinor", rounds: [[0, 1, 0, 4], [0, 5, 1, 0], [1, 0, 4, 0]], bpm: 58,
    pluck: 0.22, pluckVoice: "rasp", tune: 0.08, lead: "sawtooth", pad: "sawtooth", brightness: 900,
    drone: "tritone", cluster: true, warDrum: 0.16, wind: 0.3, groan: 0.15,
  },
  ashfall: {
    root: 35, mode: "phrygian", rounds: [[0, 1, 5, 1], [0, 1, 0, 6]], bpm: 50,
    pluck: 0.1, pluckVoice: "rasp", tune: 0.05, lead: "sine", pad: "sawtooth", brightness: 800,
    drone: "fifth", cluster: true, groan: 0.35, wind: 0.4,
  },
  lowfen: {
    root: 37, mode: "aeolian", rounds: [[0, 5, 0, 6], [0, 1, 5, 0]], bpm: 52,
    pluck: 0.08, pluckVoice: "bell", tune: 0.08, lead: "sine", pad: "sine", brightness: 1000,
    drone: "fifth", tremolo: 3.5, drip: 0.14, groan: 0.1,
  },
  ascendant: {
    root: 48, mode: "lydian", rounds: [[0, 4, 1, 0], [0, 1, 5, 4]], bpm: 60,
    pluck: 0.3, pluckVoice: "bell", tune: 0.3, lead: "sine", pad: "sine", brightness: 3000, drone: "fifth", farBell: 0.2,
  },
  barals: {
    root: 36, mode: "locrian", rounds: [[0, 1, 4, 1], [0, 4, 0, 1]], bpm: 46,
    pluck: 0.08, pluckVoice: "rasp", tune: 0.04, lead: "sine", pad: "sawtooth", brightness: 750,
    drone: "tritone", cluster: true, heartbeat: true, groan: 0.3, wind: 0.5,
  },
  dungeon: {
    root: 36, mode: "harmonicMinor", rounds: [[0, 1, 0, 4], [0, 5, 1, 0]], bpm: 44,
    pluck: 0.06, pluckVoice: "bell", tune: 0.03, lead: "sine", pad: "sine", brightness: 650,
    drone: "tritone", drip: 0.1, heartbeat: true, groan: 0.12,
  },
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

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

/**
 * Every voice's level, together. Rendered offline, the first mix sat about
 * 44 dB down — under a sword swing by more than a sword swing is under a
 * shout. This puts the calm places around -36 dB of RMS with the reverb on,
 * which is background: there, but never over a telegraph's warning.
 */
const VOICE_LEVEL = 2.2;

/** How far ahead notes are queued, in seconds. */
const LOOKAHEAD = 0.35;

type Bus = { context: AudioContext; dry: GainNode; wet: GainNode };

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
  /** This time round: which round, how busy, and whether it is played thin. */
  private round: Round = [0, 3, 4, 0];
  private busy = 1;
  private sparse = false;
  private noiseBuffer: AudioBuffer | undefined;

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

  /** One half-beat. 8 to a bar, 32 to a time round the four chords. */
  private playStep(bus: Bus, t: number): void {
    const half = 30 / this.piece.bpm;
    const inBar = this.step % 8;

    if (inBar === 0) {
      // Bar lines are where things change: the place, and at the top of a
      // round, which round and how it is played.
      if (this.wantedId !== this.pieceId) {
        this.pieceId = this.wantedId;
        this.piece = PIECES[this.pieceId]!;
        this.step = 0;
      }
      if (this.step % 32 === 0) {
        this.round = pick(this.piece.rounds);
        this.sparse = Math.random() < 0.2;
        this.busy = 0.6 + Math.random() * 0.7;
      }
    }
    // The fight eases in and out a beat at a time: a bar is three seconds or
    // more, far too slow to answer the first blow.
    if (inBar % 2 === 0) {
      this.fight += ((this.fighting ? 1 : 0) - this.fight) * 0.35;
      if (this.fight < 0.03) this.fight = 0;
    }

    const piece = this.piece;
    const chord = this.round[Math.floor((this.step % 32) / 8)]!;
    const bar = half * 8;

    if (inBar === 0) {
      // The pad: the chord's triad, an octave above the bass, swelling in and
      // fading out past the bar so one chord leans into the next.
      const degrees = [0, 2, 4];
      for (const degree of degrees) {
        this.voice(bus, t, this.note(chord + degree, 12), bar * 1.25, piece.pad, piece.pad === "sawtooth" ? 0.014 : 0.035,
          piece.brightness * 0.6, 0.9, 0.55, piece.tremolo);
      }
      // A semitone rubbing against the root: nothing in it will resolve.
      if (piece.cluster) {
        this.voice(bus, t, piece.root + 12 + 1, bar * 1.25, "sine", 0.022, 900, 1.4, 0.6, piece.tremolo);
      }
      this.voice(bus, t, this.note(chord, 0), bar, "sine", 0.07, 400, 0.2, 0.15);
      if (piece.drone) {
        const upper = piece.drone === "tritone" ? 6 : 7;
        this.voice(bus, t, piece.root - 12, bar * 1.1, "sawtooth", 0.018, 220, 1.2, 0.2);
        this.voice(bus, t, piece.root - 12 + upper, bar * 1.1, "sine", 0.02, 300, 1.2, 0.2);
      }
      if (!this.sparse && Math.random() < piece.tune * this.busy) this.phrase(bus, t, half, chord);
      if (piece.wind && Math.random() < piece.wind) this.wind(bus, t, bar * (1 + Math.random()));
      if (piece.farBell && Math.random() < piece.farBell) this.farBell(bus, t + half * Math.floor(Math.random() * 8));
      if (piece.groan && Math.random() < piece.groan) this.groan(bus, t + half * (2 + Math.floor(Math.random() * 4)));
      if (piece.heartbeat) {
        this.drum(bus, t, 58, 0.16, 0.22);
        this.drum(bus, t + half * 0.45, 52, 0.12, 0.18);
      }
    }

    if (!this.sparse && Math.random() < piece.pluck * this.busy) {
      const degree = chord + pick([0, 2, 4, 7]);
      this.pluck(bus, t, this.note(degree, 24), piece);
    }
    // War drums fall where they like: a beat you cannot count on.
    if (piece.warDrum && Math.random() < piece.warDrum) this.drum(bus, t, 70 + Math.random() * 12, 0.3, 0.3);
    if (piece.drip && Math.random() < piece.drip) this.drip(bus, t + Math.random() * half);

    // The fight: a pulse on the beat, a driving bass on the half-beats, and a
    // skin struck on the offbeats. Faded by `fight`, so it arrives over a beat
    // or two rather than on the first blow.
    if (this.fight > 0.05) {
      const f = this.fight;
      if (inBar % 2 === 0) this.drum(bus, t, 110, 0.35 * f, 0.32, 42);
      if (inBar % 4 === 3) this.skin(bus, t, 0.12 * f);
      const bassDegree = inBar % 4 === 2 ? chord + 4 : chord;
      this.voice(bus, t, this.note(bassDegree, -12), half * 0.9, "sawtooth", 0.05 * f, 500, 0.005, 0.05);
    }
  }

  /** A few notes of tune across a bar, stepping through the scale. */
  private phrase(bus: Bus, t: number, half: number, chord: number): void {
    const piece = this.piece;
    // Start on or near the chord, so the tune agrees with the harmony; now
    // and then an octave up, so it is not always in the same place.
    this.tuneStep = chord + 7 + pick([0, 2, 4]);
    const octave = Math.random() < 0.25 ? 24 : 12;
    let at = t;
    const notes = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < notes; i++) {
      const long = Math.random() < 0.35 ? 2 : 1;
      this.voice(bus, at, this.note(this.tuneStep, octave), half * long * 1.6, piece.lead,
        piece.lead === "sawtooth" ? 0.018 : 0.045, piece.brightness * 1.2, 0.03, 0.6);
      at += half * long;
      this.tuneStep += pick([-2, -1, -1, 1, 1, 2]);
    }
  }

  /** A scale degree (any integer; octaves wrap) as a MIDI note, `octave` semitones up. */
  private note(degree: number, octave: number): number {
    const mode = MODES[this.piece.mode];
    const wrapped = ((degree % 7) + 7) % 7;
    return this.piece.root + mode[wrapped]! + 12 * Math.floor(degree / 7) + octave;
  }

  /** A plucked note, in the piece's own instrument. */
  private pluck(bus: Bus, t: number, midi: number, piece: Piece): void {
    switch (piece.pluckVoice) {
      case "lute":
        this.voice(bus, t, midi, 0.9, "triangle", 0.05, piece.brightness, 0.004, 0.45);
        break;
      case "harp":
        this.voice(bus, t, midi, 1.6, "sine", 0.05, piece.brightness * 1.4, 0.003, 0.7);
        this.voice(bus, t, midi + 12, 0.7, "sine", 0.012, piece.brightness * 2, 0.003, 0.7);
        break;
      case "bell":
        // A bell's partials are not whole multiples: that is what makes it glass.
        this.voice(bus, t, midi, 2.2, "sine", 0.04, 6000, 0.002, 0.8);
        this.voice(bus, t, midi + 28.2, 1.1, "sine", 0.014, 8000, 0.002, 0.8);
        break;
      case "rasp":
        this.voice(bus, t, midi - 12, 0.5, "square", 0.022, piece.brightness * 1.6, 0.002, 0.25);
        break;
    }
  }

  private voice(
    bus: Bus, t: number, midi: number, length: number, type: OscillatorType,
    gain: number, lowpass: number, attack: number, reverb: number, tremolo?: number,
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
    let out: AudioNode = env;
    osc.connect(filter).connect(env);
    if (tremolo) {
      // A shiver in the level: the sound of something not quite steady.
      const shiver = ctx.createGain();
      shiver.gain.value = 0.7;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = tremolo;
      const depth = ctx.createGain();
      depth.gain.value = 0.3;
      lfo.connect(depth).connect(shiver.gain);
      env.connect(shiver);
      out = shiver;
      lfo.start(t);
      lfo.stop(t + length + 0.1);
    }
    out.connect(bus.dry);
    if (reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      out.connect(send).connect(bus.wet);
    }
    osc.start(t);
    osc.stop(t + length + 0.1);
  }

  /** A low drum: a sine falling fast. */
  private drum(bus: Bus, t: number, from: number, gain: number, length: number, to = from * 0.45): void {
    const ctx = bus.context;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + length * 0.6);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(env).connect(bus.dry);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    env.connect(send).connect(bus.wet);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }

  private noise(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const length = ctx.sampleRate * 2;
      this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  /** A hand on a drum skin: a short burst of band-passed noise. */
  private skin(bus: Bus, t: number, gain: number): void {
    const ctx = bus.context;
    const source = ctx.createBufferSource();
    source.buffer = this.noise(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 320;
    filter.Q.value = 2;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    source.connect(filter).connect(env);
    env.connect(bus.dry);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    env.connect(send).connect(bus.wet);
    source.start(t, Math.random(), 0.15);
  }

  /** Wind: noise through a slowly sweeping band, rising and falling. */
  private wind(bus: Bus, t: number, length: number): void {
    const ctx = bus.context;
    const source = ctx.createBufferSource();
    source.buffer = this.noise(ctx);
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 4;
    filter.frequency.setValueAtTime(300 + Math.random() * 200, t);
    filter.frequency.linearRampToValueAtTime(700 + Math.random() * 600, t + length * 0.5);
    filter.frequency.linearRampToValueAtTime(250, t + length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.05, t + length * 0.45);
    env.gain.linearRampToValueAtTime(0.0001, t + length);
    source.connect(filter).connect(env);
    env.connect(bus.dry);
    const send = ctx.createGain();
    send.gain.value = 0.6;
    env.connect(send).connect(bus.wet);
    source.start(t, Math.random());
    source.stop(t + length + 0.05);
  }

  /** A bell a long way off, a little flat of anything in the key. */
  private farBell(bus: Bus, t: number): void {
    const midi = this.piece.root + 36 + pick([0, 6, 1]) - 0.3;
    this.voice(bus, t, midi, 4, "sine", 0.03, 5000, 0.004, 1.2);
    this.voice(bus, t, midi + 27.6, 2, "sine", 0.01, 7000, 0.004, 1.2);
  }

  /** Something low and large, bending down. */
  private groan(bus: Bus, t: number): void {
    const ctx = bus.context;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const start = frequency(this.piece.root - 5);
    osc.frequency.setValueAtTime(start, t);
    osc.frequency.exponentialRampToValueAtTime(start * 0.7, t + 2.4);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 260;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.06, t + 0.8);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    osc.connect(filter).connect(env);
    env.connect(bus.dry);
    const send = ctx.createGain();
    send.gain.value = 0.7;
    env.connect(send).connect(bus.wet);
    osc.start(t);
    osc.stop(t + 2.7);
  }

  /** A drop of water: a high sine that falls as it fades. */
  private drip(bus: Bus, t: number): void {
    const ctx = bus.context;
    const osc = ctx.createOscillator();
    const f = 1400 + Math.random() * 1400;
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.09);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.03, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(env);
    const send = ctx.createGain();
    send.gain.value = 0.9;
    env.connect(bus.dry);
    env.connect(send).connect(bus.wet);
    osc.start(t);
    osc.stop(t + 0.15);
  }
}
