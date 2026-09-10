/**
 * main.js - booth wiring.
 *
 * Three rules drive everything here:
 *   1. Something always gets built. Network down, budget spent, blocked word,
 *      model confused - every path ends in an exhibit landing in a plot. Nobody
 *      at a club fair ever sees an error message.
 *   2. The station is always ready for the next person. The input refocuses and
 *      clears itself, and the park keeps moving when nobody is there.
 *   3. Walking must never fight with typing. The movement keys are live while
 *      the box is focused, because at a booth the box is always focused.
 */

import { normalizeStructure } from './spec.js';
import { pickFromPack, jitter } from './pack.js';
import { Park, PLOT_COUNT } from './park.js';

/** Give up on the server well before it gives up on the API and use the pack. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Nobody has touched the keyboard for this long: the park runs itself. */
const IDLE_AFTER_MS = 30_000;
const ATTRACT_EVERY_MS = 5000;

const els = {
  world: document.getElementById('world'),
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

const park = new Park(els.world, {
  bottomInset: () => els.controls.offsetHeight + 24,
  onPlotChange: () => refreshPlotCard(),
});

let pack = { structures: [] };
let lastInteraction = Date.now();
let inFlight = false;
let hasWalked = false;
let attractDirection = 1;

/* ---------- offline pack ---------- */

// Fetched once at startup and held in memory, so losing the network mid-fair
// costs nothing: the structures are already here.
fetch('/data/fallback.json')
  .then((res) => res.json())
  .then((data) => {
    pack = data;
  })
  .catch(() => setPill('offline pack unavailable'));

fetch('/api/status')
  .then((res) => res.json())
  .then((status) => {
    if (status.mock) setPill('demo mode - no API key');
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

/**
 * Ask the server for a structure. Falls back to the local pack on any failure,
 * including a slow response - a booth cannot wait ten seconds twice.
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
    else if (data.note === 'api unavailable') setPill('offline - using saved exhibits');

    return normalizeStructure(data.structure);
  } catch {
    // Network gone, server down, or too slow. The pack covers all three.
    setPill('offline - using saved exhibits');
    return normalizeStructure(jitter(pickFromPack(pack, prompt)));
  } finally {
    clearTimeout(timer);
  }
}

async function build(prompt) {
  if (inFlight) return;
  inFlight = true;
  els.go.disabled = true;

  // Capture the plot now: the person may keep walking while the model thinks,
  // and the exhibit belongs where they asked for it, not where they ended up.
  const plot = park.plotAt();

  try {
    park.build(await requestStructure(prompt), plot);
    refreshCounters();
    refreshPlotCard();
  } finally {
    inFlight = false;
    els.go.disabled = false;
    // Clear and refocus so the next person can just start typing.
    els.input.value = '';
    els.input.focus();
  }
}

/* ---------- readouts ---------- */

function refreshPlotCard() {
  const plot = park.plotAt();
  const contents = park.contentsOf(plot);
  els.plotNum.textContent = `PLOT ${plot + 1}`;
  els.plotState.textContent = contents.length
    ? contents.map((body) => body.plugin.label).join(' + ')
    : 'empty lot';
}

function refreshCounters() {
  const used = new Set(park.structures.filter((s) => !s.plugin.removing).map((s) => s.plugin.plot));
  els.total.textContent = String(park.totalBuilt);
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

/**
 * Walking keys work even while the text box has focus - at a booth the box is
 * always focused, so requiring a click to walk would strand people. Letters
 * still type normally; only the movement keys are intercepted, and only when
 * they are not part of a word being typed.
 */
const MOVE_KEYS = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyA: 'left',
  KeyD: 'right',
};

document.addEventListener('keydown', (event) => {
  markInteraction();

  if (event.code === 'Escape') {
    els.input.value = '';
    return;
  }

  // A and D move the character only when the box is empty. The moment someone
  // starts typing a word, the letters are letters again.
  const typing = els.input.value.length > 0;
  const isLetterKey = event.code === 'KeyA' || event.code === 'KeyD';
  const direction = MOVE_KEYS[event.code];

  if (direction && !(isLetterKey && typing)) {
    event.preventDefault();
    park.input[direction] = true;
    markWalked();
    return;
  }

  if (event.code === 'Space' && !typing) {
    event.preventDefault();
    park.input.jump = true;
    markWalked();
  }
});

document.addEventListener('keyup', (event) => {
  const direction = MOVE_KEYS[event.code];
  if (direction) park.input[direction] = false;
});

// Losing focus mid-stride would leave the character walking forever.
window.addEventListener('blur', () => {
  park.input.left = false;
  park.input.right = false;
});

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
document.addEventListener('pointermove', markInteraction);

/* ---------- attract mode ---------- */

/**
 * A still screen advertises nothing. When the station has been idle for a while
 * the character strolls the midway on its own and fills empty plots from the
 * pack, so a passer-by sees a world being built rather than a form. These are
 * free - attract mode never calls the API.
 */
function attractTick() {
  if (Date.now() - lastInteraction < IDLE_AFTER_MS || inFlight || !pack.structures.length) return;

  document.body.classList.add('idle');

  // Stroll, turning around at the ends of the park.
  const plot = park.plotAt();
  if (plot >= PLOT_COUNT - 1) attractDirection = -1;
  else if (plot <= 0) attractDirection = 1;

  park.input.left = attractDirection < 0;
  park.input.right = attractDirection > 0;
  setTimeout(() => {
    park.input.left = false;
    park.input.right = false;
  }, 2200);

  // Prefer an empty plot, so idle time fills the park out instead of piling
  // everything into one lot.
  const empty = [];
  for (let i = 0; i < PLOT_COUNT; i++) if (!park.contentsOf(i).length) empty.push(i);
  const target = empty.length ? empty[Math.floor(Math.random() * empty.length)] : plot;

  park.build(normalizeStructure(jitter(pickFromPack(pack, ''))), target);
  refreshCounters();
}

const attractTimer = setInterval(attractTick, ATTRACT_EVERY_MS);
window.addEventListener('pagehide', () => clearInterval(attractTimer));

// Web fonts can change the controls bar height after first paint, which moves
// the camera. Re-measure once everything has settled.
window.addEventListener('load', () => park.resize());

els.input.focus();
refreshCounters();
refreshPlotCard();

