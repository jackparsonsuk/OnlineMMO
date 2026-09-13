import { Vector3 } from "@babylonjs/core/Maths/math.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { Scene } from "@babylonjs/core/scene.js";
import {
  FISHING_BITE,
  FISHING_NONE,
  heightAt,
  waterAt,
  type Player,
  type TerrainSettings,
} from "@mmo/shared";
import type { Sound } from "./audio.js";
import type { Effects } from "./effects.js";
import { flatMaterial } from "./lowpoly.js";
import { CAST_RELEASE_MS, type Animator, type Rig } from "./rigs.js";
import { build, voxelMaterial, voxelMesh } from "./voxel.js";

/**
 * Everyone's line in the water: the bobber, the line from the rod's tip, the
 * plop, the ripples and the dip of a bite.
 *
 * All of it is drawn from `Player.fishing` and the bobber's position, which
 * the server replicates for everyone — your own line is drawn exactly like a
 * stranger's across the lake. It decides nothing: when a bite comes and what
 * was on it are the server's (see `OstraRoom.onFishHook`).
 */

/** How long the bobber is in the air, from leaving the rod to the water. */
const FLIGHT_MS = 420;
/** Segments in a line. Enough to sag; each is one thin box. */
const SEGMENTS = 7;
/** How often a waiting bobber rings the water, and a biting one. */
const RIPPLE_MS = 2600;
const BITE_RIPPLE_MS = 300;

interface Line {
  bobber: Mesh;
  segments: Mesh[];
  /** The water's surface under the bobber. */
  surface: number;
  castAt: number;
  landed: boolean;
  bitten: boolean;
  lastRipple: number;
}

export class Anglers {
  private readonly lines = new Map<string, Line>();
  private readonly lineMaterial: StandardMaterial;
  private readonly bobberMaterial: StandardMaterial;
  private readonly tip = new Vector3();
  private readonly from = new Vector3();
  private readonly to = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly terrain: TerrainSettings,
    private readonly effects: Effects,
    private readonly play: (sound: Sound, x: number, z: number, volume: number) => void,
  ) {
    this.lineMaterial = flatMaterial(scene, "fishingLine", 0xe8e2d0);
    // Line is thinner than a pixel from any distance; a little glow keeps it
    // from vanishing into the water behind it.
    this.lineMaterial.emissiveColor.set(0.45, 0.43, 0.38);
    this.bobberMaterial = voxelMaterial(scene, "bobber");
  }

  /**
   * One player, once per frame, after their rig has been posed. Turns a
   * fishing body to face its bobber, too, whatever the camera behind it does.
   */
  update(now: number, id: string, player: Player, rig: Rig, animator: Animator, mine: boolean): void {
    let line = this.lines.get(id);
    if (player.fishing === FISHING_NONE || player.health === 0) {
      if (line) {
        this.remove(id);
        this.play("reel", player.bobberX, player.bobberZ, mine ? 0.9 : 0.5);
      }
      return;
    }

    const bx = player.bobberX;
    const bz = player.bobberZ;
    if (!line) {
      line = this.create(bx, bz, animator.castStartedAt, now);
      this.lines.set(id, line);
      // A line already out when we first saw it (we arrived, or they did) is
      // simply there: no throw, no plop.
      if (now - line.castAt < 200) this.play("cast", bx, bz, mine ? 1 : 0.5);
    }

    rig.root.rotation.y = Math.atan2(bx - rig.root.position.x, bz - rig.root.position.z);
    const tipNode = rig.joints["rodTip"];
    if (!tipNode) return;
    worldPosition(tipNode, this.tip);

    const biting = player.fishing === FISHING_BITE;
    if (biting && !line.bitten) {
      line.bitten = true;
      this.play("bite", bx, bz, mine ? 1 : 0.45);
    }

    // Where the bobber is: on the rod until the throw lets go, then flying,
    // then sitting on the water, bobbing — or, with something on the hook,
    // pulled under in jerks.
    const flight = (now - line.castAt - CAST_RELEASE_MS) / FLIGHT_MS;
    const bob = line.bobber.position;
    if (flight < 0) {
      bob.copyFrom(this.tip);
    } else if (flight < 1) {
      this.to.set(bx, line.surface, bz);
      Vector3.LerpToRef(this.tip, this.to, flight, bob);
      bob.y += Math.sin(flight * Math.PI) * 1.6;
    } else {
      if (!line.landed) {
        line.landed = true;
        line.lastRipple = now;
        this.play("plop", bx, bz, mine ? 0.9 : 0.4);
        this.ripple(now, bx, line.surface, bz, 0.9);
      }
      if (biting) {
        const jerk = Math.max(0, Math.sin(now / 55));
        bob.set(bx + Math.sin(now / 37) * 0.04, line.surface - 0.08 - jerk * 0.12, bz + Math.cos(now / 41) * 0.04);
      } else {
        bob.set(bx, line.surface + 0.02 + Math.sin(now / 600) * 0.025, bz);
      }
      if (now - line.lastRipple > (biting ? BITE_RIPPLE_MS : RIPPLE_MS)) {
        line.lastRipple = now;
        this.ripple(now, bx, line.surface, bz, biting ? 1.2 : 0.7);
      }
    }

    // The line: tip to bobber, sagging in the middle while it waits and
    // drawn tight when something pulls.
    const length = Vector3.Distance(this.tip, bob);
    const sag = flight < 1 ? 0.05 : biting ? 0.03 : 0.12 + length * 0.035;
    this.from.copyFrom(this.tip);
    for (let i = 0; i < SEGMENTS; i++) {
      const s = (i + 1) / SEGMENTS;
      Vector3.LerpToRef(this.tip, bob, s, this.to);
      this.to.y -= sag * 4 * s * (1 - s);
      span(line.segments[i]!, this.from, this.to);
      this.from.copyFrom(this.to);
    }
  }

  /** A player gone from the room: their line goes with them. */
  remove(id: string): void {
    const line = this.lines.get(id);
    if (!line) return;
    line.bobber.dispose();
    for (const segment of line.segments) segment.dispose();
    this.lines.delete(id);
  }

  dispose(): void {
    for (const id of [...this.lines.keys()]) this.remove(id);
    this.lineMaterial.dispose();
    this.bobberMaterial.dispose();
  }

  private create(bx: number, bz: number, castStartedAt: number, now: number): Line {
    const bobber = voxelMesh(this.scene, "bobber", BOBBER, "centre");
    bobber.material = this.bobberMaterial;
    bobber.isPickable = false;
    const segments: Mesh[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const segment = MeshBuilder.CreateBox("fishingLine", { size: 1 }, this.scene);
      segment.material = this.lineMaterial;
      segment.isPickable = false;
      segments.push(segment);
    }
    const surface = waterAt(this.terrain, bx, bz)?.surface ?? heightAt(bx, bz, this.terrain);
    // The rig saw the cast begin this frame or earlier; anything older than a
    // full throw is a line that was already out.
    const castAt = Number.isFinite(castStartedAt) && now - castStartedAt < CAST_RELEASE_MS + FLIGHT_MS
      ? castStartedAt
      : now - CAST_RELEASE_MS - FLIGHT_MS;
    return { bobber, segments, surface, castAt, landed: castAt !== castStartedAt, bitten: false, lastRipple: now };
  }

  private ripple(now: number, x: number, surface: number, z: number, radius: number): void {
    // The shockwave sits 12 cm above what it is given, for the ground.
    this.effects.shockwave(now, x, surface - 0.1, z, radius, 0xd8eef8, 0);
  }
}

/** A red-capped bobber, 16 cm tall. */
const BOBBER = build(4, 5, 4, (v) => {
  v.fill(0, 0, 0, 4, 2, 4, 0xf2efe6);
  v.fill(0, 2, 0, 4, 2, 4, 0xc8352a);
  v.fill(1, 4, 1, 2, 1, 2, 0x2a2622);
  v.clear(0, 0, 0, 1, 5, 1);
  v.clear(3, 0, 0, 1, 5, 1);
  v.clear(0, 0, 3, 1, 5, 1);
  v.clear(3, 0, 3, 1, 5, 1);
});

/** Stretch a unit box from `a` to `b`, as a length of line. */
function span(segment: Mesh, a: Vector3, b: Vector3): void {
  const length = Vector3.Distance(a, b);
  Vector3.CenterToRef(a, b, segment.position);
  segment.scaling.set(0.012, 0.012, Math.max(0.001, length));
  segment.lookAt(b);
}

const chain: TransformNode[] = [];

/** Where a joint is this frame. Its pose was set this frame, after the last
 *  render computed world matrices, so the chain is recomputed root first. */
function worldPosition(node: TransformNode, out: Vector3): void {
  chain.length = 0;
  for (let n: TransformNode | null = node; n; n = n.parent as TransformNode | null) chain.push(n);
  for (let i = chain.length - 1; i >= 0; i--) chain[i]!.computeWorldMatrix(true);
  Vector3.TransformCoordinatesToRef(Vector3.ZeroReadOnly, node.getWorldMatrix(), out);
}
