/**
 * spec.js - the single source of truth for what the model is allowed to emit.
 *
 * Imported by BOTH the Node server and the browser, so a structure can never be
 * clamped one way on the server and another way in the world.
 *
 * A creation is a VOXEL SCULPTURE: a label, a small colour palette, and a few
 * hundred cubes on a fixed grid. The model paints the cubes directly, layer by
 * layer. Everything that does not come from the model - the offline generator,
 * the nonsense block, the redacted block - still describes itself in primitive
 * solids, and those are rasterised into the very same grid, so there is one
 * thing to render and no second tier of quality when the wifi drops.
 *
 * Primitive parts therefore survive here as an INTERMEDIATE form, not as the
 * output. Everything that leaves this file carries `palette` and `voxels`.
 *
 * The safety story lives here: the model's only channel to the screen is this
 * schema. Every field is validated and clamped. Nothing it returns is rendered
 * as free text except `label`, which is length-capped, character-filtered, and
 * blocklisted.
 *
 * Units are metres. A person is about 1.8 tall.
 */

import {
  GRID, VOXEL, MAX_PALETTE,
  cellsFromLayers, cellsFromParts, placeCells, voxelBounds,
} from './voxel.js';

export { GRID, VOXEL, MAX_PALETTE };

export const SHAPES = ['box', 'sphere', 'cylinder', 'cone'];

/** What the creation depicts. The model classifies; the server decides policy. */
export const SUBJECTS = ['object', 'creature', 'character', 'real_person'];

export const MAX_PARTS = 8;

export const LIMITS = {
  width: { min: 0.1, max: 6, fallback: 1 },
  height: { min: 0.1, max: 6, fallback: 1 },
  depth: { min: 0.1, max: 6, fallback: 1 },
  offsetX: { min: -4, max: 4, fallback: 0 },
  offsetY: { min: -1, max: 9, fallback: 0 },
  offsetZ: { min: -4, max: 4, fallback: 0 },
  rotationX: { min: -3.15, max: 3.15, fallback: 0 },
  rotationY: { min: -3.15, max: 3.15, fallback: 0 },
  rotationZ: { min: -3.15, max: 3.15, fallback: 0 },
  bounciness: { min: 0, max: 1, fallback: 0.2 },
  labelMaxLength: 30,
};

/** How much of a plot one structure may fill, in metres. */
export const STRUCTURE_MAX = { width: 6, height: 7, depth: 6 };

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

/** Round to centimetres - enough precision, and keeps the JSON small. */
function round(n) {
  return Math.round(n * 100) / 100;
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
 * Lift near-black colours so they stay visible. Unlit near-black geometry reads
 * as a hole in the world rather than as an object.
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
  const shape = SHAPES.includes(source.shape) ? source.shape : 'box';

  const part = {
    shape,
    width: round(num(source.width, LIMITS.width)),
    height: round(num(source.height, LIMITS.height)),
    depth: round(num(source.depth, LIMITS.depth)),
    offsetX: round(num(source.offsetX, LIMITS.offsetX)),
    offsetY: round(num(source.offsetY, LIMITS.offsetY)),
    offsetZ: round(num(source.offsetZ, LIMITS.offsetZ)),
    rotationX: round(num(source.rotationX, LIMITS.rotationX)),
    rotationY: round(num(source.rotationY, LIMITS.rotationY)),
    rotationZ: round(num(source.rotationZ, LIMITS.rotationZ)),
    color: normalizeColor(source.color, `${seed}:${index}`),
  };

  // A sphere is round in every direction; a cylinder and a cone are round in
  // the horizontal plane. Keeping those consistent stops the model producing
  // accidental squashed eggs when it only meant to set one dimension.
  if (shape === 'sphere') part.depth = part.height = part.width;
  if (shape === 'cylinder' || shape === 'cone') part.depth = part.width;
  return part;
}

/**
 * Coerce a palette into at most MAX_PALETTE entries of a normalised colour and
 * a glow flag, plus the character-to-index map the layer painter reads.
 *
 * Always returns at least one entry: an empty palette would leave every voxel
 * with nothing to be coloured.
 */
export function normalizePalette(input, seed = 'palette') {
  const rows = Array.isArray(input) ? input.slice(0, MAX_PALETTE) : [];
  const palette = [];
  const keyToIndex = new Map();

  rows.forEach((row, index) => {
    const source = row && typeof row === 'object' ? row : {};
    const key = typeof source.key === 'string' ? [...source.key.trim()][0] : undefined;

    palette.push({
      color: normalizeColor(source.color, `${seed}:${index}`),
      glow: source.glow === true,
    });
    // First writer wins, so a palette that reuses a character does not silently
    // repaint everything already drawn with it.
    if (key && !keyToIndex.has(key)) keyToIndex.set(key, index);
  });

  if (!palette.length) palette.push({ color: normalizeColor(null, seed), glow: false });
  return { palette, keyToIndex };
}

/**
 * Build the voxels for a structure, from whichever description it arrived with.
 *
 * Layers are the model's channel and win when present. Anything else - the
 * offline generator, the canned blocks, a hand-written literal - is rasterised
 * from its primitive parts, so it comes out of the same grid and renders
 * through the same path.
 */
function sculpt(raw, fitted, label) {
  const layers = Array.isArray(raw.layers) && raw.layers.length ? raw.layers : null;

  if (layers) {
    const { palette, keyToIndex } = normalizePalette(raw.palette, label);
    const mirrored = raw.symmetry !== 'none';
    const voxels = placeCells(cellsFromLayers(layers, keyToIndex, mirrored), { centerX: !mirrored });
    // A layer set that painted nothing at all - all dots, or all unreadable -
    // would leave an empty plot, so fall through to the parts it also carries.
    if (voxels.length) return { palette, voxels };
  }

  const bounds = structureBounds(fitted);
  const palette = fitted.parts.map((part) => ({ color: part.color, glow: false }));
  const voxels = placeCells(
    cellsFromParts(fitted.parts, {
      centerX: (bounds.minX + bounds.maxX) / 2,
      centerZ: (bounds.minZ + bounds.maxZ) / 2,
    }),
    { centerX: true },
  );

  return { palette: palette.length ? palette : [{ color: '#8f8f8f', glow: false }], voxels };
}

/**
 * Coerce anything - a model tool call, a cached pack entry, a hand-written
 * literal - into a structure that is safe to build.
 * Never throws, never returns null, always returns something buildable.
 */
export function normalizeStructure(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const label = sanitizeLabel(raw.label);

  const partsIn = Array.isArray(raw.parts) && raw.parts.length ? raw.parts : [{}];
  const parts = partsIn.slice(0, MAX_PARTS).map((part, i) => normalizePart(part, label, i));

  const fitted = fitStructure({
    label,
    subject: SUBJECTS.includes(raw.subject) ? raw.subject : 'object',
    bounciness: round(num(raw.bounciness, LIMITS.bounciness)),
    parts,
  });

  return { ...fitted, ...sculpt(raw, fitted, label) };
}

/**
 * How much room a part takes up, centred on its offset.
 *
 * A cone is as wide as its base but tapers, and a rotated part sweeps a wider
 * box than it occupies. Both are approximated generously here: over-reserving
 * only makes a structure slightly smaller than it had to be, while
 * under-reserving lets things poke into the neighbouring plot.
 */
export function partExtents(part) {
  let { width, height, depth } = part;

  // Each rotation sweeps the two axes it turns within, so widen both of them to
  // the diagonal. Taking the max per axis handles parts rotated on more than
  // one at once.
  if (part.rotationY) {
    const sweep = Math.hypot(part.width, part.depth);
    width = Math.max(width, sweep);
    depth = Math.max(depth, sweep);
  }
  if (part.rotationX) {
    const sweep = Math.hypot(part.height, part.depth);
    height = Math.max(height, sweep);
    depth = Math.max(depth, sweep);
  }
  if (part.rotationZ) {
    const sweep = Math.hypot(part.width, part.height);
    width = Math.max(width, sweep);
    height = Math.max(height, sweep);
  }

  return { width, height, depth };
}

/** Axis-aligned bounds of a whole structure, measured from its parts. */
export function structureBounds(structure) {
  const bounds = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };

  for (const part of structure.parts) {
    const reach = partExtents(part);
    bounds.minX = Math.min(bounds.minX, part.offsetX - reach.width / 2);
    bounds.maxX = Math.max(bounds.maxX, part.offsetX + reach.width / 2);
    bounds.minY = Math.min(bounds.minY, part.offsetY - reach.height / 2);
    bounds.maxY = Math.max(bounds.maxY, part.offsetY + reach.height / 2);
    bounds.minZ = Math.min(bounds.minZ, part.offsetZ - reach.depth / 2);
    bounds.maxZ = Math.max(bounds.maxZ, part.offsetZ + reach.depth / 2);
  }

  return {
    ...bounds,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    depth: bounds.maxZ - bounds.minZ,
  };
}

/**
 * Scale a structure to fit inside one plot, then sit it on the ground.
 *
 * The model is told the size limits but thinks in "a statue is about this big"
 * and routinely overshoots. Scaling the whole structure keeps proportions
 * intact - clamping each part on its own would turn a tall statue into a squat
 * one. The vertical lift matters just as much: a model that puts parts below
 * zero buries half the build underground, which is the single most common way
 * a generated structure looks broken.
 */
export function fitStructure(structure, max = STRUCTURE_MAX) {
  const bounds = structureBounds(structure);
  const scale = Math.min(
    1,
    max.width / bounds.width,
    max.height / bounds.height,
    max.depth / bounds.depth,
  );

  const parts = structure.parts.map((part) => ({
    ...part,
    width: round(Math.max(LIMITS.width.min, part.width * scale)),
    height: round(Math.max(LIMITS.height.min, part.height * scale)),
    depth: round(Math.max(LIMITS.depth.min, part.depth * scale)),
    offsetX: round(part.offsetX * scale),
    offsetY: round((part.offsetY - bounds.minY) * scale),
    offsetZ: round(part.offsetZ * scale),
  }));

  return { ...structure, parts };
}
