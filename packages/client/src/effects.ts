import { Color3, Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { hexColour } from "./lowpoly.js";

/**
 * Everything that flashes, flies or fades in a fight.
 *
 * None of this decides anything. The server resolves every hit; these only
 * make the resolution legible — and fast: the local player's own impacts are
 * drawn at the moment the blade connects, predicted from the same shape test
 * the server runs, rather than a round trip later when the server agrees.
 *
 * Built for churn. A busy fight spawns dozens of effects a second, so meshes
 * are pooled and shards are thin instances rewritten each frame: nothing is
 * allocated per hit.
 */

function glow(scene: Scene, name: string, colour: Color3, alpha: number): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = colour;
  material.alpha = alpha;
  material.backFaceCulling = false;
  material.disableLighting = true;
  return material;
}

/** A flat ring sector in the XZ plane, centred on +Z, as raw geometry. Used for
 *  slashes (wide) and shockwaves (full circle). */
function ringSector(scene: Scene, name: string, inner: number, outer: number, arc: number, segments: number): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = -arc / 2 + arc * t;
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    positions.push(s * inner, 0, c * inner, s * outer, 0, c * outer);
    uvs.push(t, 0, t, 1);
    if (i < segments) {
      const k = i * 2;
      indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh);
  mesh.isPickable = false;
  return mesh;
}

interface Timed {
  node: TransformNode;
  start: number;
  duration: number;
  update(t: number): void;
  done(): void;
}

/** Tiny faceted shards, thrown out of every hit. */
class ShardPool {
  private readonly mesh: Mesh;
  private readonly matrices: Float32Array;
  private readonly particles: Array<{
    x: number; y: number; z: number; vx: number; vy: number; vz: number;
    life: number; age: number; size: number; spin: number;
  }> = [];
  private readonly scratch = new Matrix();
  private readonly rotation = new Quaternion();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();

  constructor(scene: Scene, name: string, colour: Color3, private readonly capacity = 160) {
    this.mesh = MeshBuilder.CreatePolyhedron(name, { type: 0, size: 0.07 }, scene);
    const material = new StandardMaterial(`${name}Material`, scene);
    material.diffuseColor = colour.scale(0.5);
    material.emissiveColor = colour.scale(0.7);
    material.specularColor = Color3.Black();
    this.mesh.material = material;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.matrices = new Float32Array(capacity * 16);
    this.mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    this.mesh.thinInstanceCount = 0;
  }

  burst(x: number, y: number, z: number, count: number, dirX: number, dirZ: number, force: number): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.capacity) this.particles.shift();
      const spread = (Math.random() - 0.5) * 2.2;
      const s = Math.sin(spread);
      const c = Math.cos(spread);
      // Mostly along the blow, fanned out, and up.
      const fx = dirX * c - dirZ * s;
      const fz = dirX * s + dirZ * c;
      const speed = force * (0.5 + Math.random());
      this.particles.push({
        x, y, z,
        vx: fx * speed + (Math.random() - 0.5) * 1.5,
        vy: 2 + Math.random() * 3.5 * force * 0.5,
        vz: fz * speed + (Math.random() - 0.5) * 1.5,
        life: 0.35 + Math.random() * 0.35,
        age: 0,
        size: 0.6 + Math.random() * 1.1,
        spin: Math.random() * 6,
      });
    }
  }

  update(dt: number): void {
    let n = 0;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.age += dt;
      if (p.age >= p.life) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy -= 14 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const shrink = p.size * (1 - p.age / p.life);
      this.scale.set(shrink, shrink, shrink);
      this.position.set(p.x, p.y, p.z);
      Quaternion.RotationYawPitchRollToRef(p.spin + p.age * 9, p.age * 7, 0, this.rotation);
      Matrix.ComposeToRef(this.scale, this.rotation, this.position, this.scratch);
      this.scratch.copyToArray(this.matrices, n * 16);
      n++;
    }
    this.mesh.thinInstanceCount = n;
    if (n > 0) this.mesh.thinInstanceBufferUpdated("matrix");
  }

  dispose(): void {
    this.mesh.dispose(false, true);
  }
}

export type ShardColour = "spark" | "ichor" | "void" | "blood" | "arcane" | "dust" | "ember" | "stone" | "bile" | "fur";

const SHARD_COLOURS: Record<ShardColour, number> = {
  spark: 0xfff1c2,
  ichor: 0xb8c25a,
  void: 0x8a5ad8,
  blood: 0xd8453a,
  arcane: 0xb48cff,
  dust: 0x9c8a66,
  ember: 0xff8a3a,
  stone: 0xa39d8c,
  bile: 0x9ad04a,
  fur: 0x8a8c92,
};

/** A telegraph: the ground an enemy's blow is about to cover. */
interface Telegraph {
  root: TransformNode;
  outline: Mesh;
  fill: Mesh;
  outlineMaterial: StandardMaterial;
  fillMaterial: StandardMaterial;
  start: number;
  ms: number;
  arc: number;
  busy: boolean;
}

export class Effects {
  private readonly timed: Timed[] = [];
  private readonly shards: Record<ShardColour, ShardPool>;
  private readonly slashMaterial: StandardMaterial;
  private readonly heavyMaterial: StandardMaterial;
  private readonly telegraphs: Telegraph[] = [];
  private readonly targetRing: Mesh;
  private readonly targetMaterial: StandardMaterial;
  private lastNow = NaN;

  constructor(private readonly scene: Scene) {
    this.shards = Object.fromEntries(
      (Object.keys(SHARD_COLOURS) as ShardColour[]).map((key) => [
        key, new ShardPool(scene, `shard:${key}`, hexColour(SHARD_COLOURS[key])),
      ]),
    ) as Record<ShardColour, ShardPool>;

    this.slashMaterial = glow(scene, "slash", hexColour(0xdcefff), 0.8);
    this.heavyMaterial = glow(scene, "slashHeavy", hexColour(0xffd08a), 0.9);

    this.targetMaterial = glow(scene, "targetRing", hexColour(0xff5a44), 0.75);
    this.targetRing = MeshBuilder.CreateTorus("targetRing", { diameter: 2, thickness: 0.07, tessellation: 24 }, scene);
    this.targetRing.material = this.targetMaterial;
    this.targetRing.isPickable = false;
    this.targetRing.setEnabled(false);
  }

  /** Advance everything. Call once per frame, before rendering. */
  update(now: number): void {
    const dt = Number.isNaN(this.lastNow) ? 0 : Math.min(0.05, (now - this.lastNow) / 1000);
    this.lastNow = now;

    for (let i = this.timed.length - 1; i >= 0; i--) {
      const effect = this.timed[i]!;
      const t = (now - effect.start) / effect.duration;
      if (t >= 1) {
        effect.done();
        this.timed.splice(i, 1);
        continue;
      }
      effect.update(Math.max(0, t));
    }

    for (const pool of Object.values(this.shards)) pool.update(dt);

    for (const telegraph of this.telegraphs) {
      if (!telegraph.busy) continue;
      const t = (now - telegraph.start) / telegraph.ms;
      if (t >= 1.25) {
        telegraph.busy = false;
        telegraph.root.setEnabled(false);
        continue;
      }
      // The fill creeps out to the edge over the windup — when it touches the
      // outline, the blow lands.
      const fill = Math.min(1, Math.max(0.02, t));
      telegraph.fill.scaling.set(fill, 1, fill);
      const flash = t >= 1 ? 1 - (t - 1) / 0.25 : 0;
      telegraph.fillMaterial.alpha = t < 1 ? 0.22 + 0.2 * t : 0.55 * flash;
      telegraph.outlineMaterial.alpha = t < 1 ? 0.16 : 0.3 * flash;
    }
  }

  private add(effect: Timed): void {
    this.timed.push(effect);
    effect.update(0);
  }

  /**
   * A blade stroke: a bright crescent at chest height, sweeping the way the
   * swing goes and fading fast.
   *
   * @param direction 1 or -1: which way across the body. The finisher is a
   *   vertical stroke instead.
   */
  slash(now: number, x: number, y: number, z: number, yaw: number, reach: number, direction: number, heavy: boolean): void {
    const node = new TransformNode("slashPivot", this.scene);
    node.position.set(x, y + (heavy ? 0.7 : 0.75), z);
    node.rotation.y = yaw;
    const arc = heavy ? 1.7 : 2.3;
    const mesh = ringSector(this.scene, "slash", reach * 0.35, reach + 0.15, arc, 14);
    mesh.material = heavy ? this.heavyMaterial.clone("slashHeavyI") : this.slashMaterial.clone("slashI");
    mesh.parent = node;
    if (heavy) {
      // Overhead: stand the crescent up so it cuts down in front.
      mesh.rotation.z = Math.PI / 2;
      mesh.rotation.y = 0;
      mesh.position.y = 0.2;
    } else {
      // Tilt the plane so the stroke runs high-to-low across the body.
      mesh.rotation.z = 0.35 * direction;
    }
    const material = mesh.material as StandardMaterial;
    this.add({
      node,
      start: now,
      duration: heavy ? 240 : 170,
      update: (t) => {
        // Sweep: spin the crescent through a little of its arc as it fades.
        mesh.rotation.y = heavy ? 0 : (0.5 - t) * 0.9 * direction;
        if (heavy) mesh.rotation.x = -0.4 + t * 1.1;
        const s = 0.85 + t * 0.25;
        mesh.scaling.set(s, 1, s);
        material.alpha = (heavy ? 0.9 : 0.75) * (1 - t) * (1 - t);
      },
      done: () => {
        material.dispose();
        node.dispose(false, false);
      },
    });
  }

  /** A burst of shards where something was hit. */
  impact(x: number, y: number, z: number, dirX: number, dirZ: number, colour: ShardColour, heavy: boolean): void {
    this.shards[colour].burst(x, y, z, heavy ? 16 : 9, dirX, dirZ, heavy ? 6 : 4);
    this.shards.spark.burst(x, y, z, heavy ? 6 : 3, dirX, dirZ, heavy ? 7 : 5);
  }

  /** Rubble kicked up around a point. */
  dust(x: number, y: number, z: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      this.shards.dust.burst(x + Math.sin(a) * 0.6, y + 0.1, z + Math.cos(a) * 0.6, 1, Math.sin(a), Math.cos(a), 5);
    }
  }

  /** A ring rushing outward along the ground: a slam, a leap's landing, a shout. */
  shockwave(now: number, x: number, y: number, z: number, radius: number, colour = 0xffb066, dust = 18): void {
    const node = new TransformNode("shockPivot", this.scene);
    node.position.set(x, y + 0.12, z);
    const ring = ringSector(this.scene, "shock", 0.8, 1, Math.PI * 2, 40);
    const material = glow(this.scene, "shockI", hexColour(colour), 0.8);
    ring.material = material;
    ring.parent = node;
    this.dust(x, y, z, dust);
    this.add({
      node,
      start: now,
      duration: 330,
      update: (t) => {
        const r = 0.6 + (radius - 0.6) * (1 - (1 - t) * (1 - t));
        ring.scaling.set(r, 1, r);
        material.alpha = 0.85 * (1 - t);
      },
      done: () => {
        material.dispose();
        node.dispose(false, false);
      },
    });
  }

  /**
   * Something in flight: a thrown weapon, by default a bolt of light. Drawn
   * from the hand to wherever it is going; the damage was already decided —
   * this is how you see where.
   */
  bolt(
    now: number, from: Vector3, to: Vector3, onArrive: () => void,
    colour = 0xc4a2ff, speed = 60, trail: ShardColour = "arcane",
  ): void {
    const distance = Vector3.Distance(from, to);
    const duration = Math.max(60, (distance / speed) * 1000);
    const node = new TransformNode("bolt", this.scene);
    const core = MeshBuilder.CreatePolyhedron("boltCore", { type: 1, size: 0.18 }, this.scene);
    const material = glow(this.scene, "boltI", hexColour(colour), 1);
    core.material = material;
    core.parent = node;
    core.scaling.set(0.8, 0.8, 2.4);
    node.lookAt(to.subtract(from).add(node.position));
    let lastTrail = 0;
    this.add({
      node,
      start: now,
      duration,
      update: (t) => {
        Vector3.LerpToRef(from, to, t, node.position);
        node.lookAt(to);
        core.rotation.z = t * 20;
        if (t - lastTrail > 0.12) {
          lastTrail = t;
          this.shards[trail].burst(node.position.x, node.position.y, node.position.z, 1, 0, 0, 0.5);
        }
      },
      done: () => {
        material.dispose();
        node.dispose(false, false);
        onArrive();
      },
    });
  }

  /**
   * Paint where a creature's blow will land. `arc` and `reach` are the exact
   * numbers the server tests, so stepping out of the red is stepping out of
   * the hit.
   */
  telegraph(now: number, x: number, y: number, z: number, yaw: number, reach: number, arc: number, ms: number): void {
    let telegraph = this.telegraphs.find((candidate) => !candidate.busy && candidate.arc === arc);
    if (!telegraph) telegraph = this.makeTelegraph(arc);
    telegraph.busy = true;
    telegraph.start = now;
    telegraph.ms = ms;
    telegraph.root.setEnabled(true);
    telegraph.root.position.set(x, y + 0.09, z);
    telegraph.root.rotation.y = yaw;
    telegraph.root.scaling.set(reach, 1, reach);
    telegraph.fill.scaling.set(0.02, 1, 0.02);
  }

  /** A telegraph for this creature was interrupted: drop it at once. */
  cancelTelegraphNear(x: number, z: number): void {
    for (const telegraph of this.telegraphs) {
      if (!telegraph.busy) continue;
      const p = telegraph.root.position;
      if (Math.hypot(p.x - x, p.z - z) < 1.2) {
        telegraph.busy = false;
        telegraph.root.setEnabled(false);
      }
    }
  }

  private makeTelegraph(arc: number): Telegraph {
    const root = new TransformNode("telegraph", this.scene);
    const outlineMaterial = glow(this.scene, "telegraphOutline", hexColour(0xff3b2a), 0.16);
    const fillMaterial = glow(this.scene, "telegraphFill", hexColour(0xff5a3a), 0.25);
    // Unit radius; the root is scaled to the creature's reach.
    const outline = ringSector(this.scene, "telegraphOutline", 0, 1, arc, 18);
    outline.material = outlineMaterial;
    outline.parent = root;
    const fill = ringSector(this.scene, "telegraphFill", 0, 1, arc, 18);
    fill.material = fillMaterial;
    fill.parent = root;
    fill.position.y = 0.01;
    const telegraph: Telegraph = {
      root, outline, fill, outlineMaterial, fillMaterial, start: 0, ms: 1, arc, busy: false,
    };
    this.telegraphs.push(telegraph);
    return telegraph;
  }

  /** Show the selection ring under a target, or hide it. */
  showTarget(now: number, x: number, y: number, z: number, radius: number, hunting: boolean): void {
    this.targetRing.setEnabled(true);
    this.targetRing.position.set(x, y + 0.08, z);
    const pulse = 1 + Math.sin(now / 180) * 0.04;
    this.targetRing.scaling.set(radius * pulse, 1, radius * pulse);
    this.targetRing.rotation.y = now / 900;
    this.targetMaterial.emissiveColor = hunting ? hexColour(0xff5a44) : hexColour(0xffc46b);
  }

  hideTarget(): void {
    this.targetRing.setEnabled(false);
  }

  dispose(): void {
    for (const effect of this.timed) effect.done();
    this.timed.length = 0;
    for (const pool of Object.values(this.shards)) pool.dispose();
    for (const telegraph of this.telegraphs) telegraph.root.dispose(false, true);
    this.telegraphs.length = 0;
    this.targetRing.dispose(false, true);
    this.slashMaterial.dispose();
    this.heavyMaterial.dispose();
  }
}
