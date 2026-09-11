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
 *      box is empty and types letters the moment it is not, and nothing ever
 *      grabs the pointer - a pointer-locked booth is one where the next person
 *      cannot type at all.
 */

import { normalizeStructure } from './spec.js';
import { buildFromPrompt, ATTRACT_PROMPTS } from './offline.js';
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
};

const world = new World(els.world, { onPlotChange: () => refreshPlotCard() });

/** Mirrors the server's REAL_PEOPLE setting, for the server-is-gone fallback. */
let realPeople = 'allow';
let lastInteraction = Date.now();
let inFlight = false;
let hasWalked = false;

fetch('/api/status')
  .then((res) => res.json())
  .then((status) => {
    realPeople = status.realPeople ?? 'allow';
    if (status.offline) setPill('offline mode');
  })
  .catch(() => {});

function setPill(text) {
  if (!text) {
    els.pill.hidden = true;
    return;
  }
  els.pill.textContent = text;
  els.pill.hidden = false;
}

/* ---------- building ---------- */

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

    return normalizeStructure(data.structure);
  } catch {
    // The server itself is gone. Everything needed to build is already in the
    // browser, so the booth keeps working even then.
    setPill('offline - built in this browser');
    return normalizeStructure(buildFromPrompt(prompt, { anonymise: realPeople !== 'allow' }));
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
    world.build(await requestStructure(prompt), plot);
    refreshCounters();
    refreshPlotCard();
  } finally {
    inFlight = false;
    els.go.disabled = false;
    els.input.value = '';
    els.input.focus();
  }
}

/* ---------- signs ---------- */

/**
 * Exhibit labels live in HTML on top of the canvas, repositioned every frame.
 * Text geometry inside the scene would need a font file and would go blurry at
 * distance; this stays crisp and costs almost nothing.
 */
const signNodes = new Map();

function refreshSigns() {
  const seen = new Set();

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

    node.style.transform = `translate(-50%, -100%) translate(${at.x}px, ${at.y}px)`;
    // Fade distant signs instead of letting the far end of the park turn into a
    // wall of overlapping text.
    node.style.opacity = at.depth > 0.995 ? '0' : '1';
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
}, 1000);

/* ---------- input ---------- */

function markInteraction() {
  lastInteraction = Date.now();
  document.body.classList.remove('idle');
}

const MOVE_KEYS = {
  KeyW: ['forward', 1], ArrowUp: ['forward', 1],
  KeyS: ['forward', -1], ArrowDown: ['forward', -1],
  KeyA: ['strafe', -1], ArrowLeft: ['strafe', -1],
  KeyD: ['strafe', 1], ArrowRight: ['strafe', 1],
};

const held = new Set();

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

document.addEventListener('keydown', (event) => {
  markInteraction();

  if (event.code === 'Escape') {
    els.input.value = '';
    return;
  }

  // Letters move the avatar only while the box is empty. The moment someone
  // starts typing a word, the letters are letters again - arrow keys keep
  // working either way so you can always walk.
  const typing = els.input.value.length > 0;
  const isLetter = event.code.startsWith('Key');
  const move = MOVE_KEYS[event.code];

  if (move && !(isLetter && typing)) {
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

  if (event.code === 'Space' && !typing) {
    event.preventDefault();
    world.input.jump = true;
    markWalked();
  }
});

document.addEventListener('keyup', (event) => {
  if (MOVE_KEYS[event.code]) {
    held.delete(event.code);
    applyMovement();
  }
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') world.input.run = false;
});

// Losing focus mid-stride would leave the avatar walking forever.
window.addEventListener('blur', () => {
  held.clear();
  applyMovement();
  world.input.run = false;
});

/**
 * Drag to look around. Deliberately NOT pointer lock: locking the pointer means
 * the next person at the booth cannot click the box or press a preset without
 * first working out how to escape.
 */
let dragging = null;
els.world.addEventListener('pointerdown', (event) => {
  dragging = { x: event.clientX, yaw: world.orbit };
  els.world.setPointerCapture(event.pointerId);
  markInteraction();
});
els.world.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  world.orbit = dragging.yaw - (event.clientX - dragging.x) * 0.006;
});
const endDrag = () => { dragging = null; };
els.world.addEventListener('pointerup', endDrag);
els.world.addEventListener('pointercancel', endDrag);

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

els.input.focus();
refreshCounters();
refreshPlotCard();
