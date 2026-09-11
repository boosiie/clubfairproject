/**
 * main.js - booth wiring.
 *
 * Three rules drive everything here:
 *   1. Something always gets built. Network down, budget spent, blocked word,
 *      model confused - every path ends in an exhibit landing in a plot. Nobody
 *      at a club fair ever sees an error message.
 *   2. The station is always ready for the next person. The input refocuses and
 *      clears itself, and the park keeps moving when nobody is there.
 *   3. Walking must never fight with typing. WASD drives the avatar while the
 *      box is empty and types letters the moment it is not. Pointer lock is
 *      offered for real mouse look but never sticks: Escape releases it, the
 *      prompt keeps keyboard focus throughout, and an idle station hands the
 *      mouse back on its own.
 */

import { normalizeStructure } from './spec.js';
import { buildFromPrompt, buildNonsenseBlock, looksLikeNonsense, ATTRACT_PROMPTS } from './offline.js';
import { World, PLOT_COUNT } from './world.js';

/** Give up on the server well before it gives up on the API and build locally. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Nobody has touched the keyboard for this long: the park runs itself. */
const IDLE_AFTER_MS = 30_000;
const ATTRACT_EVERY_MS = 6000;

const els = {
  world: document.getElementById('world'),
  signs: document.getElementById('signs'),
  form: document.getElementById('composer'),
  input: document.getElementById('prompt'),
  go: document.getElementById('go'),
  presets: document.getElementById('presets'),
  plotNum: document.getElementById('plot-num'),
  plotState: document.getElementById('plot-state'),
  total: document.getElementById('stat-total'),
  plots: document.getElementById('stat-plots'),
  controls: document.getElementById('controls'),
  pill: document.getElementById('pill'),
  buildtag: document.getElementById('buildtag'),
  header: document.getElementById('topbar'),
  stage: document.getElementById('stage'),
  clear: document.getElementById('clear'),
  plotcard: document.getElementById('plotcard'),
};

/**
 * Starting the 3D world is the one thing here that can fail for reasons that
 * have nothing to do with this code: a laptop with hardware acceleration
 * switched off, a driver on the browser's blocklist, a locked-down school
 * image. Without this guard that failure is silent - the module throws, the
 * canvas never appears, and you are left looking at a blue page with a working
 * text box and no world, which looks exactly like "it isn't 3D".
 */
let world;
try {
  world = new World(els.world, { onPlotChange: () => refreshPlotCard() });
} catch (error) {
  showStartupFailure(error);
  throw error;
}

function showStartupFailure(error) {
  const panel = document.createElement('div');
  panel.className = 'startup-error';
  panel.innerHTML = `
    <h2>The 3D view could not start</h2>
    <p>This browser could not open WebGL, so there is nothing to walk around in.
       Everything else about the booth is fine - it is the graphics that are blocked.</p>
    <ol>
      <li>In Chrome, open <b>Settings &rarr; System</b> and turn on
          <b>Use graphics acceleration when available</b>, then restart Chrome.</li>
      <li>Check <b>chrome://gpu</b> - if WebGL says "Disabled" or "Software only",
          the graphics driver needs updating.</li>
      <li>Failing that, try a different browser on the same laptop.</li>
    </ol>
    <p class="startup-error__detail"></p>
  `;
  // textContent for the error itself - it is the one part that is not ours.
  panel.querySelector('.startup-error__detail').textContent = String(error?.message ?? error);
  document.body.appendChild(panel);
}

/** Mirrors the server's REAL_PEOPLE setting, for the server-is-gone fallback. */
let realPeople = 'allow';
let lastInteraction = Date.now();
let inFlight = false;
let hasWalked = false;

fetch('/api/status')
  .then((res) => res.json())
  .then((status) => {
    realPeople = status.realPeople ?? 'allow';
    // So 'which build am I actually looking at' has an answer that does not
    // depend on squinting at the screen.
    console.info(`[park] v${status.version} - ${status.renderer} first-person - ${status.offline ? 'offline' : status.model}`);
    els.buildtag.textContent = `3D first-person - v${status.version}`;
    if (status.offline) setPill('offline mode');
  })
  .catch(() => { els.buildtag.textContent = '3D first-person - server unreachable'; });

function setPill(text) {
  if (!text) {
    els.pill.hidden = true;
    return;
  }
  els.pill.textContent = text;
  els.pill.hidden = false;
}

/* ---------- building ---------- */

/**
 * What to build and, for a prompt that is not words, what to print on it.
 *
 * The meme text rides alongside the structure rather than inside it. The
 * structure is the model's channel to the screen and every field in it is
 * clamped by the schema; keeping this out of there means no model response can
 * ever ask the park to print something.
 *
 * @returns {Promise<{structure: object, meme: string|null}>}
 */
async function requestStructure(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const data = await res.json();

    if (data.source === 'model') setPill(null);
    else if (data.note === 'api unavailable') setPill('offline - built on this laptop');

    return { structure: normalizeStructure(data.structure), meme: data.meme ?? null };
  } catch {
    // The server itself is gone. Everything needed to build is already in the
    // browser, so the booth keeps working even then - including this.
    setPill('offline - built in this browser');
    if (looksLikeNonsense(prompt)) {
      const block = normalizeStructure(buildNonsenseBlock(prompt));
      return { structure: block, meme: block.label };
    }
    return {
      structure: normalizeStructure(buildFromPrompt(prompt, { anonymise: realPeople !== 'allow' })),
      meme: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function build(prompt) {
  if (inFlight) return;

  const plot = world.plotAt();
  if (plot < 0) {
    // Standing on the road. Say so rather than silently swallowing the build -
    // this is the one rule of the place and it has to be obvious.
    flashPlotCard();
    return;
  }

  inFlight = true;
  els.go.disabled = true;

  try {
    const { structure, meme } = await requestStructure(prompt);
    const exhibit = world.build(structure, plot, { meme });
    // Turn to watch it land, or in first person you would never see it.
    if (exhibit) world.faceTowards(exhibit.group.position.x, exhibit.group.position.z);
    refreshCounters();
    refreshPlotCard();
  } finally {
    inFlight = false;
    els.go.disabled = false;
    els.input.value = '';
    // Back to walking mode, with nothing left holding focus. You have just
    // built something and the view has turned to watch it land - the next thing
    // anyone wants is to walk over to it, not to type again, and Enter puts you
    // back in the box. Blurring whatever was clicked matters as much as the
    // box: a preset button that keeps focus turns the next Space - which is
    // jump - into a second press of itself.
    document.activeElement?.blur();
  }
}

/* ---------- signs ---------- */

/**
 * Exhibit labels live in HTML on top of the canvas, repositioned every frame.
 * Text geometry inside the scene would need a font file and would go blurry at
 * distance; this stays crisp and costs almost nothing.
 */
const signNodes = new Map();

/**
 * Roughly how much room one sign takes. Approximate on purpose: measuring the
 * real node means reading layout in the same frame we write transforms, which
 * forces a reflow on every sign on every frame. Labels are capped at thirty
 * characters, so a fixed box is close enough and costs nothing.
 */
const SIGN_WIDTH = 210;
const SIGN_HEIGHT = 34;

/**
 * Where the chrome is, so signs can be kept off it.
 *
 * Measured on a timer rather than per frame, for the same reflow reason - the
 * header and the stage only change size when the window does or when the plot
 * card's text changes, neither of which is a per-frame event.
 */
let chromeBoxes = [];

function measureChrome() {
  chromeBoxes = [els.header, els.stage, els.controls]
    .filter(Boolean)
    .map((node) => node.getBoundingClientRect());
}

function onChrome(x, y) {
  // The sign hangs upward from its anchor point, hence the -SIGN_HEIGHT.
  const half = SIGN_WIDTH / 2;
  return chromeBoxes.some((box) => x + half > box.left && x - half < box.right
    && y > box.top && y - SIGN_HEIGHT < box.bottom);
}

window.addEventListener('resize', measureChrome);
measureChrome();

function refreshSigns() {
  const seen = new Set();

  // Gather first, place second. Placing needs to know about the other signs,
  // and the nearest one has to be the one that keeps its spot.
  const placing = [];
  for (const exhibit of world.exhibits) {
    if (exhibit.removing) continue;
    const at = world.projectLabel(exhibit);
    if (!at) continue;

    seen.add(exhibit);
    let node = signNodes.get(exhibit);
    if (!node) {
      node = document.createElement('div');
      node.className = 'sign';
      // textContent, never innerHTML - this is the one string on the page that
      // came from a stranger by way of a model.
      node.textContent = exhibit.label;
      els.signs.appendChild(node);
      signNodes.set(exhibit, node);
    }
    placing.push({ node, at });
  }

  placing.sort((a, b) => a.at.depth - b.at.depth);

  const placed = [];
  for (const { node, at } of placing) {
    let y = at.y;

    // Two exhibits in one plot put their signs on top of each other. Walk this
    // one upwards until it is clear of everything already placed - nearest
    // first, so the sign for the thing you are standing next to stays put and
    // the ones behind it move out of its way.
    for (let i = 0; i < placed.length + 1; i++) {
      const clash = placed.find((other) => Math.abs(other.x - at.x) < SIGN_WIDTH
        && Math.abs(other.y - y) < SIGN_HEIGHT);
      if (!clash) break;
      y = clash.y - SIGN_HEIGHT;
    }

    node.style.transform = `translate(-50%, -100%) translate(${at.x}px, ${y}px)`;
    // Hidden rather than moved when it lands on the chrome: there is nowhere
    // else for it to go, and a label printed across the club's name or the box
    // people are meant to type into makes the screen look broken from the far
    // side of a gym. Distant signs go too, or the far end of the park turns
    // into a wall of overlapping text.
    const hidden = at.depth > 0.995 || onChrome(at.x, y);
    node.style.opacity = hidden ? '0' : '1';
    if (!hidden) placed.push({ x: at.x, y });
  }

  for (const [exhibit, node] of signNodes) {
    if (!seen.has(exhibit)) {
      node.remove();
      signNodes.delete(exhibit);
    }
  }

  requestAnimationFrame(refreshSigns);
}
requestAnimationFrame(refreshSigns);

/* ---------- readouts ---------- */

function refreshPlotCard() {
  const plot = world.plotAt();
  if (plot < 0) {
    els.plotNum.textContent = 'THE ROAD';
    els.plotState.textContent = 'walk onto a plot to build';
    return;
  }
  const contents = world.contentsOf(plot);
  els.plotNum.textContent = `PLOT ${plot + 1}`;
  els.plotState.textContent = contents.length
    ? contents.map((e) => e.label).join(' + ')
    : 'empty lot';
}

function flashPlotCard() {
  els.plotNum.textContent = 'THE ROAD';
  els.plotState.textContent = 'walk onto a plot first';
  document.getElementById('plotcard').classList.add('plotcard--nudge');
  setTimeout(() => document.getElementById('plotcard').classList.remove('plotcard--nudge'), 600);
}

function refreshCounters() {
  const used = new Set(world.exhibits.filter((e) => !e.removing).map((e) => e.plot));
  els.total.textContent = String(world.totalBuilt);
  els.plots.innerHTML = `${used.size}<span class="counters__of">/${PLOT_COUNT}</span>`;
}

setInterval(() => {
  refreshCounters();
  refreshPlotCard();
  // The plot card grows and shrinks with what is in the plot, which moves the
  // bottom of the chrome that signs have to stay out of.
  measureChrome();
}, 1000);

/* ---------- clearing the park ---------- */

/** How long the clear button stays armed before it forgets it was asked. */
const CLEAR_ARMED_MS = 4000;
let clearTimer = null;

function disarmClear() {
  clearTimeout(clearTimer);
  clearTimer = null;
  els.clear.classList.remove('clear--armed');
  els.clear.textContent = 'clear park';
}

els.clear.addEventListener('click', () => {
  markInteraction();

  if (clearTimer) {
    disarmClear();
    world.clearAll();
    refreshCounters();
    refreshPlotCard();
  } else {
    const live = world.liveCount;
    if (!live) return;
    // Two presses. One stray click on a booth screen would otherwise wipe out
    // forty people's builds, with no warning and nothing to undo it with.
    els.clear.classList.add('clear--armed');
    els.clear.textContent = `clear all ${live}?`;
    clearTimer = setTimeout(disarmClear, CLEAR_ARMED_MS);
  }

  // Or the button keeps focus and the next Space - which is jump - presses it.
  els.clear.blur();
});

/* ---------- input ---------- */

function markInteraction() {
  lastInteraction = Date.now();
  document.body.classList.remove('idle');
}

// Arrows turn rather than move - in first person, looking is the thing you do
// constantly, and W/A/S/D already covers walking.
const MOVE_KEYS = {
  KeyW: ['forward', 1],
  KeyS: ['forward', -1],
  KeyA: ['strafe', -1],
  KeyD: ['strafe', 1],
};

const held = new Set();

/**
 * The keyboard belongs to exactly one of two modes, never to both.
 *
 * Sharing it does not work, and the attempt to share it is why you could not
 * type the word "dragon": the D arrived while the box was still empty, so it
 * was read as a movement key, swallowed before the box ever saw it, and you
 * strafed right instead of typing a letter. Any rule based on what is already
 * in the box has that hole at the first keystroke, and the first keystroke is
 * the one that matters.
 *
 * So: focus in the box means every key is text. Focus anywhere else means every
 * key drives the walker. Enter crosses between them in both directions, and
 * Escape always gets you out - at a booth there has to be one key that works
 * from any state a visitor has managed to reach.
 */
function isTyping() {
  return document.activeElement === els.input;
}

/** Stop dead. A key held across a mode change never gets its keyup. */
function stopMoving() {
  held.clear();
  turning.clear();
  world.input.run = false;
  world.input.jump = false;
  applyMovement();
}

function applyMovement() {
  let forward = 0;
  let strafe = 0;
  for (const code of held) {
    const [axis, sign] = MOVE_KEYS[code];
    if (axis === 'forward') forward += sign;
    else strafe += sign;
  }
  world.input.forward = Math.sign(forward);
  world.input.strafe = Math.sign(strafe);
}

// Every route into the box goes through focus - clicking it, tabbing to it, or
// being sent there by Enter - so the mode is switched here rather than at each
// of those call sites, and cannot get out of step with where focus actually is.
els.input.addEventListener('focus', () => {
  stopMoving();
  releasePointer();
  document.body.classList.add('typing');
});

els.input.addEventListener('blur', () => document.body.classList.remove('typing'));

document.addEventListener('keydown', (event) => {
  markInteraction();

  if (event.code === 'Escape') {
    els.input.value = '';
    els.input.blur();
    releasePointer();
    return;
  }

  // Typing mode owns the whole keyboard: no walking, no jumping, no view
  // toggle. This is the fix - nothing below this line runs while the box has
  // focus, so W, A, S and D are letters like any others.
  if (isTyping()) return;

  // Enter is the way in. The form's submit handler is the way back out.
  if (event.code === 'Enter' || event.code === 'NumpadEnter') {
    event.preventDefault();
    els.input.focus();
    return;
  }

  if (TURN_KEYS[event.code]) {
    event.preventDefault();
    turning.add(event.code);
    markWalked();
    return;
  }

  // V swaps between standing in the park and watching yourself walk through it.
  if (event.code === 'KeyV') {
    event.preventDefault();
    setViewLabel(world.toggleView());
    return;
  }

  if (MOVE_KEYS[event.code]) {
    event.preventDefault();
    held.add(event.code);
    applyMovement();
    markWalked();
    return;
  }

  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
    world.input.run = true;
    return;
  }

  if (event.code === 'Space') {
    event.preventDefault();
    world.input.jump = true;
    markWalked();
  }
});

document.addEventListener('keyup', (event) => {
  turning.delete(event.code);
  if (MOVE_KEYS[event.code]) {
    held.delete(event.code);
    applyMovement();
  }
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') world.input.run = false;
});

// Losing focus mid-stride would leave the avatar walking forever.
window.addEventListener('blur', stopMoving);

function setViewLabel(firstPerson) {
  document.getElementById('view-mode').textContent = firstPerson ? 'first person' : 'third person';
}

/* ---------- looking around ---------- */

const LOOK_SENSITIVITY = 0.0024;

/**
 * Two ways to look, because first person needs proper mouse look and a booth
 * needs to never strand anybody.
 *
 * Dragging always works and needs no explanation. Clicking the world grabs the
 * pointer for real mouse look, which is the only way first person feels right -
 * but a pointer that stays grabbed is exactly how the next person walks up and
 * finds they cannot click anything. So: Escape releases it, the keyboard is
 * untouched by the lock (the prompt keeps focus, so typing still works while
 * looking around), and attract mode releases it on its own after the station
 * has been idle. An abandoned booth always returns to a clickable state.
 */
function releasePointer() {
  if (document.pointerLockElement) document.exitPointerLock();
}

/**
 * How far the pointer may travel between press and release and still count as
 * a click rather than a drag. Without this, every drag-to-look ends in a click
 * event and silently grabs the pointer - so looking around once would leave the
 * next person unable to press a button.
 */
const CLICK_SLOP_PX = 5;
let pressedAt = null;

els.world.addEventListener('click', () => {
  if (document.pointerLockElement || !pressedAt) return;
  if (pressedAt.moved > CLICK_SLOP_PX) return;
  els.world.requestPointerLock?.();
});

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === els.world;
  document.body.classList.toggle('locked', locked);
  // Focus is deliberately NOT put back in the box here. Grabbing the pointer
  // is someone saying they want to look around, and re-focusing the box would
  // drop them into typing mode - where the keys they are about to press to walk
  // do nothing at all.
});

document.addEventListener('mousemove', (event) => {
  if (document.pointerLockElement !== els.world) return;
  world.look(event.movementX * LOOK_SENSITIVITY, event.movementY * LOOK_SENSITIVITY);
  markInteraction();
});

let dragging = null;
els.world.addEventListener('pointerdown', (event) => {
  pressedAt = { x: event.clientX, y: event.clientY, moved: 0 };
  if (document.pointerLockElement) return;
  dragging = { x: event.clientX, y: event.clientY };
  els.world.setPointerCapture(event.pointerId);
  markInteraction();
});
els.world.addEventListener('pointermove', (event) => {
  if (pressedAt) {
    pressedAt.moved = Math.max(
      pressedAt.moved,
      Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y),
    );
  }
  if (!dragging) return;
  world.look((event.clientX - dragging.x) * LOOK_SENSITIVITY, (event.clientY - dragging.y) * LOOK_SENSITIVITY);
  dragging = { x: event.clientX, y: event.clientY };
});
const endDrag = () => { dragging = null; };
els.world.addEventListener('pointerup', endDrag);
els.world.addEventListener('pointercancel', endDrag);

/** Arrow keys turn, for anyone who will not touch the mouse at all. */
const TURN_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const turning = new Set();

setInterval(() => {
  for (const code of turning) {
    const [yaw, pitch] = TURN_KEYS[code];
    world.look(yaw * 0.045, pitch * 0.03);
  }
}, 16);

function markWalked() {
  if (hasWalked) return;
  hasWalked = true;
  els.controls.classList.add('learned');
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  markInteraction();
  const prompt = els.input.value.trim();
  if (prompt) build(prompt);
});

els.presets.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-prompt]');
  if (!button) return;
  markInteraction();
  build(button.dataset.prompt);
});

document.addEventListener('pointerdown', markInteraction);

/* ---------- attract mode ---------- */

/**
 * A still screen advertises nothing. When the station has been idle the park
 * fills its own empty plots, so a passer-by sees a world being built rather
 * than a form. These are free - attract mode never calls the API.
 */
let attractIndex = 0;

function attractTick() {
  if (Date.now() - lastInteraction < IDLE_AFTER_MS || inFlight) return;
  document.body.classList.add('idle');
  // Hand the mouse and the keyboard back, so whoever walks up next finds a
  // station that can be clicked and walked rather than one half-way through
  // somebody else's sentence.
  releasePointer();
  els.input.blur();

  const empty = [];
  for (let i = 0; i < PLOT_COUNT; i++) if (!world.contentsOf(i).length) empty.push(i);
  if (!empty.length) return;

  const prompt = ATTRACT_PROMPTS[attractIndex++ % ATTRACT_PROMPTS.length];
  world.build(
    normalizeStructure(buildFromPrompt(prompt, { anonymise: realPeople !== 'allow' })),
    empty[Math.floor(Math.random() * empty.length)],
  );
  refreshCounters();
}

const attractTimer = setInterval(attractTick, ATTRACT_EVERY_MS);
window.addEventListener('pagehide', () => clearInterval(attractTimer));

window.addEventListener('load', () => world.resize());

// Opens in walking mode, not typing mode. You spawn on the road and have to
// stand on a plot before you can build anything, so walking is the first thing
// anybody needs - and the box says so until someone presses Enter.
refreshCounters();
refreshPlotCard();

