/**
 * main.js - booth wiring.
 *
 * Two rules drive everything here:
 *   1. Something always falls. Network down, budget spent, blocked word, model
 *      confused - every path ends in an object hitting the pile. Nobody at a
 *      club fair ever sees an error message.
 *   2. The station is always ready for the next person. The input refocuses and
 *      clears itself, and the screen keeps moving when nobody is there.
 */

import { normalizeSpec } from './spec.js';
import { pickFromPack, jitter } from './pack.js';
import { Sandbox } from './world.js';

/** Give up on the server well before it gives up on the API and use the pack. */
const REQUEST_TIMEOUT_MS = 8000;
/** Nobody has touched the keyboard for this long: start dropping things on our own. */
const IDLE_AFTER_MS = 25_000;
const ATTRACT_EVERY_MS = 6000;
const FEED_LENGTH = 6;

const els = {
  world: document.getElementById('world'),
  form: document.getElementById('composer'),
  input: document.getElementById('prompt'),
  go: document.getElementById('go'),
  presets: document.getElementById('presets'),
  feedList: document.getElementById('feed-list'),
  total: document.getElementById('stat-total'),
  live: document.getElementById('stat-live'),
  pill: document.getElementById('pill'),
};

const sandbox = new Sandbox(els.world, {
  // Keep the floor above the composer so the pile is never hidden behind the
  // controls - watching your thing land is the entire payoff.
  bottomInset: () => document.querySelector('.hud--bottom').offsetHeight + 12,
});

let pack = { objects: [] };
let lastInteraction = Date.now();
let attractTimer = null;
let inFlight = false;

/* ---------- offline pack ---------- */

// Fetched once at startup and held in memory, so losing the network mid-fair
// costs nothing: the objects are already here.
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

/* ---------- status pill ---------- */

function setPill(text) {
  if (!text) {
    els.pill.hidden = true;
    return;
  }
  els.pill.textContent = text;
  els.pill.hidden = false;
}

/* ---------- spawning ---------- */

/**
 * Ask the server for an object. Falls back to the local pack on any failure,
 * including a slow response - a booth cannot wait eight seconds twice.
 */
async function requestSpec(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('/api/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const data = await res.json();

    if (data.source === 'model') setPill(null);
    else if (data.note === 'api unavailable') setPill('offline - using cached objects');

    return { spec: normalizeSpec(data.spec), source: data.source };
  } catch {
    // Network gone, server down, or too slow. The pack covers all three.
    setPill('offline - using cached objects');
    return { spec: normalizeSpec(jitter(pickFromPack(pack, prompt))), source: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

function drop(spec, source) {
  sandbox.spawn(spec);
  addToFeed(spec, source);
  updateCounters();
}

async function summon(prompt) {
  if (inFlight) return;
  inFlight = true;
  els.go.disabled = true;

  try {
    const { spec, source } = await requestSpec(prompt);
    drop(spec, source);
  } finally {
    inFlight = false;
    els.go.disabled = false;
    // Clear and refocus so the next person can just start typing.
    els.input.value = '';
    els.input.focus();
  }
}

/* ---------- feed and counters ---------- */

function addToFeed(spec, source) {
  const item = document.createElement('li');

  const swatch = document.createElement('span');
  swatch.className = 'feed__swatch';
  swatch.style.background = spec.color;

  const name = document.createElement('span');
  // textContent, never innerHTML - the label is short and screened, but it is
  // still the one string on this page that came from a stranger via a model.
  name.textContent = spec.label;

  item.append(swatch, name);
  if (source === 'offline' || source === 'fallback') item.title = 'from the offline pack';

  els.feedList.prepend(item);
  while (els.feedList.children.length > FEED_LENGTH) els.feedList.lastElementChild.remove();
}

function updateCounters() {
  els.total.textContent = String(sandbox.totalSummoned);
  els.live.textContent = String(sandbox.liveCount);
}

setInterval(updateCounters, 1000);

/* ---------- input ---------- */

function markInteraction() {
  lastInteraction = Date.now();
  document.body.classList.remove('idle');
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  markInteraction();
  const prompt = els.input.value.trim();
  if (prompt) summon(prompt);
});

els.presets.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-prompt]');
  if (!button) return;
  markInteraction();
  summon(button.dataset.prompt);
});

document.addEventListener('keydown', (event) => {
  markInteraction();

  if (event.key === 'Escape') {
    els.input.value = '';
    els.input.blur();
    return;
  }
  if (event.key === 'f' && event.target !== els.input) {
    toggleFullscreen();
    return;
  }
  // Any typing anywhere lands in the box - people walk up and start typing
  // without clicking first.
  if (event.key.length === 1 && event.target !== els.input) {
    els.input.focus();
  }
});

document.addEventListener('pointerdown', markInteraction);
document.addEventListener('pointermove', markInteraction);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ---------- attract mode ---------- */

/**
 * A still screen advertises nothing. When the station has been idle for a while
 * the sandbox keeps dropping objects from the pack, so a passer-by sees motion
 * rather than a form. These are free - they never touch the API.
 */
function attractTick() {
  const idle = Date.now() - lastInteraction > IDLE_AFTER_MS;
  if (!idle || inFlight || !pack.objects.length) return;

  document.body.classList.add('idle');
  drop(normalizeSpec(jitter(pickFromPack(pack, ''))), 'offline');
}

attractTimer = setInterval(attractTick, ATTRACT_EVERY_MS);
window.addEventListener('pagehide', () => clearInterval(attractTimer));

// Web fonts can change the composer's height after first paint, which moves the
// floor. Re-measure once everything has settled.
window.addEventListener('load', () => sandbox.resize());

els.input.focus();
updateCounters();
