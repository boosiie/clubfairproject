/**
 * park.js - the walkable world.
 *
 * A row of numbered plots along a midway. You walk a character to a plot, type
 * what belongs there, and it drops in. The park never resets, so by the end of
 * the day it is a row of everything the crowd built - and unlike a single pile,
 * twelve separate plots stay readable all afternoon.
 *
 * Each creation is welded into one rigid compound body, so a statue holds its
 * shape and stands. It can still be knocked over by whatever lands next to it,
 * which is the part people stay to watch.
 */

import { fitStructure, structureBounds, MASS_BAND, STRUCTURE_MAX } from './spec.js';

const { Engine, Render, Runner, Composite, Bodies, Body, Events, Query, Vector } = window.Matter;

export const PLOT_WIDTH = 640;
export const PLOT_COUNT = 12;
export const WORLD_WIDTH = PLOT_WIDTH * PLOT_COUNT;
/** World y of the ground surface. Everything is measured up from here. */
export const GROUND_Y = 760;

/** Structures per plot before the oldest in that plot fades out. */
const PLOT_CAPACITY = 4;
const FADE_MS = 800;
/** How far above the ground a new structure appears before it drops in. */
const DROP_HEIGHT = 300;
const HIGHLIGHT_MS = 5000;

const FENCE_HEIGHT = 44;

/**
 * Collision categories.
 *
 * The fences exist to stop a toppling statue sprawling into the neighbour's
 * plot - they must not stop the person walking the midway. Putting the walker
 * in its own category lets fences contain exhibits and ignore people.
 */
const CATEGORY = { WORLD: 0x0001, WALKER: 0x0002 };
/** Everything except the walker. */
const WORLD_ONLY = CATEGORY.WORLD;
const EVERYTHING = CATEGORY.WORLD | CATEGORY.WALKER;

/**
 * How long a new exhibit ignores the walker while it drops.
 *
 * Exhibits land in the middle of the plot, which is exactly where the person
 * who asked for it is standing. Without this you get flattened by your own
 * statue - which is funny once and then ruins the booth.
 */
const FALL_GRACE_MS = 2200;
/** Frames of pushing against nothing before we assume the walker is pinned. */
const STUCK_FRAMES = 45;

/**
 * How far back the camera sits, as a multiple of the canvas size.
 *
 * The prompt lives in the middle of the screen, so a full-height exhibit
 * rendered 1:1 would land behind it. Pulling back leaves clear air above the
 * prompt for the thing the crowd is actually here to look at. Hand-drawn text
 * multiplies by this to stay the same size on screen.
 */
const ZOOM = 1.3;
/**
 * Where the horizon sits within the visible area.
 *
 * High, on purpose. Exhibits grow upward from the ground, and the prompt lives
 * in the middle of the screen - put the horizon low and every statue is built
 * behind the input box. With the horizon up here the exhibits occupy the sky
 * band and the prompt sits on the empty path below them, which is both readable
 * and the way you would actually stand on a midway.
 */
const GROUND_FRACTION = 0.62;

const WALK_SPEED = 5.4;
const JUMP_VELOCITY = 13;
const CHARACTER = { width: 30, height: 54 };
/** Hard speed cap per step - Matter tunnels through thin walls above this. */
const MAX_SPEED = 40;

const GROUND_COLOR = '#243a2b';
const FENCE_COLOR = '#4a5a46';

export class Park {
  constructor(container, options = {}) {
    this.container = container;
    this.bottomInset = options.bottomInset ?? (() => 0);
    this.onPlotChange = options.onPlotChange ?? (() => {});

    this.structures = [];
    this.totalBuilt = 0;
    this.cameraX = 0;
    this.currentPlot = 0;
    this.input = { left: false, right: false, jump: false };

    this.engine = Engine.create({ enableSleeping: true });
    this.engine.gravity.y = 1.2;
    this.engine.positionIterations = 8;
    this.engine.velocityIterations = 6;

    const { width, height } = this.measure();

    this.render = Render.create({
      element: container,
      engine: this.engine,
      options: {
        width,
        height,
        background: 'transparent',
        wireframes: false,
        pixelRatio: 'auto',
        hasBounds: true,
        showSleeping: false,
      },
    });

    this.buildTerrain();
    this.buildCharacter();

    Events.on(this.engine, 'beforeUpdate', () => this.drive());
    Events.on(this.engine, 'afterUpdate', () => this.tick());
    Events.on(this.render, 'afterRender', () => this.decorate());

    Render.run(this.render);
    this.runner = Runner.create();
    Runner.run(this.runner, this.engine);

    this.updateCamera(true);
    window.addEventListener('resize', () => this.resize());
  }

  measure() {
    const width = Math.max(320, this.container.clientWidth);
    const height = Math.max(240, this.container.clientHeight);
    return { width, height };
  }

  /* ---------- terrain ---------- */

  buildTerrain() {
    const bodies = [
      Bodies.rectangle(WORLD_WIDTH / 2, GROUND_Y + 300, WORLD_WIDTH + 4000, 600, {
        isStatic: true,
        friction: 0.9,
        render: { fillStyle: GROUND_COLOR, strokeStyle: '#31513a', lineWidth: 3 },
      }),
      // End walls, so nothing walks or rolls out of the park.
      Bodies.rectangle(-100, GROUND_Y - 600, 200, 2000, { isStatic: true, render: { visible: false } }),
      Bodies.rectangle(WORLD_WIDTH + 100, GROUND_Y - 600, 200, 2000, { isStatic: true, render: { visible: false } }),
    ];

    // Low fences mark the plot boundaries. Short enough to jump, tall enough to
    // stop a toppling statue from sprawling into next door's plot.
    for (let i = 1; i < PLOT_COUNT; i++) {
      bodies.push(
        Bodies.rectangle(i * PLOT_WIDTH, GROUND_Y - FENCE_HEIGHT / 2, 12, FENCE_HEIGHT, {
          isStatic: true,
          collisionFilter: { category: CATEGORY.WORLD, mask: WORLD_ONLY },
          render: { fillStyle: FENCE_COLOR, strokeStyle: '#5d6f58', lineWidth: 2 },
        }),
      );
    }

    Composite.add(this.engine.world, bodies);
  }

  buildCharacter() {
    this.character = Bodies.rectangle(
      PLOT_WIDTH / 2,
      GROUND_Y - CHARACTER.height,
      CHARACTER.width,
      CHARACTER.height,
      {
        // Infinite inertia means the walker never tips over, which is the whole
        // trick to a stable physics character.
        inertia: Infinity,
        friction: 0.02,
        frictionAir: 0.02,
        restitution: 0,
        density: 0.004,
        collisionFilter: { category: CATEGORY.WALKER, mask: CATEGORY.WORLD },
        render: { visible: false }, // drawn by hand in decorate()
      },
    );
    this.character.plugin = { facing: 1, grounded: false, walkPhase: 0, stuckFrames: 0 };
    Composite.add(this.engine.world, this.character);
  }

  /* ---------- movement ---------- */

  /** Is there something solid directly under the character's feet? */
  isGrounded() {
    const { position } = this.character;
    const feet = {
      min: { x: position.x - CHARACTER.width / 2 + 3, y: position.y + CHARACTER.height / 2 },
      max: { x: position.x + CHARACTER.width / 2 - 3, y: position.y + CHARACTER.height / 2 + 6 },
    };
    const hits = Query.region(Composite.allBodies(this.engine.world), feet);
    return hits.some((body) => body !== this.character && !body.plugin?.removing);
  }

  drive() {
    const character = this.character;
    const grounded = this.isGrounded();
    character.plugin.grounded = grounded;

    let direction = 0;
    if (this.input.left) direction -= 1;
    if (this.input.right) direction += 1;

    if (direction !== 0) {
      character.plugin.facing = direction;
      character.plugin.walkPhase += 0.25;
      // Set velocity directly rather than applying force: a booth walker should
      // feel immediate, and force-based movement drifts on slopes and debris.
      Body.setVelocity(character, { x: WALK_SPEED * direction, y: character.velocity.y });
    } else if (grounded) {
      Body.setVelocity(character, { x: character.velocity.x * 0.6, y: character.velocity.y });
    }

    if (this.input.jump && grounded) {
      Body.setVelocity(character, { x: character.velocity.x, y: -JUMP_VELOCITY });
      this.input.jump = false;
    }

    this.rescueIfPinned(direction, grounded);

    // Never let the walker sleep, or it stops responding to the keyboard.
    Body.set(character, 'isSleeping', false);
  }

  /**
   * If someone is trying to walk and going nowhere with an exhibit resting on
   * their head, lift them out.
   *
   * Nobody is standing behind this booth to un-wedge a character, and an
   * unresponsive walker reads as "the demo is broken" rather than "you are
   * under a piano". The overhead check is what keeps this from firing when
   * you are simply pushing against the wall at the end of the park.
   */
  rescueIfPinned(direction, grounded) {
    const character = this.character;
    const pushing = direction !== 0 && grounded && Math.abs(character.velocity.x) < 0.5;

    if (!pushing) {
      character.plugin.stuckFrames = 0;
      return;
    }

    character.plugin.stuckFrames += 1;
    if (character.plugin.stuckFrames < STUCK_FRAMES) return;
    character.plugin.stuckFrames = 0;

    const { position } = character;
    const overhead = {
      min: { x: position.x - CHARACTER.width / 2, y: position.y - CHARACTER.height },
      max: { x: position.x + CHARACTER.width / 2, y: position.y - CHARACTER.height / 2 },
    };
    const crushedBy = Query.region(Composite.allBodies(this.engine.world), overhead)
      .filter((body) => body !== character && !body.isStatic);

    if (crushedBy.length) {
      Body.setPosition(character, { x: position.x, y: position.y - CHARACTER.height - 20 });
      Body.setVelocity(character, { x: 0, y: -4 });
    }
  }

  /* ---------- building ---------- */

  /** Which plot the character is standing in. */
  plotAt(x = this.character.position.x) {
    return Math.max(0, Math.min(PLOT_COUNT - 1, Math.floor(x / PLOT_WIDTH)));
  }

  plotCenter(index) {
    return index * PLOT_WIDTH + PLOT_WIDTH / 2;
  }

  /** What is already standing in a plot. */
  contentsOf(index) {
    return this.structures.filter((s) => s.plugin.plot === index && !s.plugin.removing);
  }

  /**
   * Build a structure in a plot. It appears above the plot and drops in.
   *
   * @param {object} structure - already through normalizeStructure()
   * @param {number} [plotIndex] - defaults to where the character is standing
   */
  build(structure, plotIndex = this.plotAt()) {
    const fitted = fitStructure(structure, STRUCTURE_MAX);
    const centerX = this.plotCenter(plotIndex);
    const baseY = GROUND_Y - DROP_HEIGHT;

    const parts = fitted.parts.map((part) => {
      const x = centerX + part.offsetX;
      const y = baseY - part.offsetY;
      const options = {
        density: fitted.density,
        restitution: fitted.restitution,
        friction: 0.75,
        render: {
          fillStyle: part.color,
          strokeStyle: shade(part.color, -34),
          lineWidth: 2,
        },
      };
      const body = makePart(part, x, y, options);
      // makePart has already set the shape's upright orientation; the model's
      // rotation is a tilt on top of that.
      if (part.rotation) Body.rotate(body, part.rotation);

      // Re-seat by bounding box. Matter positions a body by its centre of mass,
      // which for a polygon sits below the middle of its outline - so a roof
      // asked for at a given height would render floating above its walls.
      // Placing every shape by its box makes offsetX/offsetY mean the same
      // thing for all of them, which is what the schema promises the model.
      const box = body.bounds;
      Body.translate(body, {
        x: x - (box.min.x + box.max.x) / 2,
        y: y - (box.min.y + box.max.y) / 2,
      });
      return body;
    });

    // One rigid body from many parts. This is what makes a statue a statue
    // rather than a stack of loose boxes that collapses the moment it lands.
    const body = parts.length === 1
      ? parts[0]
      : Body.create({ parts, friction: 0.75, restitution: fitted.restitution });

    if (body.mass > MASS_BAND.max) Body.setMass(body, MASS_BAND.max);
    else if (body.mass < MASS_BAND.min) Body.setMass(body, MASS_BAND.min);

    // Ignore the walker while it falls; tick() restores this once it has landed.
    body.collisionFilter = { ...body.collisionFilter, category: CATEGORY.WORLD, mask: WORLD_ONLY };

    body.plugin = {
      label: fitted.label,
      subject: fitted.subject,
      plot: plotIndex,
      builtAt: performance.now(),
      index: ++this.totalBuilt,
      removing: false,
      // Anchoring happens after the drop, not now. Bolting it down at the
      // moment it is created leaves it hanging in mid-air forever.
      wantsAnchor: fitted.anchored,
      halfHeight: structureBounds(fitted).height / 2,
    };

    Composite.add(this.engine.world, body);
    this.structures.push(body);
    this.cullPlot(plotIndex);

    return body;
  }

  /** Keep each plot legible: past its capacity, the oldest exhibit fades out. */
  cullPlot(index) {
    const live = this.contentsOf(index);
    for (let i = 0; i < live.length - PLOT_CAPACITY; i++) {
      const victim = live[i];
      victim.plugin.removing = true;
      victim.plugin.removeAt = performance.now() + FADE_MS;
      if (victim.isStatic) Body.setStatic(victim, false);
      // Collide with nothing from here on, so the exhibit sinks away and
      // whatever was leaning on it settles into the gap.
      victim.collisionFilter = { ...victim.collisionFilter, mask: 0 };
    }
  }

  /* ---------- per-frame ---------- */

  tick() {
    const now = performance.now();

    for (let i = this.structures.length - 1; i >= 0; i--) {
      const body = this.structures[i];

      if (body.speed > MAX_SPEED) {
        const scale = MAX_SPEED / body.speed;
        Body.setVelocity(body, { x: body.velocity.x * scale, y: body.velocity.y * scale });
      }

      if (body.plugin.removing) {
        const remaining = Math.max(0, body.plugin.removeAt - now);
        setOpacity(body, remaining / FADE_MS);
        if (remaining <= 0) {
          Composite.remove(this.engine.world, body);
          this.structures.splice(i, 1);
        }
      } else if (!body.plugin.landed && now - body.plugin.builtAt > FALL_GRACE_MS) {
        // Down long enough to have landed and settled: it can bump into people
        // now, and permanent architecture gets bolted down where it came to rest.
        body.plugin.landed = true;
        body.collisionFilter = { ...body.collisionFilter, mask: EVERYTHING };
        if (body.plugin.wantsAnchor) Body.setStatic(body, true);
      } else if (body.position.y > GROUND_Y + 900) {
        Composite.remove(this.engine.world, body);
        this.structures.splice(i, 1);
      }
    }

    // If the walker somehow escapes the world, put it back rather than leaving
    // a booth with no character in it.
    if (this.character.position.y > GROUND_Y + 600) {
      Body.setPosition(this.character, { x: this.plotCenter(this.currentPlot), y: GROUND_Y - 200 });
      Body.setVelocity(this.character, { x: 0, y: 0 });
    }

    const plot = this.plotAt();
    if (plot !== this.currentPlot) {
      this.currentPlot = plot;
      this.onPlotChange(plot);
    }

    this.updateCamera();
  }

  updateCamera(immediate = false) {
    const { width, height } = this.measure();
    const visibleWidth = width * ZOOM;
    const visibleHeight = height * ZOOM;

    const target = clamp(
      this.character.position.x - visibleWidth / 2,
      0,
      Math.max(0, WORLD_WIDTH - visibleWidth),
    );

    // Ease toward the target so walking does not feel like the world is glued
    // to the character's nose.
    this.cameraX = immediate ? target : this.cameraX + (target - this.cameraX) * 0.12;

    const cameraY = GROUND_Y - visibleHeight * GROUND_FRACTION;

    this.render.bounds.min.x = this.cameraX;
    this.render.bounds.max.x = this.cameraX + visibleWidth;
    this.render.bounds.min.y = cameraY;
    this.render.bounds.max.y = cameraY + visibleHeight;
  }

  /** World-to-screen scale, so hand-drawn text stays a fixed size on screen. */
  get viewScale() {
    return (this.render.bounds.max.x - this.render.bounds.min.x) / this.render.options.width;
  }

  resize() {
    const { width, height } = this.measure();
    this.render.canvas.width = width;
    this.render.canvas.height = height;
    this.render.options.width = width;
    this.render.options.height = height;
    Render.setPixelRatio(this.render, 'auto');
    this.updateCamera(true);
  }

  /* ---------- hand-drawn layer ---------- */

  /**
   * Plot signs, exhibit labels and the character.
   *
   * afterRender fires with the view transform already reverted, so we re-apply
   * it to draw in world coordinates. The camera never zooms, so text stays
   * pixel-crisp under the transform.
   */
  decorate() {
    const ctx = this.render.context;
    const now = performance.now();

    Render.startViewTransform(this.render);
    ctx.save();

    const scale = this.viewScale;
    this.drawPlots(ctx, scale);
    this.drawLabels(ctx, now, scale);
    this.drawCharacter(ctx);

    ctx.restore();
    Render.endViewTransform(this.render);
  }

  drawPlots(ctx, scale) {
    const first = Math.max(0, Math.floor(this.render.bounds.min.x / PLOT_WIDTH));
    const last = Math.min(PLOT_COUNT - 1, Math.ceil(this.render.bounds.max.x / PLOT_WIDTH));

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = first; i <= last; i++) {
      const centerX = this.plotCenter(i);
      const occupied = this.contentsOf(i);
      const isHere = i === this.currentPlot;

      // Plot number, painted on the ground so it survives being built over.
      ctx.globalAlpha = isHere ? 0.5 : 0.24;
      ctx.fillStyle = isHere ? '#ffd23f' : '#ffffff';
      ctx.font = `800 ${76 * scale}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(String(i + 1), centerX, GROUND_Y + 62 * scale);
      ctx.globalAlpha = 1;

      if (!occupied.length) {
        // An empty plot has to say what to do, or people stand in it and wait.
        ctx.fillStyle = isHere ? '#ffd23f' : '#6f7d92';
        ctx.font = `700 ${(isHere ? 26 : 22) * scale}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillText(
          isHere ? 'EMPTY LOT - TYPE TO BUILD HERE' : 'EMPTY LOT',
          centerX,
          GROUND_Y - 150,
        );
      }

      if (isHere) {
        // A bracket around the plot you are standing in, so it is obvious where
        // the next thing will land.
        ctx.strokeStyle = 'rgba(255, 210, 63, 0.55)';
        ctx.lineWidth = 4 * scale;
        ctx.setLineDash([14 * scale, 12 * scale]);
        ctx.strokeRect(i * PLOT_WIDTH + 14, GROUND_Y - 560, PLOT_WIDTH - 28, 560);
        ctx.setLineDash([]);
      }
    }
  }

  drawLabels(ctx, now, scale) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const body of this.structures) {
      const { min, max } = body.bounds;
      if (max.x < this.render.bounds.min.x - 100 || min.x > this.render.bounds.max.x + 100) continue;

      const age = now - body.plugin.builtAt;
      const opacity = body.plugin.removing ? Math.max(0, (body.plugin.removeAt - now) / FADE_MS) : 1;
      const x = (min.x + max.x) / 2;
      const y = min.y - 26 * scale;

      if (age < HIGHLIGHT_MS && !body.plugin.removing) {
        const t = age / HIGHLIGHT_MS;
        ctx.globalAlpha = (1 - t) * 0.85;
        ctx.strokeStyle = '#ffd23f';
        ctx.lineWidth = 4 * scale;
        ctx.strokeRect(
          min.x - 10 - (1 - t) * 20,
          min.y - 10 - (1 - t) * 20,
          max.x - min.x + 20 + (1 - t) * 40,
          max.y - min.y + 20 + (1 - t) * 40,
        );
      }

      ctx.globalAlpha = opacity;
      ctx.font = `700 ${22 * scale}px ui-sans-serif, system-ui, sans-serif`;
      ctx.lineWidth = 6 * scale;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(8, 10, 18, 0.9)';
      ctx.fillStyle = '#ffffff';
      ctx.strokeText(body.plugin.label, x, y);
      ctx.fillText(body.plugin.label, x, y);
    }

    ctx.globalAlpha = 1;
  }

  /**
   * The walker, drawn rather than rendered as a physics box - a plain rectangle
   * with legs reads as a person from across a hallway, a plain rectangle does not.
   */
  drawCharacter(ctx) {
    const { position, plugin } = this.character;
    const { facing, grounded, walkPhase } = plugin;
    const halfHeight = CHARACTER.height / 2;
    const swing = grounded && (this.input.left || this.input.right) ? Math.sin(walkPhase) : 0;

    ctx.save();
    ctx.translate(position.x, position.y);

    // Legs
    ctx.strokeStyle = '#2b3348';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.lineTo(swing * 9, halfHeight);
    ctx.moveTo(0, 6);
    ctx.lineTo(-swing * 9, halfHeight);
    ctx.stroke();

    // Body
    ctx.fillStyle = '#ffd23f';
    roundedRect(ctx, -11, -14, 22, 26, 7);
    ctx.fill();

    // Head
    ctx.fillStyle = '#f7d9b0';
    ctx.beginPath();
    ctx.arc(0, -25, 11, 0, Math.PI * 2);
    ctx.fill();

    // Eye, so it reads as facing somewhere
    ctx.fillStyle = '#2b3348';
    ctx.beginPath();
    ctx.arc(facing * 4, -26, 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  get liveCount() {
    return this.structures.filter((s) => !s.plugin.removing).length;
  }
}

/* ---------- helpers ---------- */

function makePart(part, x, y, options) {
  switch (part.shape) {
    case 'circle':
      return Bodies.circle(x, y, part.width / 2, options);
    case 'polygon': {
      const body = Bodies.polygon(x, y, part.sides, part.width / 2, options);
      // Matter builds a polygon with its first vertex at half a step around, so
      // a triangle comes out pointing right - every roof, cone and rocket nose
      // lying on its side. Matter's edge midpoints sit at multiples of the step
      // angle, so turning by (quarter turn - one step) lands an edge flat on the
      // bottom and a point at the top, for any number of sides.
      const step = (Math.PI * 2) / part.sides;
      Body.setAngle(body, Math.PI / 2 - step);
      return body;
    }
    case 'capsule':
      return Bodies.rectangle(x, y, part.width, part.height, {
        ...options,
        chamfer: { radius: Math.min(part.width, part.height) * 0.45 },
      });
    case 'rectangle':
    default:
      return Bodies.rectangle(x, y, part.width, part.height, {
        ...options,
        chamfer: { radius: Math.min(part.width, part.height) * 0.06 },
      });
  }
}

/** Compound bodies render per part, so opacity has to be set on every part. */
function setOpacity(body, opacity) {
  for (const part of body.parts.length > 1 ? body.parts.slice(1) : body.parts) {
    part.render.opacity = opacity;
  }
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function shade(hex, amount) {
  const parts = [1, 3, 5].map((i) => {
    const value = parseInt(hex.slice(i, i + 2), 16) + amount;
    return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
  });
  return `#${parts.join('')}`;
}

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

export { Vector };
