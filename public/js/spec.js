/**
 * spec.js - the single source of truth for what the model is allowed to emit.
 *
 * Imported by BOTH the Node server and the browser, so a structure can never be
 * clamped one way on the server and another way in the park.
 *
 * A creation is a STRUCTURE: a label plus one to six parts. Parts are what let
 * "a statue of someone" read as a statue - a wide pedestal, a narrow body, a
 * head - instead of being one anonymous box. The parts are welded into a single
 * rigid body, so the statue holds its shape, stands in its plot, and can still
 * be knocked over by whatever the next person builds.
 *
 * The safety story lives here: the model's only channel to the screen is this
 * schema. Every field is validated and clamped. Nothing it returns is rendered
 * as free text except `label`, which is length-capped, character-filtered, and
 * blocklisted.
 */

export const SHAPES = ['rectangle', 'circle', 'polygon', 'capsule'];

/** What the creation depicts. The model classifies; the server decides policy. */
export const SUBJECTS = ['object', 'creature', 'character', 'real_person'];

export const MAX_PARTS = 6;

export const LIMITS = {
  width: { min: 8, max: 300, fallback: 60 },
  height: { min: 8, max: 300, fallback: 60 },
  offsetX: { min: -200, max: 200, fallback: 0 },
  offsetY: { min: -60, max: 420, fallback: 0 },
  rotation: { min: -3.15, max: 3.15, fallback: 0 },
  sides: { min: 3, max: 8, fallback: 5 },
  density: { min: 0.0006, max: 0.02, fallback: 0.003 },
  restitution: { min: 0, max: 0.85, fallback: 0.1 },
  labelMaxLength: 30,
};

/**
 * Mass band, enforced after the body exists (see park.js).
 *
 * Matter.js is a sequential-impulse solver: mass ratios beyond roughly 1000:1
 * make heavy bodies punch through light ones and tunnel out of the world. The
 * density and size ranges multiply out far past that, so we clamp the resulting
 * mass instead. A wrecking ball still topples a statue; it just stops deleting
 * it from the universe.
 */
export const MASS_BAND = { min: 4, max: 900 };

/** How much of a plot one structure may fill. */
export const STRUCTURE_MAX = { width: 460, height: 520 };

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const LABEL_ALLOWED = /[^a-zA-Z0-9 '\-.!?&]/g;

const NAMED_COLORS = {
  red: '#e5484d', orange: '#f76b15', yellow: '#ffe629', green: '#46a758',
  blue: '#3e63dd', purple: '#8e4ec6', pink: '#e93d82', brown: '#ad7f58',
  black: '#3c3c3c', white: '#f5f5f5', grey: '#8f8f8f', gray: '#8f8f8f',
  cyan: '#00b8d4', lime: '#bdee63', gold: '#ffc53d', silver: '#c8c8c8',
  bronze: '#b08d57', marble: '#e8e6e1', stone: '#9c9691',
};

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

function num(value, limit) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return limit.fallback;
  return clamp(n, limit.min, limit.max);
}

/** Deterministic pleasant colour from a string, so a bad `color` still gives variety. */
export function colorFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return hslToHex(Math.abs(hash) % 360, 62, 58);
}

export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * Lift near-black colours so they stay visible against the night sky. The
 * threshold is deliberately low - set it higher and it starts "fixing"
 * perfectly readable slates and navies, which is worse than leaving them alone.
 */
const MIN_LUMINANCE = 0.035;

function ensureVisible(hex) {
  let out = hex;
  for (let i = 0; i < 12 && relativeLuminance(out) < MIN_LUMINANCE; i++) {
    out = '#' + [1, 3, 5]
      .map((idx) => Math.min(255, Math.round(parseInt(out.slice(idx, idx + 2), 16) * 1.25 + 16)))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  }
  return out;
}

export function normalizeColor(value, seed = 'seed') {
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    if (NAMED_COLORS[raw]) return ensureVisible(NAMED_COLORS[raw]);
    const short = /^#?([0-9a-f]{3})$/.exec(raw);
    if (short) {
      const [r, g, b] = short[1].split('');
      return ensureVisible(`#${r}${r}${g}${g}${b}${b}`);
    }
    const long = /^#?([0-9a-f]{6})$/.exec(raw);
    if (long) return ensureVisible(`#${long[1]}`);
  }
  return ensureVisible(colorFromString(seed));
}

/**
 * Strip a label to plain printable text. Runs before the blocklist, so
 * punctuation-padded spellings cannot slip past the word matcher.
 */
export function sanitizeLabel(value, fallback = 'mystery exhibit') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .replace(CONTROL_CHARS, ' ')
    .replace(LABEL_ALLOWED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.labelMaxLength)
    .trim();
  return cleaned.length ? cleaned : fallback;
}

function normalizePart(raw, seed, index) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const shape = SHAPES.includes(source.shape) ? source.shape : 'rectangle';

  const part = {
    shape,
    width: Math.round(num(source.width, LIMITS.width)),
    height: Math.round(num(source.height, LIMITS.height)),
    offsetX: Math.round(num(source.offsetX, LIMITS.offsetX)),
    offsetY: Math.round(num(source.offsetY, LIMITS.offsetY)),
    rotation: num(source.rotation, LIMITS.rotation),
    sides: Math.round(num(source.sides, LIMITS.sides)),
    color: normalizeColor(source.color, `${seed}:${index}`),
  };

  // Circles and regular polygons are defined by one dimension; keep them round.
  if (shape === 'circle' || shape === 'polygon') part.height = part.width;
  return part;
}

/**
 * Coerce anything - a model tool call, a cached fallback entry, a hand-written
 * literal - into a structure that is safe to build.
 * Never throws, never returns null, always returns something buildable.
 */
export function normalizeStructure(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const label = sanitizeLabel(raw.label);

  const partsIn = Array.isArray(raw.parts) && raw.parts.length ? raw.parts : [{}];
  const parts = partsIn.slice(0, MAX_PARTS).map((part, i) => normalizePart(part, label, i));

  return fitStructure({
    label,
    subject: SUBJECTS.includes(raw.subject) ? raw.subject : 'object',
    anchored: raw.anchored === true,
    density: num(raw.density, LIMITS.density),
    restitution: num(raw.restitution, LIMITS.restitution),
    parts,
  });
}

/**
 * How much room a part actually takes up, centred on its offset.
 *
 * A regular polygon is not as tall as it is wide: drawn point-up with a flat
 * base it reaches its full radius above the centre but only the apothem below.
 * Treating it as a square box makes every pyramid hover above the ground and
 * every roof float off its walls, so measure the real thing.
 */
export function partExtents(part) {
  let width = part.width;
  let height = part.height;

  if (part.shape === 'polygon') {
    const radius = part.width / 2;
    height = radius + radius * Math.cos(Math.PI / part.sides);
  }

  // A rotated part sweeps a larger box; use the diagonal so nothing pokes out
  // of its plot once the rotation is applied.
  if (part.rotation) {
    const diagonal = Math.hypot(width, height);
    return { width: diagonal, height: diagonal };
  }
  return { width, height };
}

/** Axis-aligned bounds of a whole structure, measured from its parts. */
export function structureBounds(structure) {
  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;

  for (const part of structure.parts) {
    const reach = partExtents(part);
    minX = Math.min(minX, part.offsetX - reach.width / 2);
    maxX = Math.max(maxX, part.offsetX + reach.width / 2);
    minY = Math.min(minY, part.offsetY - reach.height / 2);
    maxY = Math.max(maxY, part.offsetY + reach.height / 2);
  }

  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Scale a structure down so it fits inside one plot, then sit it on the ground.
 *
 * The model is told the size limits, but it thinks in "a statue is about this
 * big" and routinely overshoots. Scaling the whole structure keeps proportions
 * intact - clamping each part individually would turn a tall statue into a
 * squat one.
 */
export function fitStructure(structure, max = STRUCTURE_MAX) {
  const bounds = structureBounds(structure);
  const scale = Math.min(1, max.width / bounds.width, max.height / bounds.height);

  const parts = structure.parts.map((part) => ({
    ...part,
    width: Math.max(LIMITS.width.min, Math.round(part.width * scale)),
    height: Math.max(LIMITS.height.min, Math.round(part.height * scale)),
    offsetX: Math.round(part.offsetX * scale),
    // Lift so the lowest point of the structure sits at offsetY 0 - otherwise
    // half of what the model builds starts underground.
    offsetY: Math.round((part.offsetY - bounds.minY) * scale),
  }));

  return { ...structure, parts };
}
