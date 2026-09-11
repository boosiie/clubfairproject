/**
 * world.js - the walkable 3D park.
 *
 * A boulevard with twelve plots, six a side. You walk an avatar down it, stand
 * on a plot, type what belongs there, and it drops in. The park never resets.
 *
 * Deliberately not a physics engine. Exhibits fall in, bounce, and then stand
 * still forever; the only moving thing is you. That is what a booth wants - a
 * tumbling pile is impressive for ten minutes and then it is a heap of debris
 * nobody can walk through, and every physics bug is one nobody is there to fix.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fitStructure, structureBounds, STRUCTURE_MAX } from './spec.js';

export const PLOT_COUNT = 12;
/** Plots per side of the boulevard. */
const PER_SIDE = PLOT_COUNT / 2;
const PLOT_SIZE = 9;
const PLOT_GAP = 2;
const PLOT_PITCH = PLOT_SIZE + PLOT_GAP;
/** Half-width of the walkway between the two rows. */
const ROAD_HALF = 4.5;
const PLOT_CENTRE_X = ROAD_HALF + PLOT_SIZE / 2;

/** Exhibits per plot before the oldest one fades out. */
const PLOT_CAPACITY = 3;
const DROP_HEIGHT = 9;
const GRAVITY = 26;
const FADE_SECONDS = 0.9;
const HIGHLIGHT_SECONDS = 6;

const WALK_SPEED = 5.2;
const RUN_SPEED = 9;
const JUMP_SPEED = 8.4;
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.8;
const EYE_TURN_RATE = 9;

/**
 * Camera rig. The pitch is the whole feel of the thing: height/distance here is
 * about 15 degrees down, which reads as standing behind someone. Raise the
 * height much past this and it turns into an isometric strategy game looking
 * down at a doll.
 */
const CAMERA_DISTANCE = 10;
const CAMERA_HEIGHT = 2.7;

const GROUND_COLOR = 0x5ea45f;
const ROAD_COLOR = 0x8d8a7e;
const PAD_COLOR = 0x76b871;
const KERB_COLOR = 0xc3cf9a;
const SKY_COLOR = 0x9fd0ef;

export class World {
  constructor(container, options = {}) {
    this.container = container;
    this.onPlotChange = options.onPlotChange ?? (() => {});

    this.exhibits = [];
    this.totalBuilt = 0;
    this.currentPlot = -1;
    this.clock = new THREE.Clock();
    this.input = { forward: 0, strafe: 0, run: false, jump: false };
    this.cameraYaw = 0;
    this.orbit = 0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_COLOR);
    this.scene.fog = new THREE.Fog(SKY_COLOR, 80, 190);

    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 400);
    this.cameraTarget = new THREE.Vector3();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.buildLighting();
    this.buildGround();
    this.buildPlots();
    this.buildPlayer();

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.renderer.setAnimationLoop(() => this.frame());
  }

  /* ---------- scene ---------- */

  buildLighting() {
    const sky = new THREE.HemisphereLight(SKY_COLOR, GROUND_COLOR, 1.5);
    this.scene.add(sky);

    const sun = new THREE.DirectionalLight(0xfff6e6, 1.6);
    sun.position.set(24, 38, 18);
    sun.castShadow = true;
    // 1024 is plenty at this art style and keeps a school laptop with integrated
    // graphics comfortably at 60fps.
    sun.shadow.mapSize.set(1024, 1024);
    // The shadow camera has to cover the whole boulevard or exhibits at the far
    // end lose their shadows and look pasted on.
    const span = (PER_SIDE * PLOT_PITCH) / 2 + 14;
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 120 });
    sun.shadow.bias = -0.0015;
    this.scene.add(sun);
    this.scene.add(sun.target);
  }

  buildGround() {
    const length = PER_SIDE * PLOT_PITCH + 30;

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220),
      new THREE.MeshLambertMaterial({ color: GROUND_COLOR }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.receiveShadow = true;
    this.scene.add(grass);

    const road = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_HALF * 2, 0.08, length),
      new THREE.MeshLambertMaterial({ color: ROAD_COLOR }),
    );
    road.position.y = 0.04;
    road.receiveShadow = true;
    this.scene.add(road);
  }

  /** Where the centre of a plot sits in world space. */
  plotPosition(index) {
    const side = index % 2 === 0 ? -1 : 1;
    const row = Math.floor(index / 2);
    const z = (row - (PER_SIDE - 1) / 2) * PLOT_PITCH;
    return new THREE.Vector3(side * PLOT_CENTRE_X, 0, z);
  }

  buildPlots() {
    this.plotMarkers = [];

    for (let i = 0; i < PLOT_COUNT; i++) {
      const at = this.plotPosition(i);

      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(PLOT_SIZE, 0.16, PLOT_SIZE),
        new THREE.MeshLambertMaterial({ color: PAD_COLOR }),
      );
      pad.position.set(at.x, 0.08, at.z);
      pad.receiveShadow = true;
      this.scene.add(pad);

      // A kerb makes the plot read as a distinct lot from across the park, and
      // is low enough to walk over without a jump.
      const kerb = new THREE.Mesh(
        new THREE.BoxGeometry(PLOT_SIZE + 0.5, 0.3, PLOT_SIZE + 0.5),
        new THREE.MeshLambertMaterial({ color: KERB_COLOR }),
      );
      kerb.position.set(at.x, 0.12, at.z);
      this.scene.add(kerb);
      pad.position.y = 0.28;

      const sign = this.makeSign(i + 1);
      sign.position.set(
        at.x - (i % 2 === 0 ? -1 : 1) * (PLOT_SIZE / 2 + 0.4),
        2.1,
        at.z - PLOT_SIZE / 2 - 0.4,
      );
      this.scene.add(sign);

      // The highlight ring shows which plot you are standing in.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(PLOT_SIZE * 0.545, PLOT_SIZE * 0.565, 4),
        new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.rotation.z = Math.PI / 4;
      ring.position.set(at.x, 0.4, at.z);
      ring.visible = false;
      this.scene.add(ring);
      this.plotMarkers.push({ ring, sign });
    }
  }

  /** A numbered post, so you can tell where you are without reading the HUD. */
  makeSign(number) {
    const group = new THREE.Group();

    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 2.1, 8),
      new THREE.MeshLambertMaterial({ color: 0x6b5b45 }),
    );
    post.position.y = -0.55;
    post.castShadow = true;
    group.add(post);

    const board = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.68, 0.09),
      new THREE.MeshBasicMaterial({ map: makeTextTexture(String(number), '#12151f', '#ffd23f') }),
    );
    board.position.y = 0.55;
    group.add(board);

    return group;
  }

  buildPlayer() {
    // Spawn in the middle of the boulevard looking down it, with plots within a
    // few steps either side. Spawning at the far end means the first thing a
    // passer-by does is walk forty metres before anything happens.
    this.player = new THREE.Group();
    this.player.position.set(0, 0, -6);
    this.scene.add(this.player);

    this.velocityY = 0;
    this.grounded = true;
    this.facing = Math.PI;

    // A placeholder body so the booth works the instant the page opens, even
    // before the model has loaded - and forever, if the file is missing.
    this.placeholder = makeBlockAvatar();
    this.player.add(this.placeholder);

    new GLTFLoader().load(
      '/models/RobotExpressive.glb',
      (gltf) => this.adoptAvatar(gltf),
      undefined,
      () => {
        // No model: the block avatar stays. Nothing else changes.
        console.warn('[world] avatar model unavailable - using the built-in blocky one');
      },
    );
  }

  adoptAvatar(gltf) {
    const model = gltf.scene;
    model.scale.setScalar(0.42);
    model.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.frustumCulled = false;
      }
    });

    this.player.remove(this.placeholder);
    this.player.add(model);
    this.avatar = model;

    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    for (const clip of gltf.animations) {
      this.actions[clip.name] = this.mixer.clipAction(clip);
    }
    this.playClip('Idle');
  }

  playClip(name) {
    if (!this.actions || this.currentClip === name) return;
    const next = this.actions[name];
    if (!next) return;

    const previous = this.actions[this.currentClip];
    this.currentClip = name;
    next.reset().fadeIn(0.18).play();
    if (previous) previous.fadeOut(0.18);
  }

  /* ---------- building ---------- */

  plotAt(position = this.player.position) {
    for (let i = 0; i < PLOT_COUNT; i++) {
      const at = this.plotPosition(i);
      const half = PLOT_SIZE / 2 + 0.6;
      if (Math.abs(position.x - at.x) <= half && Math.abs(position.z - at.z) <= half) return i;
    }
    return -1;
  }

  contentsOf(index) {
    return this.exhibits.filter((e) => e.plot === index && !e.removing);
  }

  /**
   * Build a structure in a plot. It appears above and drops in.
   *
   * @param {object} structure - already through normalizeStructure()
   * @param {number} plotIndex
   */
  build(structure, plotIndex) {
    if (plotIndex < 0 || plotIndex >= PLOT_COUNT) return null;

    const fitted = fitStructure(structure, STRUCTURE_MAX);
    const bounds = structureBounds(fitted);
    const at = this.plotPosition(plotIndex);

    const group = new THREE.Group();
    for (const part of fitted.parts) {
      const mesh = new THREE.Mesh(geometryFor(part), new THREE.MeshLambertMaterial({ color: part.color }));
      mesh.position.set(part.offsetX, part.offsetY, part.offsetZ);
      mesh.rotation.set(part.rotationX, part.rotationY, part.rotationZ);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    // Spread repeat builds around the plot instead of stacking them on one spot.
    const taken = this.contentsOf(plotIndex).length;
    const spread = PLOT_SIZE * 0.27;
    const nudge = [[0, 0], [-spread, spread], [spread, -spread], [spread, spread]][taken % 4];

    group.position.set(at.x + nudge[0], DROP_HEIGHT, at.z + nudge[1]);
    group.rotation.y = Math.random() * Math.PI * 2;
    this.scene.add(group);

    const exhibit = {
      group,
      label: fitted.label,
      plot: plotIndex,
      bounciness: fitted.bounciness,
      // The world-space box, used for walking into things. Recomputed when it
      // lands, since the drop changes its height.
      halfWidth: bounds.width / 2,
      halfDepth: bounds.depth / 2,
      restY: 0,
      velocityY: 0,
      landed: false,
      bounces: 0,
      born: this.clock.elapsedTime,
      removing: false,
    };

    this.exhibits.push(exhibit);
    this.totalBuilt += 1;
    this.cullPlot(plotIndex);

    return exhibit;
  }

  /** Keep each plot legible: past its capacity, the oldest exhibit fades out. */
  cullPlot(index) {
    const live = this.contentsOf(index);
    for (let i = 0; i < live.length - PLOT_CAPACITY; i++) {
      live[i].removing = true;
      live[i].removeAt = this.clock.elapsedTime + FADE_SECONDS;
      live[i].group.traverse((node) => {
        if (node.isMesh) {
          node.material = node.material.clone();
          node.material.transparent = true;
        }
      });
    }
  }

  /* ---------- per-frame ---------- */

  frame() {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const now = this.clock.elapsedTime;

    this.stepExhibits(delta, now);
    this.stepPlayer(delta);
    this.stepCamera(delta);
    if (this.mixer) this.mixer.update(delta);

    const plot = this.plotAt();
    if (plot !== this.currentPlot) {
      if (this.currentPlot >= 0) this.plotMarkers[this.currentPlot].ring.visible = false;
      if (plot >= 0) this.plotMarkers[plot].ring.visible = true;
      this.currentPlot = plot;
      this.onPlotChange(plot);
    }

    this.renderer.render(this.scene, this.camera);
  }

  stepExhibits(delta, now) {
    for (let i = this.exhibits.length - 1; i >= 0; i--) {
      const exhibit = this.exhibits[i];

      if (!exhibit.landed) {
        exhibit.velocityY -= GRAVITY * delta;
        exhibit.group.position.y += exhibit.velocityY * delta;

        if (exhibit.group.position.y <= exhibit.restY) {
          exhibit.group.position.y = exhibit.restY;
          // A couple of damped bounces, scaled by the material. It is not
          // physics, it is the two seconds of physics anyone actually watches.
          const bounce = -exhibit.velocityY * exhibit.bounciness * 0.55;
          if (exhibit.bounces < 3 && bounce > 1.2) {
            exhibit.velocityY = bounce;
            exhibit.bounces += 1;
          } else {
            exhibit.landed = true;
            exhibit.velocityY = 0;
          }
        }
      }

      if (exhibit.removing) {
        const remaining = Math.max(0, exhibit.removeAt - now);
        const opacity = remaining / FADE_SECONDS;
        exhibit.group.traverse((node) => {
          if (node.isMesh) node.material.opacity = opacity;
        });
        if (remaining <= 0) {
          disposeGroup(exhibit.group);
          this.scene.remove(exhibit.group);
          this.exhibits.splice(i, 1);
        }
      }

      if (exhibit.ring) {
        const age = now - exhibit.born;
        if (age > HIGHLIGHT_SECONDS) {
          exhibit.group.remove(exhibit.ring);
          exhibit.ring = null;
        }
      }
    }
  }

  stepPlayer(delta) {
    const { input } = this;
    const moving = input.forward !== 0 || input.strafe !== 0;
    const speed = input.run ? RUN_SPEED : WALK_SPEED;

    if (moving) {
      // Movement is relative to where the camera is looking, which is what
      // everyone expects from a third-person game and needs no mouse at all.
      const angle = Math.atan2(input.strafe, input.forward) + this.cameraYaw;
      const step = speed * delta;
      const next = this.player.position.clone();
      next.x += Math.sin(angle) * step;
      next.z += Math.cos(angle) * step;

      this.resolveCollisions(next);
      this.player.position.x = next.x;
      this.player.position.z = next.z;

      this.facing = angle;
    }

    // Turn towards the direction of travel rather than snapping.
    const diff = wrapAngle(this.facing - this.player.rotation.y);
    this.player.rotation.y += diff * Math.min(1, EYE_TURN_RATE * delta);

    if (this.input.jump && this.grounded) {
      this.velocityY = JUMP_SPEED;
      this.grounded = false;
      this.input.jump = false;
    }

    if (!this.grounded) {
      this.velocityY -= GRAVITY * delta;
      this.player.position.y += this.velocityY * delta;
      if (this.player.position.y <= 0) {
        this.player.position.y = 0;
        this.velocityY = 0;
        this.grounded = true;
      }
    }

    if (this.actions) {
      if (!this.grounded) this.playClip('Jump');
      else if (moving) this.playClip(input.run ? 'Running' : 'Walking');
      else this.playClip('Idle');
    }

    // Keep the walker inside the park.
    const limit = PER_SIDE * PLOT_PITCH / 2 + 22;
    this.player.position.x = clamp(this.player.position.x, -limit, limit);
    this.player.position.z = clamp(this.player.position.z, -limit, limit);
  }

  /**
   * Push the player out of any exhibit they are walking into.
   *
   * Axis-aligned boxes, resolved on whichever axis is least overlapped. Cheap,
   * predictable, and - the part that matters at an unattended booth - it cannot
   * wedge anyone inside geometry the way a real solver can.
   */
  resolveCollisions(next) {
    for (const exhibit of this.exhibits) {
      if (exhibit.removing) continue;

      const box = exhibit.group.position;
      const halfX = exhibit.halfWidth + PLAYER_RADIUS;
      const halfZ = exhibit.halfDepth + PLAYER_RADIUS;
      const dx = next.x - box.x;
      const dz = next.z - box.z;

      if (Math.abs(dx) >= halfX || Math.abs(dz) >= halfZ) continue;

      const overlapX = halfX - Math.abs(dx);
      const overlapZ = halfZ - Math.abs(dz);
      if (overlapX < overlapZ) next.x = box.x + Math.sign(dx || 1) * halfX;
      else next.z = box.z + Math.sign(dz || 1) * halfZ;
    }
  }

  stepCamera(delta) {
    this.cameraYaw += wrapAngle(this.orbit - this.cameraYaw) * Math.min(1, 6 * delta);

    const target = this.player.position.clone();
    target.y += PLAYER_HEIGHT * 0.85;

    const wanted = new THREE.Vector3(
      target.x - Math.sin(this.cameraYaw) * CAMERA_DISTANCE,
      target.y + CAMERA_HEIGHT,
      target.z - Math.cos(this.cameraYaw) * CAMERA_DISTANCE,
    );

    this.camera.position.lerp(wanted, Math.min(1, 7 * delta));
    this.cameraTarget.lerp(target, Math.min(1, 10 * delta));
    this.camera.lookAt(this.cameraTarget);
  }

  resize() {
    const width = Math.max(320, this.container.clientWidth);
    const height = Math.max(240, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Screen position of an exhibit's top, for hanging an HTML label on it. */
  projectLabel(exhibit) {
    const point = exhibit.group.position.clone();
    point.y += 0.6;
    const box = new THREE.Box3().setFromObject(exhibit.group);
    point.y = box.max.y + 0.5;

    const projected = point.project(this.camera);
    if (projected.z > 1) return null;

    return {
      x: (projected.x * 0.5 + 0.5) * this.renderer.domElement.clientWidth,
      y: (-projected.y * 0.5 + 0.5) * this.renderer.domElement.clientHeight,
      depth: projected.z,
    };
  }

  get liveCount() {
    return this.exhibits.filter((e) => !e.removing).length;
  }
}

/* ---------- helpers ---------- */

function geometryFor(part) {
  switch (part.shape) {
    case 'sphere':
      return new THREE.SphereGeometry(part.width / 2, 18, 12);
    case 'cylinder':
      return new THREE.CylinderGeometry(part.width / 2, part.width / 2, part.height, 18);
    case 'cone':
      return new THREE.ConeGeometry(part.width / 2, part.height, 18);
    case 'box':
    default:
      return new THREE.BoxGeometry(part.width, part.height, part.depth);
  }
}

/**
 * The fallback avatar: a blocky little figure, built from the same primitives
 * as everything else. Used until the model loads, and permanently if it is not
 * there - the booth must never open to an empty world because a file moved.
 */
function makeBlockAvatar() {
  const group = new THREE.Group();
  const add = (w, h, d, x, y, z, color) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color }),
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  add(0.3, 0.75, 0.3, -0.18, 0.38, 0, 0x2f3a56);
  add(0.3, 0.75, 0.3, 0.18, 0.38, 0, 0x2f3a56);
  add(0.78, 0.8, 0.42, 0, 1.15, 0, 0xffd23f);
  add(0.22, 0.7, 0.22, -0.5, 1.2, 0, 0xf7d9b0);
  add(0.22, 0.7, 0.22, 0.5, 1.2, 0, 0xf7d9b0);
  add(0.6, 0.6, 0.6, 0, 1.85, 0, 0xf7d9b0);

  return group;
}

/** A canvas texture of a short string, for the plot number boards. */
function makeTextTexture(text, ink, background) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = ink;
  ctx.font = '700 130px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 6);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

function disposeGroup(group) {
  group.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry.dispose();
    if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose());
    else node.material.dispose();
  });
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}
