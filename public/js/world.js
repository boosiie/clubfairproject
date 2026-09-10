/**
 * world.js - the shared 2D sandbox.
 *
 * The world never resets. Object #40 lands on the wreckage of object #12, and
 * that is the whole hook: people stay to watch their thing get crushed by the
 * next person's thing.
 *
 * "Never resets" still needs bounds, or hour two is 900 sleeping bodies at
 * 9fps. So the pile is capped and the oldest objects fade out from the bottom
 * of the heap. The pile stays; the frame rate stays too.
 */

import { fitToWorld, MASS_BAND } from './spec.js';

const { Engine, Render, Runner, Composite, Bodies, Body, Events, Common } = window.Matter;

const WALL_THICKNESS = 200;
/** Past this many live objects, the oldest starts fading. Tuned for a laptop driving a projector. */
const MAX_BODIES = 140;
const FADE_MS = 700;
/** Hard speed cap per step. Matter tunnels through thin walls above roughly this. */
const MAX_SPEED = 42;
/** How long a newly spawned object is highlighted so its author can find it. */
const HIGHLIGHT_MS = 4500;
/**
 * How many recent objects keep their label.
 *
 * Labelling all 140 turns the screen into unreadable text soup - and the text
 * is the expensive part of the frame. Your object is named while it is still
 * yours; after that it becomes terrain, and the pile reads as shape and colour.
 */
const LABELLED_RECENT = 12;
/** ...except genuinely big objects, which stay named because there is room. */
const ALWAYS_LABEL_SIZE = 150;

export class Sandbox {
  /**
   * @param {HTMLElement} container
   * @param {{bottomInset?: () => number}} [options] - bottomInset returns the
   *   height of the on-screen chrome at the bottom. The floor sits above it, so
   *   the pile builds in clear space instead of behind the input box. Passed as
   *   a function because the composer wraps to two rows on narrow screens.
   */
  constructor(container, options = {}) {
    this.container = container;
    this.bottomInset = options.bottomInset ?? (() => 0);
    this.spawned = [];
    this.totalSummoned = 0;

    this.engine = Engine.create({
      // Sleeping is what makes a 140-body pile cheap: settled objects stop
      // being integrated until something hits them.
      enableSleeping: true,
    });
    this.engine.gravity.y = 1.1;
    // A few extra solver iterations keep tall piles from jittering apart.
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
        showSleeping: false,
      },
    });

    this.buildWalls(width, height);

    Events.on(this.engine, 'afterUpdate', () => this.tick());
    Events.on(this.render, 'afterRender', () => this.drawLabels());

    Render.run(this.render);
    this.runner = Runner.create();
    Runner.run(this.runner, this.engine);

    window.addEventListener('resize', () => this.resize());
  }

  measure() {
    const width = Math.max(320, this.container.clientWidth);
    const height = Math.max(240, this.container.clientHeight);
    // Keep at least half the screen playable however tall the chrome gets.
    const inset = Math.min(this.bottomInset(), height * 0.5);
    return { width, height, floorY: height - inset, playHeight: height - inset };
  }

  buildWalls(width, height) {
    const style = { fillStyle: '#1b2030', strokeStyle: '#2b3348', lineWidth: 2 };
    const half = WALL_THICKNESS / 2;
    const { floorY } = this.measure();

    this.walls = [
      // The floor rests above the bottom chrome. Objects landing behind the
      // input box is the difference between a demo people watch and one they
      // squint at.
      Bodies.rectangle(width / 2, floorY + half, width * 3, WALL_THICKNESS, {
        isStatic: true,
        friction: 0.9,
        render: style,
        label: '__floor',
      }),
      Bodies.rectangle(-half + 8, height / 2, WALL_THICKNESS, height * 4, {
        isStatic: true,
        render: style,
        label: '__wall',
      }),
      Bodies.rectangle(width + half - 8, height / 2, WALL_THICKNESS, height * 4, {
        isStatic: true,
        render: style,
        label: '__wall',
      }),
    ];

    Composite.add(this.engine.world, this.walls);
  }

  resize() {
    const { width, height } = this.measure();
    this.render.canvas.width = width;
    this.render.canvas.height = height;
    this.render.options.width = width;
    this.render.options.height = height;
    Render.setPixelRatio(this.render, 'auto');

    Composite.remove(this.engine.world, this.walls);
    this.buildWalls(width, height);
  }

  /**
   * Build a body from a validated spec and drop it in from above.
   *
   * @param {object} spec - already through normalizeSpec()
   * @returns {object} the created body
   */
  spawn(spec) {
    const { width, playHeight } = this.measure();
    const fitted = fitToWorld(spec, playHeight);

    const options = {
      density: fitted.density,
      restitution: fitted.restitution,
      friction: fitted.friction,
      frictionAir: 0.005,
      sleepThreshold: 90,
      render: {
        fillStyle: fitted.color,
        strokeStyle: shade(fitted.color, -28),
        lineWidth: 2,
      },
    };

    // Drop into the middle 70% so nothing spawns wedged into a wall.
    const x = width * 0.15 + Math.random() * width * 0.7;
    const y = -fitted.height - 40;
    const body = buildBody(fitted, x, y, options);

    // Mass clamp. Density x area can span ~17000:1 across the allowed ranges,
    // and beyond roughly 1000:1 the solver lets heavy bodies punch straight
    // through light ones. Clamping mass keeps "anvil crushes balloon" looking
    // like a crush instead of a deletion.
    if (body.mass > MASS_BAND.max) Body.setMass(body, MASS_BAND.max);
    else if (body.mass < MASS_BAND.min) Body.setMass(body, MASS_BAND.min);

    // Spin scales down with size. A small ball tumbling on the way down looks
    // lively; a trampoline doing the same lands on its end, which is neither
    // funny nor what the person asked for.
    const spinScale = Math.min(1, 70 / Math.max(fitted.width, fitted.height));
    Body.setAngle(body, (Math.random() - 0.5) * 0.6 * spinScale);
    Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.09 * spinScale);

    body.plugin = {
      label: fitted.label,
      spawnedAt: performance.now(),
      index: ++this.totalSummoned,
      removing: false,
    };

    Composite.add(this.engine.world, body);
    this.spawned.push(body);
    this.cull();

    return body;
  }

  /** Fade out the oldest objects once the pile exceeds the cap. */
  cull() {
    const live = this.spawned.filter((b) => !b.plugin.removing);
    const excess = live.length - MAX_BODIES;
    for (let i = 0; i < excess; i++) {
      const victim = live[i];
      victim.plugin.removing = true;
      victim.plugin.removeAt = performance.now() + FADE_MS;
      // Collide with nothing from here on. The oldest objects are at the bottom
      // of the heap, so a fading body drops away through the floor and the pile
      // settles into the gap - the churn that keeps a never-resetting world
      // from just growing upward forever.
      victim.collisionFilter = { ...victim.collisionFilter, mask: 0 };
    }
  }

  tick() {
    const now = performance.now();

    for (let i = this.spawned.length - 1; i >= 0; i--) {
      const body = this.spawned[i];

      // Speed cap: cheaper and more reliable than raising solver iterations
      // for the one anvil someone gave a restitution of 0.9.
      if (body.speed > MAX_SPEED) {
        const scale = MAX_SPEED / body.speed;
        Body.setVelocity(body, { x: body.velocity.x * scale, y: body.velocity.y * scale });
      }

      if (body.plugin.removing) {
        const remaining = Math.max(0, body.plugin.removeAt - now);
        body.render.opacity = remaining / FADE_MS;
        if (remaining <= 0) {
          Composite.remove(this.engine.world, body);
          this.spawned.splice(i, 1);
        }
        continue;
      }

      // Anything that escapes the world is gone for good, not tracked forever.
      const { width, height } = this.render.options;
      if (body.position.y > height + 800 || body.position.x < -600 || body.position.x > width + 600) {
        Composite.remove(this.engine.world, body);
        this.spawned.splice(i, 1);
      }
    }
  }

  /**
   * Labels are drawn upright rather than rotated with the body. A pile of
   * tumbling rotated text is unreadable from across a hallway.
   */
  drawLabels() {
    const ctx = this.render.context;
    const now = performance.now();
    const recent = new Set(this.spawned.slice(-LABELLED_RECENT));

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const body of this.spawned) {
      const { min, max } = body.bounds;
      const size = Math.min(max.x - min.x, max.y - min.y);

      // Recent objects and large ones get names; the rest of the pile does not.
      if (!recent.has(body) && size < ALWAYS_LABEL_SIZE) continue;
      // Text on a small object is illegible and covers the object itself.
      if (size < 30) continue;

      const age = now - body.plugin.spawnedAt;
      const isNew = age < HIGHLIGHT_MS;
      const fontSize = Math.max(11, Math.min(26, size * 0.22));
      const opacity = body.render.opacity ?? 1;

      if (isNew) {
        // A ring that shrinks onto the new object, so its author can pick it
        // out of the pile immediately.
        const t = age / HIGHLIGHT_MS;
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(body.position.x, body.position.y, size * 0.6 + (1 - t) * 42, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.globalAlpha = opacity;
      ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.lineWidth = Math.max(3, fontSize * 0.28);
      ctx.strokeStyle = 'rgba(8, 10, 18, 0.85)';
      ctx.fillStyle = '#ffffff';
      ctx.lineJoin = 'round';
      ctx.strokeText(body.plugin.label, body.position.x, body.position.y);
      ctx.fillText(body.plugin.label, body.position.x, body.position.y);
    }

    ctx.restore();
  }

  get liveCount() {
    return this.spawned.filter((b) => !b.plugin.removing).length;
  }
}

function buildBody(spec, x, y, options) {
  switch (spec.shape) {
    case 'circle':
      return Bodies.circle(x, y, spec.width / 2, options);
    case 'polygon':
      return Bodies.polygon(x, y, spec.sides, spec.width / 2, options);
    case 'capsule':
      return Bodies.rectangle(x, y, spec.width, spec.height, {
        ...options,
        chamfer: { radius: Math.min(spec.width, spec.height) * 0.45 },
      });
    case 'rectangle':
    default:
      return Bodies.rectangle(x, y, spec.width, spec.height, {
        ...options,
        chamfer: { radius: Math.min(spec.width, spec.height) * 0.08 },
      });
  }
}

/** Darken or lighten a #rrggbb colour for the body outline. */
function shade(hex, amount) {
  const parts = [1, 3, 5].map((i) => {
    const value = parseInt(hex.slice(i, i + 2), 16) + amount;
    return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
  });
  return `#${parts.join('')}`;
}

export { Common };
