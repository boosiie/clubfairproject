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
import { VOXEL, shadeVoxels, voxelBounds } from './voxel.js';

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
/** Eye height for first person. A touch below the top of the head. */
const EYE_HEIGHT = 1.62;
/** Just short of straight up and down - past vertical the world flips over. */
const MAX_PITCH = 1.45;

/**
 * The floor is white with a thin dark grid, the way a Wii menu is: the point of
 * the grid is not decoration, it is scale. A plain white plane has no size and
 * no landmarks, so walking forwards on one looks exactly like standing still.
 * Everything else is kept pale so the exhibits are the only colour in the park.
 */
const GRID_METRES = 2;
const FLOOR_SIZE = 240;
const FLOOR_COLOR = 0xffffff;
/** Slate-blue rather than black. A black grid is the heaviest thing on screen
 *  and drags the floor back towards tarmac; this reads as ruled paper. */
const GRID_INK = '#2b4463';
/** What the floor bounces back up. Near-white, because the floor is. */
const BOUNCE_COLOR = 0xeef3f8;
/**
 * Everything on the floor is PAINTED on, never built up.
 *
 * The road and the plots used to be raised slabs, and standing anywhere on the
 * boulevard they covered the bottom two thirds of the screen - so the grid,
 * which is the only thing telling you that you are moving, was visible only as
 * a smudge near the horizon. Flat markings read exactly as well and leave the
 * floor showing everywhere.
 *
 * Thin and unlit, so they read as lines drawn on a diagram rather than as paint
 * on tarmac. A wide dark one looks like a kerb; this looks like a schematic.
 */
const ROAD_LINE = 0x8ed3ee;
const PLOT_LINE = 0x3fb2e0;
/** Width of a painted stripe, in metres. */
const LINE_WIDTH = 0.14;

/**
 * The place you are walking through is meant to read as the inside of a cloud
 * service: a white schematic floor, haze in every direction, data rising
 * through the air, and racks of something enormous just out of focus at the
 * edges. All of it is flat colour and fog - there is not one shader here,
 * because it has to hold 60fps on a school laptop with integrated graphics.
 */
const SKY_HIGH = '#74bfe6';
const SKY_MID = '#c4e6f7';
const SKY_LOW = '#f0fafe';
/** What everything fades into. Matches the bottom of the sky, so there is no
 *  visible seam where the floor runs out. */
const HAZE_COLOR = 0xe4f3fb;
const DATA_COLOR = 0x3ba9d8;
const RACK_COLOR = 0x8fc4dd;
/** How high the motes drift before they wrap back to the floor. */
const MOTE_CEILING = 26;

export class World {
  constructor(container, options = {}) {
    this.container = container;
    this.onPlotChange = options.onPlotChange ?? (() => {});

    this.exhibits = [];
    this.totalBuilt = 0;
    this.currentPlot = -1;
    this.clock = new THREE.Clock();
    this.input = { forward: 0, strafe: 0, run: false, jump: false };
    /** Where you are looking. Shared by the camera and by which way is forward. */
    this.yaw = 0;
    this.pitch = 0;
    this.firstPerson = true;
    /** Set while the view is easing round to watch a new exhibit land. */
    this.autoYaw = null;

    this.scene = new THREE.Scene();
    // Haze starts well before the far plots, so the boulevard has depth rather
    // than ending in a hard edge, and the floor runs out inside the haze where
    // you cannot see it happen.
    this.scene.fog = new THREE.Fog(HAZE_COLOR, 45, 135);

    // 75 degrees is the usual first-person field of view; the third-person
    // toggle narrows it back to 58.
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 400);
    this.cameraTarget = new THREE.Vector3();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.buildLighting();
    this.buildSky();
    this.buildGround();
    this.buildPlots();
    this.buildHorizon();
    this.buildMotes();
    this.buildPlayer();

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.renderer.setAnimationLoop(() => this.frame());
  }

  /* ---------- scene ---------- */

  buildLighting() {
    /*
     * These two numbers are an exposure setting, not a taste one.
     *
     * three.js divides light intensity by pi (the Lambert BRDF), so the old
     * 1.5/1.6 pair summed to about 0.65 at a floor facing straight up - every
     * surface in the park was rendering at two thirds of the colour it was
     * given. On green you cannot see that. On white you can: it came out
     * #d2dadd, a blue-grey. At 1.7/1.9 the sum lands just under 1, which means
     * a white floor is white and every exhibit is the colour it was built in.
     *
     * The sky term is near-white rather than sky blue for the same reason - it
     * is the floor's main light source, and a blue light on a white floor makes
     * a blue floor. The blue in the scene comes from the background and the fog.
     */
    const sky = new THREE.HemisphereLight(0xf4f9ff, BOUNCE_COLOR, 1.7);
    this.scene.add(sky);

    const sun = new THREE.DirectionalLight(0xfff8ee, 1.9);
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

  /**
   * A gradient dome instead of a flat background colour.
   *
   * A single flat colour gives the sky no up, so the horizon is a hard line and
   * the whole thing reads as a room with a painted wall. The gradient puts the
   * pale end at the horizon where the fog is, which is what makes the floor
   * look like it dissolves into distance rather than stopping.
   */
  buildSky() {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(300, 24, 16),
      new THREE.MeshBasicMaterial({
        map: makeSkyTexture(),
        side: THREE.BackSide,
        // Not fogged, or the sky fades into its own fog colour and goes flat.
        fog: false,
        depthWrite: false,
      }),
    );
    this.scene.add(dome);
  }

  /**
   * Racks of something enormous, ringed round the park and half lost in haze.
   *
   * The single strongest cue that you are inside a system rather than outdoors:
   * flat silhouettes, no lighting, no shadows, arranged so that whichever way
   * you turn there is more of it. Cylinders among the boxes because a stack of
   * drums is what a database has looked like in every diagram ever drawn.
   */
  buildHorizon() {
    const material = new THREE.MeshBasicMaterial({ color: RACK_COLOR });
    const group = new THREE.Group();

    for (let i = 0; i < 96; i++) {
      const angle = (i / 96) * Math.PI * 2 + Math.random() * 0.05;
      const radius = 76 + Math.random() * 40;
      const height = 5 + Math.random() * 32;
      const drum = Math.random() < 0.3;

      const mesh = new THREE.Mesh(
        drum
          ? new THREE.CylinderGeometry(2.2, 2.2, height, 10)
          : new THREE.BoxGeometry(2.5 + Math.random() * 5, height, 2.5 + Math.random() * 5),
        material,
      );
      mesh.position.set(Math.sin(angle) * radius, height / 2, Math.cos(angle) * radius);
      mesh.rotation.y = Math.random() * Math.PI;
      group.add(mesh);
    }

    this.scene.add(group);
  }

  /** Data drifting up through the air. Wraps back to the floor at the ceiling. */
  buildMotes() {
    const count = 480;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 130;
      positions[i * 3 + 1] = Math.random() * MOTE_CEILING;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 170;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    this.motes = new THREE.Points(geometry, new THREE.PointsMaterial({
      map: makeMoteTexture(),
      color: DATA_COLOR,
      size: 0.3,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.8,
      // Off, or every mote punches a hole in whatever is behind it.
      depthWrite: false,
    }));
    this.scene.add(this.motes);
  }

  stepMotes(delta) {
    const { array } = this.motes.geometry.attributes.position;
    for (let i = 1; i < array.length; i += 3) {
      // A spread of speeds, so it drifts rather than moving as one sheet.
      array[i] += delta * (0.3 + (i % 11) * 0.05);
      if (array[i] > MOTE_CEILING) array[i] -= MOTE_CEILING;
    }
    this.motes.geometry.attributes.position.needsUpdate = true;
  }

  buildGround() {
    const length = PER_SIDE * PLOT_PITCH + 30;

    const grid = makeGridTexture();
    // The plane is centred on the origin and FLOOR_SIZE divides exactly by the
    // cell size, so tile edges land on even metres and a line runs through 0.
    grid.repeat.set(FLOOR_SIZE / GRID_METRES, FLOOR_SIZE / GRID_METRES);
    // Without this a thin dark line on white turns to grey mush a few metres
    // out, and the whole floor shimmers as you walk.
    grid.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new THREE.MeshLambertMaterial({ color: FLOOR_COLOR, map: grid }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // The boulevard is two painted edge lines, the way a court is marked out.
    for (const side of [-1, 1]) {
      this.scene.add(stripe(LINE_WIDTH, length, side * ROAD_HALF, 0, ROAD_LINE));
    }
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

      // The plot is a painted square. Four bars rather than a filled slab, so
      // the grid runs straight through it and exhibits sit on the floor itself
      // instead of on a shelf a hand's width above it.
      const span = PLOT_SIZE + LINE_WIDTH;
      for (const side of [-1, 1]) {
        this.scene.add(stripe(span, LINE_WIDTH, at.x, at.z + side * PLOT_SIZE / 2, PLOT_LINE));
        this.scene.add(stripe(LINE_WIDTH, span, at.x + side * PLOT_SIZE / 2, at.z, PLOT_LINE));
      }

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
      ring.position.set(at.x, 0.05, at.z);
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
      // Steel rather than the wood it used to be: a timber signpost in a data
      // centre was the one thing in shot still pretending to be outdoors.
      new THREE.MeshLambertMaterial({ color: 0xa8bfd2 }),
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
    this.placeholder.visible = !this.firstPerson;
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

    model.visible = !this.firstPerson;
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
   * @param {{meme?: string|null}} [options] - meme text prints the block face,
   *   for a prompt with no word in it. Passed as an option rather than carried
   *   on the structure so the model has no way to ask for one.
   */
  build(structure, plotIndex, options = {}) {
    if (plotIndex < 0 || plotIndex >= PLOT_COUNT) return null;

    const meme = options.meme || null;
    const fitted = fitStructure(structure, STRUCTURE_MAX);
    const at = this.plotPosition(plotIndex);

    const group = new THREE.Group();
    let bounds;

    // A meme block is the one thing that is not a sculpture. It is a single
    // slab with a caption printed across its face, answering a prompt with no
    // word in it, so it keeps the primitive path - a caption spread over a few
    // hundred separate cubes would be unreadable.
    if (meme || !fitted.voxels?.length) {
      bounds = structureBounds(fitted);
      fitted.parts.forEach((part, index) => {
        const mesh = new THREE.Mesh(geometryFor(part), materialsFor(part, index === 0 ? meme : null));
        mesh.position.set(part.offsetX, part.offsetY, part.offsetZ);
        mesh.rotation.set(part.rotationX, part.rotationY, part.rotationZ);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      });
    } else {
      bounds = voxelBounds(fitted.voxels);
      for (const mesh of voxelMeshes(fitted)) group.add(mesh);
    }

    // Spread repeat builds around the plot instead of stacking them on one spot.
    const taken = this.contentsOf(plotIndex).length;
    const spread = PLOT_SIZE * 0.27;
    const nudge = [[0, 0], [-spread, spread], [spread, -spread], [spread, spread]][taken % 4];

    group.position.set(at.x + nudge[0], DROP_HEIGHT, at.z + nudge[1]);
    // A random spin is fine for a statue and useless for something you have to
    // read, so the block turns its face to whoever typed it. Local +Z becomes
    // (sin y, 0, cos y), which is why the arguments are this way round.
    group.rotation.y = meme
      ? Math.atan2(this.player.position.x - group.position.x, this.player.position.z - group.position.z)
      : Math.random() * Math.PI * 2;
    this.scene.add(group);

    const sin = Math.abs(Math.sin(group.rotation.y));
    const cos = Math.abs(Math.cos(group.rotation.y));

    const exhibit = {
      group,
      label: fitted.label,
      plot: plotIndex,
      bounciness: fitted.bounciness,
      // The world-space box, used for walking into things. Recomputed when it
      // lands, since the drop changes its height.
      // The footprint is measured before the group is turned, so turn it too.
      // Collision is axis-aligned, and anything much wider than it is deep - a
      // bus, a wall, the block - is walk-straight-through without this.
      halfWidth: (bounds.width * cos + bounds.depth * sin) / 2,
      halfDepth: (bounds.width * sin + bounds.depth * cos) / 2,
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
        if (!node.isMesh) return;
        // Cloned so fading this copy does not fade every other exhibit sharing
        // the material. The block face is an array of six, so handle both.
        const fade = (material) => Object.assign(material.clone(), { transparent: true });
        node.material = Array.isArray(node.material)
          ? node.material.map(fade)
          : fade(node.material);
      });
    }
  }

  /* ---------- per-frame ---------- */

  frame() {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const now = this.clock.elapsedTime;

    this.stepExhibits(delta, now);
    this.stepMotes(delta);
    this.stepAutoTurn(delta);
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
          if (node.isMesh) for (const material of eachMaterial(node)) material.opacity = opacity;
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

  stepAutoTurn(delta) {
    if (this.autoYaw === null || this.autoYaw === undefined) return;
    // Walking is deliberate input too - it means they have moved on.
    if (this.input.forward || this.input.strafe) {
      this.autoYaw = null;
      return;
    }

    const diff = wrapAngle(this.autoYaw - this.yaw);
    if (Math.abs(diff) < 0.02) {
      this.yaw = this.autoYaw;
      this.autoYaw = null;
      return;
    }
    this.yaw = wrapAngle(this.yaw + diff * Math.min(1, 5 * delta));
  }

  stepPlayer(delta) {
    const { input } = this;
    const moving = input.forward !== 0 || input.strafe !== 0;
    const speed = input.run ? RUN_SPEED : WALK_SPEED;

    if (moving) {
      // Movement is relative to where you are looking. three's camera looks
      // down -Z at yaw 0, so forward is (-sin, -cos) and right is its
      // perpendicular - getting these the wrong way round is how you end up
      // walking backwards out of your own park.
      const forwardX = -Math.sin(this.yaw);
      const forwardZ = -Math.cos(this.yaw);
      const rightX = Math.cos(this.yaw);
      const rightZ = -Math.sin(this.yaw);

      let dx = forwardX * input.forward + rightX * input.strafe;
      let dz = forwardZ * input.forward + rightZ * input.strafe;
      // Normalise so walking diagonally is not faster than walking straight.
      const length = Math.hypot(dx, dz) || 1;
      dx /= length;
      dz /= length;

      const step = speed * delta;
      const next = this.player.position.clone();
      next.x += dx * step;
      next.z += dz * step;

      this.resolveCollisions(next);
      this.player.position.x = next.x;
      this.player.position.z = next.z;

      this.facing = Math.atan2(dx, dz);
    }

    // Turn the body towards the direction of travel rather than snapping. Only
    // visible in third person, but cheap enough to keep running either way.
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
    const { position } = this.player;

    if (this.firstPerson) {
      // Rigidly attached to the head. No smoothing at all: lerping a
      // first-person camera reads as motion sickness, not as smoothness.
      this.camera.position.set(position.x, position.y + EYE_HEIGHT, position.z);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(this.pitch, this.yaw, 0);
      return;
    }

    const target = new THREE.Vector3(position.x, position.y + PLAYER_HEIGHT * 0.85, position.z);
    const wanted = new THREE.Vector3(
      target.x + Math.sin(this.yaw) * CAMERA_DISTANCE * Math.cos(this.pitch),
      target.y + CAMERA_HEIGHT - Math.sin(this.pitch) * CAMERA_DISTANCE,
      target.z + Math.cos(this.yaw) * CAMERA_DISTANCE * Math.cos(this.pitch),
    );

    this.camera.rotation.set(0, 0, 0);
    this.camera.position.lerp(wanted, Math.min(1, 7 * delta));
    this.cameraTarget.lerp(target, Math.min(1, 10 * delta));
    this.camera.lookAt(this.cameraTarget);
  }

  /**
   * Swap between standing in the park and watching yourself walk through it.
   *
   * First person is the default because it is what the place is for. Third
   * person exists because the avatar is a real animated model and it is worth
   * being able to see it - Roblox lets you do both, for the same reason.
   */
  toggleView() {
    this.firstPerson = !this.firstPerson;
    this.camera.fov = this.firstPerson ? 75 : 58;
    this.camera.updateProjectionMatrix();
    this.setAvatarVisible(!this.firstPerson);
    return this.firstPerson;
  }

  setAvatarVisible(visible) {
    if (this.avatar) this.avatar.visible = visible;
    if (this.placeholder) this.placeholder.visible = visible;
  }

  /**
   * Turn to watch something. Called when you build, because in first person you
   * are usually facing down the road and the exhibit lands off to one side -
   * you would type, hear it land, and see nothing. The turn is eased rather
   * than snapped, and it takes about as long as the drop.
   */
  faceTowards(x, z) {
    const dx = x - this.player.position.x;
    const dz = z - this.player.position.z;
    if (Math.hypot(dx, dz) < 0.2) return;
    this.autoYaw = Math.atan2(-dx, -dz);
  }

  /** Turn the view. Both the drag handler and pointer lock feed into this. */
  look(deltaYaw, deltaPitch) {
    // Any deliberate input wins over the turn-to-watch; nothing is more
    // irritating than a camera arguing with your hand.
    this.autoYaw = null;
    this.yaw = wrapAngle(this.yaw - deltaYaw);
    // Stop just short of straight up and down: going past vertical flips the
    // world over and there is no way for a visitor to work out what happened.
    this.pitch = clamp(this.pitch - deltaPitch, -MAX_PITCH, MAX_PITCH);
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

/**
 * Draw a sculpture: one InstancedMesh for the cubes, one more for any that glow.
 *
 * Instancing is what makes this affordable. Six hundred separate meshes per
 * exhibit, times three exhibits a plot, times twelve plots, is twenty thousand
 * draw calls and a slideshow. As instances it is two calls per exhibit however
 * many cubes it has, and the park stays at framerate on a laptop driving a
 * projector.
 *
 * The cubes are drawn a hair under full size. The seam is only a centimetre,
 * but it catches the light along every edge and is the difference between
 * reading as a sculpture built out of blocks and reading as one melted lump.
 */
function voxelMeshes(structure) {
  const { solid, glow } = shadeVoxels(structure.voxels, structure.palette);
  const meshes = [];

  // Lambert for the body: it takes the sun, and the baked occlusion is already
  // in the instance colours. Basic for the glow, which is its own light source
  // and should not dim on whichever side of the park it ended up facing.
  if (solid.length) meshes.push(instancedCubes(solid, new THREE.MeshLambertMaterial(), true));
  if (glow.length) meshes.push(instancedCubes(glow, new THREE.MeshBasicMaterial(), false));

  return meshes;
}

function instancedCubes(cells, material, shadows) {
  const geometry = new THREE.BoxGeometry(VOXEL * 0.97, VOXEL * 0.97, VOXEL * 0.97);
  const mesh = new THREE.InstancedMesh(geometry, material, cells.length);
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();

  cells.forEach((cell, index) => {
    matrix.makeTranslation(cell.x, cell.y, cell.z);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, color.set(cell.color));
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  return mesh;
}

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

/**
 * One grid cell, drawn once and tiled across the floor.
 *
 * The lines go on two edges only. Drawing all four would double every interior
 * line where tiles meet, giving a grid of alternating thick and thin lines that
 * looks like a rendering bug.
 */
/** The sky, as a one-pixel-wide vertical gradient stretched over the dome. */
function makeSkyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Sphere UVs put v=1 at the north pole, and flipY maps that to the top of the
  // image - so the first stop is straight overhead and the last is underfoot.
  const sky = ctx.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, SKY_HIGH);
  sky.addColorStop(0.52, SKY_MID);
  sky.addColorStop(0.78, SKY_LOW);
  sky.addColorStop(1, SKY_LOW);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 2, 256);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A soft round dot for the drifting motes. A bare point sprite is a square. */
function makeMoteTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  const dot = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  dot.addColorStop(0, 'rgba(255,255,255,1)');
  dot.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  dot.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = dot;
  ctx.fillRect(0, 0, size, size);

  return new THREE.CanvasTexture(canvas);
}

function makeGridTexture() {
  // 256 rather than 128 for the mipmaps: the line has to survive being shrunk
  // to a couple of pixels twenty metres out, and a low-resolution tile fades to
  // nothing at exactly the distance where the grid is doing the most work.
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // 10px of a 256px cell spanning two metres is a line about 8cm wide, which is
  // the width of a real painted floor line and reads at every distance.
  ctx.fillStyle = GRID_INK;
  ctx.globalAlpha = 0.55;
  ctx.fillRect(0, 0, size, 8);
  ctx.fillRect(0, 0, 8, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* ---------- the block for a prompt that is not words ---------- */

const SOB_COUNT = 5;

/**
 * A sobbing emoji, drawn rather than typed.
 *
 * Canvas renders an emoji character in whatever colour font the machine has,
 * and on a machine without one you get an empty box. Five empty boxes is not a
 * joke, it is a bug the booth cannot recover from - and this has to work on a
 * school laptop with no network. Thirty lines of arcs looks the same anywhere.
 */
function drawSob(ctx, cx, cy, size) {
  const r = size / 2;

  const skin = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
  skin.addColorStop(0, '#ffe04d');
  skin.addColorStop(1, '#f2a900');
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Eyes squeezed shut: two arcs bowing upwards.
  ctx.strokeStyle = '#6d4a00';
  ctx.lineWidth = Math.max(2, r * 0.14);
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + side * r * 0.42, cy + r * 0.04, r * 0.3, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }

  // Tears, straight down from under each eye and off the chin.
  ctx.fillStyle = '#48a5ee';
  for (const side of [-1, 1]) {
    const x = cx + side * r * 0.42;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.12, cy + r * 0.14);
    ctx.lineTo(x + r * 0.12, cy + r * 0.14);
    ctx.lineTo(x + r * 0.08, cy + r * 1.02);
    ctx.quadraticCurveTo(x, cy + r * 1.24, x - r * 0.08, cy + r * 1.02);
    ctx.closePath();
    ctx.fill();
  }

  // Wide open wailing mouth, last so the tears pass behind it.
  ctx.fillStyle = '#7d2f18';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.44, r * 0.33, r * 0.27, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e0665c';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.6, r * 0.19, r * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The face of the block: what they typed, then a row of sobbing emoji, in the
 * white-with-a-dark-outline every meme caption has ever been set in.
 */
function makeMemeTexture(text) {
  const width = 1024;
  const height = 689;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Dark slate, so the card reads as a panel switched on in the middle of the
  // park rather than a piece of something else pasted into it.
  const back = ctx.createLinearGradient(0, 0, width * 0.4, height);
  back.addColorStop(0, '#33455c');
  back.addColorStop(1, '#161e2a');
  ctx.fillStyle = back;
  ctx.fillRect(0, 0, width, height);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const room = width * 0.9;
  /** Gap before the first face, and the pitch of the row - both in font units. */
  const GAP = 0.4;
  const STEP = 0.92;

  const setFont = (px) => {
    ctx.font = `700 ${px}px ui-sans-serif, system-ui, "Segoe UI", Arial, sans-serif`;
    return ctx.measureText(text).width;
  };

  const caption = (px, x, y) => {
    setFont(px);
    ctx.lineJoin = 'round';
    ctx.lineWidth = px * 0.14;
    ctx.strokeStyle = '#141414';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  };

  const row = (size, y) => {
    const pitch = size * 1.06;
    const start = (width - pitch * SOB_COUNT) / 2;
    for (let i = 0; i < SOB_COUNT; i++) drawSob(ctx, start + pitch * (i + 0.5), y, size);
  };

  // First choice is the original layout: one line, text then faces.
  let font = Math.round(height * 0.27);
  let textWidth = setFont(font);
  for (; font > 16; font -= 2) {
    textWidth = setFont(font);
    if (textWidth + font * (GAP + SOB_COUNT * STEP) <= room) break;
  }

  // A short mash - which is nearly all of them - keeps the one-line setting of
  // the original. The threshold is where the faces stop reading as faces.
  if (font * STEP >= height * 0.11) {
    const left = (width - (textWidth + font * (GAP + SOB_COUNT * STEP))) / 2;
    caption(font, left, height * 0.5);
    const pitch = font * STEP;
    const first = left + textWidth + font * GAP;
    for (let i = 0; i < SOB_COUNT; i++) drawSob(ctx, first + pitch * (i + 0.5), height * 0.5, font * 0.88);
  } else {
    // The text is long enough that keeping it on one line with the faces
    // shrinks them to specks - and the faces are the joke, not the text. So
    // they keep their size and the words take the line above.
    let stacked = Math.round(height * 0.22);
    for (; stacked > 16 && setFont(stacked) > room; stacked -= 2);
    caption(stacked, (width - setFont(stacked)) / 2, height * 0.36);
    row(Math.min(height * 0.24, (room / SOB_COUNT) * 0.94), height * 0.68);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * Materials for one part. `meme` turns it into the block face.
 *
 * BoxGeometry's face order is +X, -X, +Y, -Y, +Z, -Z. The caption goes on the
 * two large faces only - stretched across a 0.5m edge it would be unreadable -
 * and build() turns the block to face whoever typed it.
 */
function materialsFor(part, meme) {
  const plain = new THREE.MeshLambertMaterial({ color: part.color });
  if (!meme || part.shape !== 'box') return plain;

  // Unlit on purpose. A lit face is only as bright as whichever way the block
  // happened to land relative to the sun, and a caption you have to walk round
  // the block to read is not a joke, it is a shrug. Basic material always reads.
  const faced = new THREE.MeshBasicMaterial({ map: makeMemeTexture(meme) });
  return [plain, plain, plain, plain, faced, faced];
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

/**
 * A stripe painted on the floor.
 *
 * A flat box rather than a plane: 2cm thick sits clear of the floor without
 * z-fighting, and is far too low to be something you can trip over or have to
 * jump. It casts no shadow, because paint does not.
 */
function stripe(width, depth, x, z, color) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.02, depth),
    // Unlit, so a line is the exact colour it was given wherever it runs. Lit,
    // a thin pale line loses most of its contrast the moment it crosses a
    // shadow, and the marking it is drawing disappears in patches.
    new THREE.MeshBasicMaterial({ color }),
  );
  mesh.position.set(x, 0.011, z);
  return mesh;
}

/** A mesh's materials, whether it has one or a set of six. */
function eachMaterial(mesh) {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function disposeGroup(group) {
  group.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry.dispose();
    for (const material of eachMaterial(node)) {
      // The block face owns a canvas texture. Without this every unreadable
      // prompt leaks a megabyte of GPU memory for the life of the booth.
      material.map?.dispose();
      material.dispose();
    }
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
