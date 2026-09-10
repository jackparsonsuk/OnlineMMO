import { Color3 } from "@babylonjs/core/Maths/math.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { getArchetype, PLAYER_SIZE, type EnemyKind, type SpellId } from "@mmo/shared";
import { facet, flatMaterial, hexColour } from "./lowpoly.js";

/**
 * Bodies that move.
 *
 * Every figure in the game used to be a rigid statue that slid across the
 * ground and swelled slightly when hit. That is most of why combat felt like
 * nothing: there was no wind-up to read, no swing to watch land, no flinch, no
 * fall. These rigs are the same blocky, faceted models, but built around
 * pivots — shoulders, hips, a waist — so procedural animation can move them.
 *
 * No skeletal animation, no clips, no files: each pose is a handful of angles
 * computed from time, speed and whatever the body is doing. It suits the art
 * style (stiff, deliberate, readable), and it means the animation can be timed
 * to the exact numbers the simulation uses — a Risen's arms come down at the
 * moment its blow actually lands.
 */

export type RigKind = "player" | "zombie" | "spider";

export interface Rig {
  kind: RigKind;
  /** Placed at the feet, rotated to face. The caller owns its transform. */
  root: TransformNode;
  /** Child of root. Bob, lean, fall — anything the whole body does. */
  body: TransformNode;
  /** Named pivots. Which exist depends on the kind. */
  joints: Record<string, TransformNode>;
  /** Everything that should flash white on a hit. */
  materials: StandardMaterial[];
  /** Base emissive of each material, to restore after a flash. */
  baseEmissive: Color3[];
  /** Meshes a click can land on. */
  pickables: AbstractMesh[];
}

function box(
  scene: Scene,
  rig: Rig,
  parent: TransformNode,
  size: { width: number; height: number; depth: number },
  x: number,
  y: number,
  z: number,
  material: StandardMaterial,
): AbstractMesh {
  const mesh = MeshBuilder.CreateBox("part", size, scene);
  mesh.position.set(x, y, z);
  mesh.material = material;
  mesh.parent = parent;
  rig.pickables.push(mesh);
  return mesh;
}

function joint(scene: Scene, name: string, parent: TransformNode, x: number, y: number, z: number): TransformNode {
  const node = new TransformNode(name, scene);
  node.position.set(x, y, z);
  node.parent = parent;
  return node;
}

function newRig(scene: Scene, kind: RigKind): Rig {
  const root = new TransformNode(kind, scene);
  const body = new TransformNode("body", scene);
  body.parent = root;
  return { kind, root, body, joints: {}, materials: [], baseEmissive: [], pickables: [] };
}

function track(rig: Rig, ...materials: StandardMaterial[]): void {
  for (const material of materials) {
    rig.materials.push(material);
    rig.baseEmissive.push(material.emissiveColor.clone());
  }
}

/**
 * A player: blocky humanoid with a short blade in the right hand. The blade is
 * what makes a swing readable at a distance — an arm moving is a gesture, a
 * blade moving is an attack.
 */
export function buildPlayerRig(scene: Scene, colour: number): Rig {
  const rig = newRig(scene, "player");
  const u = PLAYER_SIZE;
  const bodyMat = flatMaterial(scene, "playerBody", colour);
  // Limbs a shade darker so the silhouette still reads when lit from above.
  const limbMat = flatMaterial(scene, "playerLimb", hexColour(colour).scale(0.62));
  const faceMat = flatMaterial(scene, "playerFace", hexColour(colour).scale(1.45));
  const steel = flatMaterial(scene, "blade", 0xc9d4dc);
  steel.emissiveColor = new Color3(0.12, 0.14, 0.16);
  track(rig, bodyMat, limbMat, faceMat, steel);

  const hips = 0.38 * u;
  const legL = joint(scene, "legL", rig.body, -0.14 * u, hips, 0);
  const legR = joint(scene, "legR", rig.body, 0.14 * u, hips, 0);
  box(scene, rig, legL, { width: 0.18 * u, height: 0.38 * u, depth: 0.18 * u }, 0, -0.19 * u, 0, limbMat);
  box(scene, rig, legR, { width: 0.18 * u, height: 0.38 * u, depth: 0.18 * u }, 0, -0.19 * u, 0, limbMat);

  // The waist: leaning and twisting happen here, so the legs stay planted.
  const chest = joint(scene, "chest", rig.body, 0, hips, 0);
  box(scene, rig, chest, { width: 0.52 * u, height: 0.52 * u, depth: 0.32 * u }, 0, 0.24 * u, 0, bodyMat);
  const head = joint(scene, "head", chest, 0, 0.5 * u, 0);
  box(scene, rig, head, { width: 0.34 * u, height: 0.34 * u, depth: 0.34 * u }, 0, 0.17 * u, 0, bodyMat);
  // A pale block on the front of the head: the facing cue.
  box(scene, rig, head, { width: 0.22 * u, height: 0.1 * u, depth: 0.06 * u }, 0, 0.19 * u, 0.17 * u, faceMat);

  const armL = joint(scene, "armL", chest, -0.33 * u, 0.45 * u, 0);
  const armR = joint(scene, "armR", chest, 0.33 * u, 0.45 * u, 0);
  box(scene, rig, armL, { width: 0.14 * u, height: 0.46 * u, depth: 0.16 * u }, 0, -0.21 * u, 0, limbMat);
  box(scene, rig, armR, { width: 0.14 * u, height: 0.46 * u, depth: 0.16 * u }, 0, -0.21 * u, 0, limbMat);

  // Held forward from the fist, so it points where the arm swings.
  const blade = joint(scene, "blade", armR, 0, -0.42 * u, 0.04 * u);
  box(scene, rig, blade, { width: 0.05, height: 0.07, depth: 0.62 }, 0, 0, 0.34, steel);
  box(scene, rig, blade, { width: 0.2, height: 0.05, depth: 0.05 }, 0, 0, 0.04, limbMat);

  Object.assign(rig.joints, { legL, legR, chest, head, armL, armR, blade });
  return rig;
}

/** Hunched, long-armed, head forward of its shoulders, arms reaching. */
function buildZombieRig(scene: Scene): Rig {
  const archetype = getArchetype("zombie");
  const rig = newRig(scene, "zombie");
  const flesh = flatMaterial(scene, "zombieFlesh", archetype.colour);
  const dark = flatMaterial(scene, "zombieDark", hexColour(archetype.colour).scale(0.6));
  // The one bright note on the model, so a Risen is identifiable at distance.
  const eyes = flatMaterial(scene, "zombieEyes", 0xd8e85a);
  eyes.emissiveColor = hexColour(0x7a8a20);
  track(rig, flesh, dark, eyes);

  const hips = 0.66;
  const legL = joint(scene, "legL", rig.body, -0.16, hips, 0);
  const legR = joint(scene, "legR", rig.body, 0.16, hips, 0);
  box(scene, rig, legL, { width: 0.2, height: 0.66, depth: 0.2 }, 0, -0.33, 0, dark);
  box(scene, rig, legR, { width: 0.2, height: 0.66, depth: 0.2 }, 0, -0.33, 0, dark);

  const chest = joint(scene, "chest", rig.body, 0, hips, 0);
  box(scene, rig, chest, { width: 0.58, height: 0.72, depth: 0.36 }, 0, 0.36, 0, flesh);
  const head = joint(scene, "head", chest, 0, 0.74, 0.1);
  box(scene, rig, head, { width: 0.36, height: 0.36, depth: 0.36 }, 0, 0.14, 0.06, flesh);
  box(scene, rig, head, { width: 0.26, height: 0.07, depth: 0.05 }, 0, 0.18, 0.25, eyes);

  const armL = joint(scene, "armL", chest, -0.38, 0.62, 0.04);
  const armR = joint(scene, "armR", chest, 0.38, 0.62, 0.04);
  box(scene, rig, armL, { width: 0.16, height: 0.64, depth: 0.18 }, 0, -0.3, 0, dark);
  box(scene, rig, armR, { width: 0.16, height: 0.64, depth: 0.18 }, 0, -0.3, 0, dark);

  Object.assign(rig.joints, { legL, legR, chest, head, armL, armR });
  return rig;
}

/** Low, wide, eight-legged. Reads instantly from above, which is the angle the
 *  third-person camera mostly gives you. */
function buildSpiderRig(scene: Scene): Rig {
  const archetype = getArchetype("spider");
  const rig = newRig(scene, "spider");
  const shell = flatMaterial(scene, "spiderShell", archetype.colour);
  const dark = flatMaterial(scene, "spiderLeg", hexColour(archetype.colour).scale(0.55));
  const eyes = flatMaterial(scene, "spiderEyes", 0xd8506a);
  eyes.emissiveColor = hexColour(0x8a2038);
  track(rig, shell, dark, eyes);

  // The body pivots at its middle, so rearing up tips it backwards.
  const thorax = joint(scene, "thorax", rig.body, 0, 0.42, 0);
  const abdomen = facet(MeshBuilder.CreateSphere("abdomen", { diameter: 0.78, segments: 2 }, scene));
  abdomen.position.set(0, 0.02, -0.26);
  abdomen.scaling.set(1, 0.82, 1.15);
  abdomen.material = shell;
  abdomen.parent = thorax;
  rig.pickables.push(abdomen);

  const head = facet(MeshBuilder.CreateSphere("cephalothorax", { diameter: 0.5, segments: 2 }, scene));
  head.position.set(0, -0.02, 0.24);
  head.scaling.set(1, 0.8, 1);
  head.material = shell;
  head.parent = thorax;
  rig.pickables.push(head);
  box(scene, rig, thorax, { width: 0.22, height: 0.06, depth: 0.05 }, 0, 0.03, 0.45, eyes);

  // Four a side, splayed and angled down, each swinging from the shoulder.
  const spread = [0.85, 0.35, -0.2, -0.7];
  let index = 0;
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;
    for (const along of spread) {
      const pivot = joint(scene, `leg${index}`, thorax, sign * 0.2, 0, along * 0.5);
      pivot.rotation.z = sign * 0.75;
      pivot.rotation.y = -sign * along * 0.6;
      // Remember the rest pose; the gait oscillates around it.
      pivot.metadata = { restZ: pivot.rotation.z, restY: pivot.rotation.y, sign, index };
      box(scene, rig, pivot, { width: 0.09, height: 0.62, depth: 0.09 }, 0, -0.28, 0, dark);
      rig.joints[`leg${index}`] = pivot;
      index++;
    }
  }
  rig.joints["thorax"] = thorax;
  return rig;
}

export function buildEnemyRig(scene: Scene, kind: EnemyKind): Rig {
  return kind === "spider" ? buildSpiderRig(scene) : buildZombieRig(scene);
}

// --- animation -----------------------------------------------------------------

/** What a body is doing beyond moving. One at a time; a new one replaces the old. */
export type Action =
  | { type: "cast"; spell: SpellId; combo: number; start: number }
  | { type: "windup"; start: number; ms: number }
  | { type: "blow"; start: number };

const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const easeOut = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) * (1 - t));

/** Blend between keyed values at times (ms). Clamped at the ends. */
function keys(t: number, frames: ReadonlyArray<readonly [number, number]>): number {
  if (t <= frames[0]![0]) return frames[0]![1];
  for (let i = 1; i < frames.length; i++) {
    const [t1, v1] = frames[i]!;
    const [t0, v0] = frames[i - 1]!;
    if (t <= t1) return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0));
  }
  return frames[frames.length - 1]![1];
}

/** How long each cast's body motion lasts, in ms. Also how long the body
 *  faces the aim rather than the camera. */
export function castDuration(spell: SpellId, combo: number): number {
  if (spell === "sunder") return 520;
  if (spell === "voidbolt") return 360;
  return combo === 3 ? 440 : 330;
}

/** When the blow of a cast visibly connects, ms after it starts. */
export function castContact(spell: SpellId, combo: number): number {
  if (spell === "sunder") return 190;
  if (spell === "voidbolt") return 85;
  return combo === 3 ? 150 : 95;
}

/**
 * Drives one rig from what the simulation says: where it is, how fast it is
 * going, and the discrete things that happen to it.
 */
export class Animator {
  private phase = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private speed = 0;
  private action: Action | undefined;
  private flinchAt = -Infinity;
  private flinchPower = 0;
  private flashAt = -Infinity;
  private diedAt = -Infinity;
  private dead = false;
  private spawnAt = -Infinity;
  /** Hitstop: time freezes on this body for a moment when a blow lands. */
  private frozenUntil = -Infinity;
  private clock = 0;
  private lastNow = NaN;

  constructor(readonly rig: Rig) {}

  play(action: Action): void {
    this.action = action;
  }

  /** Cancel whatever it was winding up — it was staggered. */
  interrupt(): void {
    if (this.action?.type === "windup") this.action = undefined;
  }

  /** Is it mid-cast, and if so which way should it face? */
  casting(now: number): boolean {
    const action = this.action;
    return action?.type === "cast" && now - action.start < castDuration(action.spell, action.combo);
  }

  hit(now: number, power = 1): void {
    this.flinchAt = now;
    this.flinchPower = power;
    this.flashAt = now;
    this.frozenUntil = now + 55 * power;
  }

  die(now: number): void {
    if (this.dead) return;
    this.dead = true;
    this.diedAt = now;
    this.action = undefined;
  }

  /** Back up (a respawn) — rise out of the ground. */
  revive(now: number): void {
    this.dead = false;
    this.spawnAt = now;
    this.action = undefined;
  }

  /** Rise out of the ground on first appearance. */
  emerge(now: number): void {
    this.spawnAt = now;
  }

  get isDead(): boolean {
    return this.dead;
  }

  /**
   * Pose the rig for this frame.
   *
   * @param x,z The drawn position, to measure speed from.
   * @param sprinting Leans further forward.
   */
  update(now: number, x: number, z: number, sprinting = false): void {
    const realDt = Number.isNaN(this.lastNow) ? 0 : Math.min(0.1, (now - this.lastNow) / 1000);
    this.lastNow = now;
    // Hitstop freezes this body's own clock, not the world's.
    const dt = now < this.frozenUntil ? 0 : realDt;
    this.clock += dt * 1000;

    if (!Number.isNaN(this.lastX) && realDt > 0) {
      const moved = Math.hypot(x - this.lastX, z - this.lastZ) / realDt;
      // Smoothed, because interpolated positions arrive a little unevenly.
      this.speed += (Math.min(moved, 14) - this.speed) * Math.min(1, realDt * 10);
    }
    this.lastX = x;
    this.lastZ = z;
    this.phase += dt * this.speed * (this.rig.kind === "spider" ? 3.4 : 2.1);

    this.flash(now);

    switch (this.rig.kind) {
      case "player": this.posePlayer(now, sprinting); break;
      case "zombie": this.poseZombie(now); break;
      case "spider": this.poseSpider(now); break;
    }
  }

  private flash(now: number): void {
    const t = (now - this.flashAt) / 130;
    const rig = this.rig;
    const strength = t >= 0 && t < 1 ? (1 - t) * 0.85 : 0;
    for (let i = 0; i < rig.materials.length; i++) {
      const base = rig.baseEmissive[i]!;
      const material = rig.materials[i]!;
      material.emissiveColor.set(
        base.r + (1 - base.r) * strength,
        base.g + (1 - base.g) * strength,
        base.b + (1 - base.b) * strength,
      );
    }
  }

  /** Common: a flinch backward, and the fall or rise. Returns false if the
   *  body is down and the rest of the pose should be skipped. */
  private poseCommon(now: number, fallDirection: 1 | -1, fallAxis: "x" | "z"): boolean {
    const body = this.rig.body;
    body.position.set(0, 0, 0);
    body.rotation.set(0, 0, 0);

    if (this.dead) {
      const t = (now - this.diedAt) / 480;
      const fall = easeOut(t) * (Math.PI / 2) * fallDirection;
      if (fallAxis === "x") body.rotation.x = fall;
      else body.rotation.z = fall;
      // A little bounce as it lands, then after a while it sinks away.
      body.position.y = t > 0.8 && t < 1.2 ? Math.sin((t - 0.8) * Math.PI * 2.5) * 0.06 : 0;
      const sink = (now - this.diedAt - 4500) / 2500;
      if (sink > 0) body.position.y -= Math.min(1, sink) * 1.4;
      return false;
    }

    const rise = (now - this.spawnAt) / 650;
    if (rise < 1) body.position.y = -(1 - easeOut(rise)) * 1.6;

    const f = (now - this.flinchAt) / 220;
    if (f >= 0 && f < 1) {
      const kick = Math.sin(f * Math.PI) * 0.28 * this.flinchPower;
      body.rotation.x -= kick;
      body.position.z -= kick * 0.3;
    }
    return true;
  }

  private posePlayer(now: number, sprinting: boolean): void {
    const j = this.rig.joints;
    const legL = j["legL"]!, legR = j["legR"]!, chest = j["chest"]!;
    const armL = j["armL"]!, armR = j["armR"]!, head = j["head"]!;

    for (const node of [legL, legR, chest, armL, armR, head]) node.rotation.set(0, 0, 0);
    if (!this.poseCommon(now, -1, "x")) return;

    const stride = Math.min(1, this.speed / 6);
    const swing = Math.sin(this.phase) * 0.75 * stride;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.8;
    armR.rotation.x = swing * 0.5;
    this.rig.body.position.y += Math.abs(Math.cos(this.phase)) * 0.06 * stride;
    chest.rotation.x = stride * (sprinting ? 0.28 : 0.1) + Math.sin(this.clock / 500) * 0.02;

    const action = this.action;
    if (action?.type !== "cast") return;
    const t = now - action.start;
    if (t > castDuration(action.spell, action.combo)) {
      this.action = undefined;
      return;
    }

    if (action.spell === "strike" && action.combo !== 3) {
      // A flat slash across the body: wind the waist one way, whip it the
      // other. Alternate links swing opposite ways, so a chain reads as one.
      const dir = action.combo === 2 ? -1 : 1;
      chest.rotation.y = keys(t, [[0, 0], [60, 0.75 * dir], [130, -0.95 * dir], [330, 0]]);
      armR.rotation.x = keys(t, [[0, swing * 0.5], [60, -1.25], [130, -1.55], [330, 0]]);
      armR.rotation.z = keys(t, [[0, 0], [60, -0.5 * dir], [130, 0.35 * dir], [330, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [90, -0.5], [330, 0]]);
      legL.rotation.x = keys(t, [[0, swing], [100, -0.35], [330, 0]]);
    } else if (action.spell === "strike") {
      // The finisher: both hands overhead, lean back, bring it down.
      armR.rotation.x = keys(t, [[0, 0], [110, -2.95], [165, -0.65], [440, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [110, -2.7], [165, -0.8], [440, 0]]);
      chest.rotation.x = keys(t, [[0, 0], [110, -0.3], [165, 0.45], [440, 0]]);
      this.rig.body.position.y += keys(t, [[0, 0], [110, 0.12], [165, -0.1], [440, 0]]);
      legL.rotation.x = keys(t, [[0, 0], [165, -0.45], [440, 0]]);
      legR.rotation.x = keys(t, [[0, 0], [165, 0.35], [440, 0]]);
    } else if (action.spell === "voidbolt") {
      // Punch the arm straight out; the bolt leaves from the fist.
      armR.rotation.x = keys(t, [[0, 0], [80, -1.62], [220, -1.55], [360, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [80, -0.5], [360, 0]]);
      chest.rotation.y = keys(t, [[0, 0], [80, 0.35], [360, 0]]);
      chest.rotation.x = keys(t, [[0, 0], [80, -0.12], [360, 0]]);
    } else {
      // Sunder: hop, arms up, and slam both fists into the ground.
      armR.rotation.x = keys(t, [[0, 0], [140, -2.9], [200, -0.5], [520, 0]]);
      armL.rotation.x = keys(t, [[0, 0], [140, -2.9], [200, -0.5], [520, 0]]);
      chest.rotation.x = keys(t, [[0, 0], [140, -0.22], [200, 0.55], [520, 0]]);
      this.rig.body.position.y += keys(t, [[0, 0], [140, 0.28], [200, -0.16], [520, 0]]);
      legL.rotation.x = keys(t, [[0, 0], [200, -0.5], [520, 0]]);
      legR.rotation.x = keys(t, [[0, 0], [200, -0.5], [520, 0]]);
    }
  }

  private poseZombie(now: number): void {
    const j = this.rig.joints;
    const legL = j["legL"]!, legR = j["legR"]!, chest = j["chest"]!;
    const armL = j["armL"]!, armR = j["armR"]!, head = j["head"]!;

    for (const node of [legL, legR, chest, armL, armR, head]) node.rotation.set(0, 0, 0);
    if (!this.poseCommon(now, 1, "x")) return;

    // A shuffle: short stride, heavy sway, arms held out in front.
    const stride = Math.min(1, this.speed / 3);
    const swing = Math.sin(this.phase) * 0.5 * stride;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    this.rig.body.rotation.z = Math.sin(this.phase) * 0.09 * stride;
    const idle = Math.sin(this.clock / 700);
    chest.rotation.x = 0.24 + idle * 0.03;
    head.rotation.z = Math.sin(this.clock / 1100) * 0.12;
    armL.rotation.x = -1.35 + Math.sin(this.phase + 0.6) * 0.15 * stride + idle * 0.05;
    armR.rotation.x = -1.35 - Math.sin(this.phase + 0.6) * 0.15 * stride + idle * 0.05;

    const action = this.action;
    if (!action) return;
    const t = now - action.start;

    if (action.type === "windup") {
      // Arms climb overhead for the whole windup and it rears back: the
      // longer you have been watching it, the closer the blow.
      const p = easeOut(t / action.ms);
      armL.rotation.x = -1.35 + (-1.6) * p;
      armR.rotation.x = -1.35 + (-1.6) * p;
      chest.rotation.x = 0.24 - 0.42 * p;
      // A tremble in the last third says "now".
      if (p > 0.66) this.rig.body.position.x = Math.sin(now / 18) * 0.025;
      if (t >= action.ms) this.action = { type: "blow", start: action.start + action.ms };
    } else if (action.type === "blow") {
      armL.rotation.x = keys(t, [[0, -2.95], [90, -0.55], [420, -1.35]]);
      armR.rotation.x = keys(t, [[0, -2.95], [90, -0.55], [420, -1.35]]);
      chest.rotation.x = keys(t, [[0, -0.18], [90, 0.75], [420, 0.24]]);
      if (t > 420) this.action = undefined;
    }
  }

  private poseSpider(now: number): void {
    const j = this.rig.joints;
    const thorax = j["thorax"]!;
    thorax.rotation.set(0, 0, 0);
    thorax.position.set(0, 0.42, 0);

    const alive = this.poseCommon(now, 1, "z");
    if (!alive) {
      // Legs curl in as it dies.
      const curl = easeOut((now - this.diedAt) / 400);
      for (let i = 0; i < 8; i++) {
        const leg = j[`leg${i}`]!;
        const rest = leg.metadata as { restZ: number; restY: number; sign: number };
        leg.rotation.z = rest.restZ * (1 - curl) - rest.sign * 0.9 * curl;
      }
      return;
    }

    // Alternating tetrapod gait: legs 0,2 on one side move with 1,3 on the
    // other. Skitter even when still, so it never looks like a model.
    const stride = Math.min(1, this.speed / 5);
    const jitter = 0.05 + 0.25 * stride;
    for (let i = 0; i < 8; i++) {
      const leg = j[`leg${i}`]!;
      const rest = leg.metadata as { restZ: number; restY: number; sign: number; index: number };
      const offset = ((i % 4) + (i >= 4 ? 1 : 0)) % 2 === 0 ? 0 : Math.PI;
      const beat = this.phase + offset + (stride < 0.1 ? this.clock / 260 : 0);
      leg.rotation.z = rest.restZ + rest.sign * Math.max(0, Math.sin(beat)) * 0.35 * jitter * 2;
      leg.rotation.y = rest.restY + Math.cos(beat) * 0.32 * jitter;
    }
    thorax.position.y = 0.42 + Math.abs(Math.sin(this.phase * 2)) * 0.03 * stride;

    const action = this.action;
    if (!action) return;
    const t = now - action.start;
    if (action.type === "windup") {
      // Rear up on the back legs, front legs raised.
      const p = easeOut(t / action.ms);
      thorax.rotation.x = -0.5 * p;
      thorax.position.z = -0.18 * p;
      for (const i of [0, 4]) {
        const leg = j[`leg${i}`]!;
        const rest = leg.metadata as { restZ: number; sign: number };
        leg.rotation.z = rest.restZ + rest.sign * 0.9 * p;
      }
      if (t >= action.ms) this.action = { type: "blow", start: action.start + action.ms };
    } else if (action.type === "blow") {
      // Lunge.
      thorax.rotation.x = keys(t, [[0, -0.5], [70, 0.3], [260, 0]]);
      thorax.position.z = keys(t, [[0, -0.18], [70, 0.4], [260, 0]]);
      if (t > 260) this.action = undefined;
    }
  }
}
