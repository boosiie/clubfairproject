/**
 * Tests for the four things that keep the booth safe and standing:
 * the structure clamps, the voxel grid, the blocklist, and the offline
 * generator.
 *
 * Run with `npm test`. No API key and no network needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeStructure,
  sanitizeLabel,
  normalizeColor,
  structureBounds,
  partExtents,
  fitStructure,
  LIMITS,
  SHAPES,
  SUBJECTS,
  MAX_PARTS,
  STRUCTURE_MAX,
} from '../public/js/spec.js';
import { GRID, VOXEL, shadeVoxels, voxelBounds } from '../public/js/voxel.js';
import { screen, REDACTED_STRUCTURE } from '../server/moderation.js';
import {
  buildFromPrompt,
  buildNonsenseBlock,
  looksLikeNonsense,
  readPrompt,
  ATTRACT_PROMPTS,
} from '../public/js/offline.js';

const part = (over = {}) => ({
  shape: 'box',
  width: 1, height: 1, depth: 1,
  offsetX: 0, offsetY: 0.5, offsetZ: 0,
  rotationX: 0, rotationY: 0, rotationZ: 0,
  color: '#ff0000',
  ...over,
});

/* ---------- the voxel grid ---------- */

/** Every (x, y, z) in a normalised structure, as "x,y,z" strings. */
const cellsOf = (structure) => {
  const out = new Set();
  for (let i = 0; i < structure.voxels.length; i += 4) {
    out.add(`${structure.voxels[i]},${structure.voxels[i + 1]},${structure.voxels[i + 2]}`);
  }
  return out;
};

const sculpture = (over = {}) => normalizeStructure({
  label: 'test',
  symmetry: 'mirror',
  palette: [{ key: 'A', color: '#ff0000', glow: false }, { key: 'B', color: '#00ff00', glow: true }],
  layers: [{ y: 0, rows: ['AA.'] }],
  ...over,
});

test('a structure from primitive parts still comes out as voxels', () => {
  const built = normalizeStructure({ label: 'statue', parts: [part({ width: 2, height: 3, depth: 2, offsetY: 1.5 })] });
  assert.ok(built.voxels.length >= 4, 'rasterised nothing');
  assert.equal(built.voxels.length % 4, 0, 'voxels are flat quads of x, y, z, palette');
  assert.ok(built.palette.length >= 1);
});

test('every path out of normalizeStructure carries voxels and a palette', () => {
  for (const input of [null, {}, { parts: [] }, { layers: [] }, { label: 'x' }, REDACTED_STRUCTURE]) {
    const built = normalizeStructure(input);
    assert.ok(built.voxels.length >= 4, `no voxels for ${JSON.stringify(input)}`);
    assert.ok(built.palette.length >= 1, `no palette for ${JSON.stringify(input)}`);
  }
});

test('a mirrored sculpture is symmetric about the centre line', () => {
  const cells = cellsOf(sculpture({ layers: [{ y: 0, rows: ['A.A', '.AA'] }, { y: 1, rows: ['AA.'] }] }));
  for (const cell of cells) {
    const [x, y, z] = cell.split(',').map(Number);
    assert.ok(cells.has(`${GRID.width - 1 - x},${y},${z}`), `${cell} has no mirror`);
  }
});

test('layers stay registered with each other, whatever their row counts', () => {
  // A one-row layer over a five-row layer: centring each layer on its own would
  // slide the top one into the middle of the bottom one.
  const built = sculpture({
    symmetry: 'none',
    layers: [{ y: 0, rows: ['AAAA', 'A..A', 'A..A', 'A..A', 'AAAA'] }, { y: 1, rows: ['AAAA'] }],
  });
  const cells = cellsOf(built);
  const top = [...cells].map((c) => c.split(',').map(Number)).filter(([, y]) => y === 1);
  assert.equal(top.length, 4, 'the top layer did not stay four wide');
  // The whole sculpture is centred once, so the indices shift together - what
  // has to hold is that each top cube still sits on a bottom one.
  for (const [x, , z] of top) {
    assert.ok(cells.has(`${x},0,${z}`), 'the top layer slid off the front of the bottom one');
  }
});

test('a sculpture rests on the ground and stays inside the grid', () => {
  const built = sculpture({ layers: [{ y: 9, rows: ['AA.'] }, { y: 14, rows: ['AA.'] }] });
  let minY = Infinity;
  for (let i = 0; i < built.voxels.length; i += 4) {
    const [x, y, z] = [built.voxels[i], built.voxels[i + 1], built.voxels[i + 2]];
    minY = Math.min(minY, y);
    assert.ok(x >= 0 && x < GRID.width, `x ${x} off the grid`);
    assert.ok(y >= 0 && y < GRID.height, `y ${y} off the grid`);
    assert.ok(z >= 0 && z < GRID.depth, `z ${z} off the grid`);
  }
  assert.equal(minY, 0, 'the sculpture is floating');
});

test('nothing escapes its plot, however far the model paints', () => {
  const built = sculpture({
    symmetry: 'none',
    layers: Array.from({ length: GRID.height + 6 }, (_, y) => ({ y, rows: Array(GRID.depth + 6).fill('A'.repeat(GRID.width + 6)) })),
  });
  const bounds = voxelBounds(built.voxels);
  assert.ok(bounds.width <= STRUCTURE_MAX.width + 0.01, `${bounds.width}m wide`);
  assert.ok(bounds.height <= STRUCTURE_MAX.height + 0.01, `${bounds.height}m tall`);
  assert.ok(bounds.depth <= STRUCTURE_MAX.depth + 0.01, `${bounds.depth}m deep`);
});

test('a character with no palette entry is painted, not left as a hole', () => {
  // A model that slips and uses a key it never declared should not punch a
  // window through the middle of the build.
  const built = sculpture({ layers: [{ y: 0, rows: ['AQA'] }] });
  assert.equal(built.voxels.length / 4, 6, 'the stray character was dropped');
});

test('dots and spaces are empty space, and an empty painting falls back to parts', () => {
  assert.equal(sculpture({ layers: [{ y: 0, rows: ['A.A'] }] }).voxels.length / 4, 4);
  // All dots paints nothing at all, so the structure has to come from its parts.
  const blank = normalizeStructure({ label: 'blank', layers: [{ y: 0, rows: ['....'] }] });
  assert.ok(blank.voxels.length >= 4, 'an all-dots painting left an empty plot');
});

test('survives hostile layers and palettes without throwing', () => {
  const hostile = [
    { layers: 'not an array', palette: 'nope' },
    { layers: [null, 7, { y: 'x', rows: ['A'] }, { y: 0, rows: [null, 5, 'A'] }] },
    { layers: [{ y: 0, rows: ['A'] }], palette: [{ key: 5, color: {} }, null, 'x'] },
    { layers: [{ y: -99, rows: ['A'] }], symmetry: 12 },
    { layers: [{ y: 0, rows: ['A'] }], palette: [{ key: 'A', color: '#fff' }, { key: 'A', color: '#000' }] },
  ];
  for (const input of hostile) {
    const built = normalizeStructure(input);
    assert.ok(Array.isArray(built.voxels), `threw or lost voxels on ${JSON.stringify(input)}`);
    assert.ok(built.palette.every((entry) => /^#[0-9a-f]{6}$/.test(entry.color)), 'a colour escaped normalisation');
  }
});

test('buried cubes are never drawn, and glowing ones are never shaded', () => {
  // A solid 3x3x3 has exactly one cube nobody can ever see.
  const rows = ['AAA', 'AAA', 'AAA'];
  const solid = normalizeStructure({
    label: 'cube', symmetry: 'none',
    palette: [{ key: 'A', color: '#ff0000', glow: false }],
    layers: [{ y: 0, rows }, { y: 1, rows }, { y: 2, rows }],
  });
  const drawn = shadeVoxels(solid.voxels, solid.palette);
  assert.equal(solid.voxels.length / 4, 27);
  assert.equal(drawn.solid.length, 26, 'the buried centre cube was drawn');
  assert.ok(drawn.solid.some((cell) => cell.color !== '#ff0000'), 'no occlusion shading was applied');

  const lit = sculpture({ layers: [{ y: 0, rows: ['BBB'] }] });
  const glow = shadeVoxels(lit.voxels, lit.palette);
  assert.equal(glow.solid.length, 0);
  assert.ok(glow.glow.every((cell) => cell.color === '#00ff00'), 'a glowing cube was shaded');
});

test('cubes carry their height, so a sculpture can assemble from the ground up', () => {
  const rows = ['AA'];
  const built = normalizeStructure({
    label: 'column', symmetry: 'none',
    palette: [{ key: 'A', color: '#ff0000', glow: false }],
    layers: [{ y: 0, rows }, { y: 1, rows }, { y: 2, rows }, { y: 3, rows }],
  });
  const drawn = shadeVoxels(built.voxels, built.palette);

  const byHeight = new Map();
  for (const cell of drawn.solid) byHeight.set(Math.round(cell.y * 1000), cell.rise);
  const heights = [...byHeight.keys()].sort((a, b) => a - b);

  assert.equal(byHeight.get(heights[0]), 0, 'the ground layer does not start first');
  assert.equal(byHeight.get(heights[heights.length - 1]), 1, 'the top layer does not finish last');
  // Strictly increasing, or the build would not read as sweeping upward.
  const rises = heights.map((h) => byHeight.get(h));
  for (let i = 1; i < rises.length; i++) {
    assert.ok(rises[i] > rises[i - 1], `layer ${i} does not start after layer ${i - 1}`);
  }
});

test('voxel bounds are measured in metres, not in grid steps', () => {
  const built = sculpture({ symmetry: 'none', layers: [{ y: 0, rows: ['AA'] }, { y: 1, rows: ['AA'] }] });
  const bounds = voxelBounds(built.voxels);
  assert.equal(bounds.width, 2 * VOXEL);
  assert.equal(bounds.height, 2 * VOXEL);
  assert.equal(bounds.depth, 1 * VOXEL);
});

/* ---------- structure clamping ---------- */

test('clamps every numeric field into range', () => {
  // A part small enough that the whole-structure fit does not then scale it,
  // so these assertions see the clamp itself rather than the fit.
  const structure = normalizeStructure({
    label: 'test',
    subject: 'object',
    bounciness: 99,
    parts: [part({ width: 9999, height: -400, offsetX: 9999, offsetZ: -9999 })],
  });

  assert.equal(structure.bounciness, LIMITS.bounciness.max);
  assert.equal(structure.parts[0].width, LIMITS.width.max);
  assert.equal(structure.parts[0].height, LIMITS.height.min);

  // Rotation is clamped too, but a rotated part sweeps a wider box and so can
  // trigger the whole-structure fit - checked on its own to keep the two apart.
  const turned = normalizeStructure({ parts: [part({ rotationY: 40, rotationX: -40, rotationZ: 40 })] });
  assert.equal(turned.parts[0].rotationY, LIMITS.rotationY.max);
  assert.equal(turned.parts[0].rotationX, LIMITS.rotationX.min);
  assert.equal(turned.parts[0].rotationZ, LIMITS.rotationZ.max);
});

test('out-of-range values always land inside the limits, whatever the fit does', () => {
  // Clamping runs first and the whole-structure fit may then scale things down
  // further, so the guarantee is a range rather than an exact value.
  const structure = normalizeStructure({
    bounciness: -5,
    parts: [
      part({ width: 1e9, height: -1e9, depth: 1e9, offsetX: 1e9, offsetY: -1e9, offsetZ: -1e9 }),
      part({ width: -3, offsetX: -1e9, offsetZ: 1e9, rotationX: 99, rotationZ: -99 }),
    ],
  });

  assert.ok(structure.bounciness >= LIMITS.bounciness.min);
  for (const p of structure.parts) {
    for (const key of ['width', 'height', 'depth', 'offsetX', 'offsetZ', 'rotationX', 'rotationY', 'rotationZ']) {
      assert.ok(p[key] >= LIMITS[key].min && p[key] <= LIMITS[key].max, `${key} was ${p[key]}`);
    }
    assert.ok(p.offsetY >= 0 && p.offsetY <= LIMITS.offsetY.max, `offsetY was ${p.offsetY}`);
  }
});

test('caps the number of parts, so one prompt cannot build a hundred meshes', () => {
  const structure = normalizeStructure({ label: 'many', parts: Array(50).fill(part()) });
  assert.equal(structure.parts.length, MAX_PARTS);
});

test('survives garbage, nulls and hostile shapes without throwing', () => {
  const inputs = [
    null, undefined, 42, 'a string', [],
    { parts: 'not an array' }, { parts: [] }, { parts: [null, 7, 'x'] },
    { parts: [part({ shape: 'dodecahedron', width: NaN })] },
    { parts: [part({ offsetY: Infinity })] },
  ];
  for (const input of inputs) {
    const structure = normalizeStructure(input);
    assert.ok(structure.parts.length >= 1, 'always at least one part');
    assert.ok(SUBJECTS.includes(structure.subject));
    for (const p of structure.parts) {
      assert.ok(SHAPES.includes(p.shape));
      for (const key of ['width', 'height', 'depth', 'offsetX', 'offsetY', 'offsetZ']) {
        assert.ok(Number.isFinite(p[key]), `${key} was ${p[key]}`);
      }
      assert.ok(/^#[0-9a-f]{6}$/.test(p.color));
    }
    assert.ok(structure.label.length > 0);
  }
});

test('round shapes stay round instead of becoming squashed eggs', () => {
  const sphere = normalizeStructure({ parts: [part({ shape: 'sphere', width: 2, height: 0.3, depth: 5 })] }).parts[0];
  assert.equal(sphere.width, sphere.height);
  assert.equal(sphere.width, sphere.depth);

  // A cylinder is round horizontally but keeps its own height.
  const cylinder = normalizeStructure({ parts: [part({ shape: 'cylinder', width: 2, height: 3, depth: 5 })] }).parts[0];
  assert.equal(cylinder.width, cylinder.depth);
  assert.equal(cylinder.height, 3);
});

test('a model returning prose in the label still yields a short plain label', () => {
  const structure = normalizeStructure({
    label: 'Sure! Here is a very long description of the exhibit you asked me to build today',
  });
  assert.ok(structure.label.length <= LIMITS.labelMaxLength);
});

test('labels are stripped of markup and control characters', () => {
  assert.equal(sanitizeLabel('<script>alert(1)</script>'), 'scriptalert1script');
  assert.equal(sanitizeLabel('a statue  of someone\n'), 'a statue of someone');
  assert.equal(sanitizeLabel(''), 'mystery exhibit');
  assert.equal(sanitizeLabel(123), 'mystery exhibit');
});

test('colors are normalized, and unreadable ones are lifted off the background', () => {
  assert.equal(normalizeColor('#F00'), '#ff0000');
  assert.equal(normalizeColor('marble'), '#e8e6e1');
  assert.match(normalizeColor('chartreuse-ish', 'seed'), /^#[0-9a-f]{6}$/);
  assert.notEqual(normalizeColor('#000000'), '#000000');
});

test('an unknown subject falls back to object rather than to real_person', () => {
  assert.equal(normalizeStructure({ subject: 'politician' }).subject, 'object');
  assert.equal(normalizeStructure({ subject: 'real_person' }).subject, 'real_person');
});

test('the redacted block is a small grey cube, not a six metre wall', () => {
  // It goes through the same clamps as everything else, so a stale 2D literal
  // here would silently become a wall filling the plot.
  const bounds = structureBounds(normalizeStructure(REDACTED_STRUCTURE));
  assert.ok(bounds.width <= 2 && bounds.height <= 2, `${bounds.width}x${bounds.height}`);
});

/* ---------- structure geometry ---------- */

test('every structure is lifted so it rests on the ground', () => {
  // A model that puts parts underground is the most common way a build looks
  // broken: half the statue buried, only the head showing.
  const cases = [
    [part({ offsetY: -50 })],
    [part({ offsetY: 3 }), part({ offsetY: 4 })],
    [part({ height: 2, offsetY: 0 })],
    [part({ shape: 'cone', width: 3, height: 3, offsetY: 9 })],
  ];
  for (const parts of cases) {
    const structure = normalizeStructure({ label: 'x', parts });
    assert.ok(Math.abs(structureBounds(structure).minY) <= 0.02, `minY ${structureBounds(structure).minY}`);
  }
});

test('oversized structures are scaled down whole, keeping their proportions', () => {
  const tall = normalizeStructure({
    label: 'tower',
    parts: [part({ width: 1, height: 6, offsetY: 3 }), part({ width: 1, height: 6, offsetY: 9 })],
  });
  const bounds = structureBounds(tall);
  assert.ok(bounds.height <= STRUCTURE_MAX.height + 0.02, `height ${bounds.height}`);
  // Proportion preserved: both parts were equal, so they still are.
  assert.equal(tall.parts[0].height, tall.parts[1].height);
});

test('nothing escapes its plot in any of the three dimensions', () => {
  const sprawl = normalizeStructure({
    label: 'sprawl',
    parts: [
      part({ width: 6, height: 6, depth: 6, offsetX: -4, offsetZ: -4, offsetY: 3 }),
      part({ width: 6, height: 6, depth: 6, offsetX: 4, offsetZ: 4, offsetY: 8 }),
    ],
  });
  const bounds = structureBounds(sprawl);
  assert.ok(bounds.width <= STRUCTURE_MAX.width + 0.02, `width ${bounds.width}`);
  assert.ok(bounds.height <= STRUCTURE_MAX.height + 0.02, `height ${bounds.height}`);
  assert.ok(bounds.depth <= STRUCTURE_MAX.depth + 0.02, `depth ${bounds.depth}`);
});

test('a rotated part is measured by its swept box, on whichever axes it turns', () => {
  // A wheel is a cylinder rolled onto its side. Measured unrotated it looks
  // short and wide, and would be allowed to stick out of the plot.
  const flat = partExtents(part({ width: 4, height: 0.4, depth: 4 }));
  assert.equal(flat.height, 0.4);

  const rolled = partExtents(part({ width: 4, height: 0.4, depth: 4, rotationZ: Math.PI / 2 }));
  assert.ok(rolled.height > 3.9, `rotationZ should raise height, got ${rolled.height}`);

  const tipped = partExtents(part({ width: 4, height: 0.4, depth: 4, rotationX: Math.PI / 2 }));
  assert.ok(tipped.height > 3.9, `rotationX should raise height, got ${tipped.height}`);
});

test('fitStructure is idempotent - refitting an already fitted structure changes nothing', () => {
  // world.js fits again on the way in; that must not shrink things twice.
  const once = normalizeStructure({ label: 'x', parts: [part({ width: 3, height: 3, depth: 3, offsetY: 1.5 })] });
  const twice = fitStructure(once, STRUCTURE_MAX);
  assert.deepEqual(twice.parts, once.parts);
});

/* ---------- blocklist ---------- */

test('blocks profanity, including padded and leetspeak spellings', () => {
  const blocked = ['fuck', 'FUCK', 'a fuuuuck statue', 'f u c k', 'f.u.c.k', 'sh1t', 'a$$', 'p0rn', 'nigger'];
  for (const input of blocked) {
    assert.equal(screen(input).blocked, true, `expected "${input}" to be blocked`);
  }
});

test('does not block innocent words that merely contain a blocked substring', () => {
  // The Scunthorpe problem. A booth that rejects "class project" is worse than
  // one that occasionally lets a mild word through.
  const allowed = [
    'a statue of my chemistry teacher',
    'my class project',
    'an assignment due tomorrow',
    'a bass guitar',
    'Scunthorpe town hall',
    'a grasshopper',
    'a cocktail shaker',
    'a basketball hoop',
    'a duck on a brick',
    'analysis paralysis',
  ];
  for (const input of allowed) {
    assert.equal(screen(input).blocked, false, `expected "${input}" to pass`);
  }
});

test('known false positives: listed words block even in innocent phrases', () => {
  // Documenting the tradeoff rather than pretending it does not exist. A word
  // on the list blocks wherever it appears, so a handful of names and idioms
  // get a grey block. That is the right direction to err at a school booth.
  for (const input of ['Dick Van Dyke', 'a hitler moustache', 'weed killer']) {
    assert.equal(screen(input).blocked, true);
  }
});

test('empty and non-string input is not blocked', () => {
  for (const input of ['', '   ', null, undefined, 42]) {
    assert.equal(screen(input).blocked, false);
  }
});

/* ---------- offline generator ---------- */

test('reads the subject out of a prompt', () => {
  const cases = [
    ['a giant purple dragon', 'creature'],
    ['a statue of my chemistry teacher', 'statue'],
    ['a clock tower', 'tower'],
    ['skibidi toilet', 'character'],
    ['a school bus', 'vehicle'],
    ['an oak tree', 'tree'],
    ['a slice of pizza', 'food'],
    ['a ferris wheel', 'ride'],
    // A statue of a dragon is a statue, not a dragon.
    ['a statue of a dragon', 'statue'],
    ['some dragons', 'creature'],
  ];
  for (const [prompt, expected] of cases) {
    assert.equal(readPrompt(prompt).archetype, expected, `"${prompt}"`);
  }
});

test('reads size, material and colour out of a prompt', () => {
  assert.ok(readPrompt('a giant robot').scale > 1.3);
  assert.ok(readPrompt('a tiny robot').scale < 0.8);
  assert.equal(readPrompt('a robot').scale, 1);

  // The jello joke has to survive with no model: it has to visibly bounce.
  assert.ok(readPrompt('a bowling ball made of jello').material.bounce > 0.8);
  assert.ok(readPrompt('a stone statue').material.bounce < 0.1);

  assert.equal(readPrompt('a purple dragon').hue, 275);
  assert.equal(readPrompt('a dragon').hue, null);
});

test('the generator always returns a buildable structure, for any input', () => {
  const prompts = [
    '', 'zzzqqq', 'a', '!!!???', 'a giant purple dragon made of jello',
    'x'.repeat(140), 'the quick brown fox jumps over the lazy dog',
    ...ATTRACT_PROMPTS,
  ];
  for (const prompt of prompts) {
    const structure = normalizeStructure(buildFromPrompt(prompt));
    assert.ok(structure.parts.length >= 1, `"${prompt}" produced no parts`);
    assert.ok(structure.parts.length <= MAX_PARTS);
    for (const p of structure.parts) assert.ok(/^#[0-9a-f]{6}$/.test(p.color));

    const bounds = structureBounds(structure);
    assert.ok(bounds.width <= STRUCTURE_MAX.width + 0.02, `"${prompt}" is ${bounds.width} wide`);
    assert.ok(bounds.depth <= STRUCTURE_MAX.depth + 0.02, `"${prompt}" is ${bounds.depth} deep`);
    assert.ok(Math.abs(bounds.minY) <= 0.02, `"${prompt}" does not rest on the ground`);
  }
});

test('exhibits are built to human scale, not ant scale or skyscraper scale', () => {
  // A person is 1.8 tall. Anything under half a metre is invisible from the
  // road and anything over the cap gets scaled down anyway.
  for (const prompt of ['a dragon', 'a statue', 'a robot', 'a tree', 'a car', 'zzzqqq']) {
    const bounds = structureBounds(normalizeStructure(buildFromPrompt(prompt)));
    assert.ok(bounds.height >= 0.8, `"${prompt}" is only ${bounds.height.toFixed(2)}m tall`);
    assert.ok(bounds.height <= STRUCTURE_MAX.height + 0.02, `"${prompt}" is ${bounds.height}m tall`);
  }
});

test('exhibits have real depth - they are objects, not cardboard cutouts', () => {
  // The whole point of 3D is walking around the back of something.
  for (const prompt of ['a dragon', 'a statue', 'a robot', 'a car', 'a tree']) {
    const bounds = structureBounds(normalizeStructure(buildFromPrompt(prompt)));
    assert.ok(bounds.depth >= 0.6, `"${prompt}" is only ${bounds.depth.toFixed(2)}m deep`);
  }
});

test('the same prompt always builds the same exhibit', () => {
  for (const prompt of ['a giant purple dragon', 'skibidi toilet', 'zzzqqq']) {
    const first = JSON.stringify(buildFromPrompt(prompt));
    const second = JSON.stringify(buildFromPrompt(prompt));
    assert.equal(first, second, `"${prompt}" was not reproducible`);
  }
});

test('different prompts build visibly different exhibits', () => {
  // The failure this guards against: every unrecognised prompt coming out as
  // the same blob, which makes typing pointless.
  const prompts = ['zzzqqq', 'skibidi toilet', 'my locker', 'a wobbly thingamajig', 'quux'];
  const shapes = new Set(prompts.map((p) => JSON.stringify(buildFromPrompt(p).parts)));
  assert.equal(shapes.size, prompts.length, 'some prompts collided');

  const colours = new Set(prompts.map((p) => buildFromPrompt(p).parts[0].color));
  assert.ok(colours.size >= prompts.length - 1, `only ${colours.size} distinct colours`);
});

test('material words reach the bounce, colour words reach the palette', () => {
  const jello = normalizeStructure(buildFromPrompt('a tower made of jello'));
  const stone = normalizeStructure(buildFromPrompt('a tower made of stone'));
  assert.ok(jello.bounciness > stone.bounciness + 0.5, 'jello should visibly out-bounce stone');
});

test('offline labels use the typed words, or nothing at all when anonymising', () => {
  // Offline there is no model to classify whether a prompt names a real person,
  // so the conservative setting keeps typed text off the signs entirely.
  assert.equal(buildFromPrompt('a purple dragon').label, 'a purple dragon');

  const anon = buildFromPrompt('a statue of Mr Whitfield', { anonymise: true });
  assert.ok(!anon.label.toLowerCase().includes('whitfield'), `leaked: ${anon.label}`);
  assert.ok(anon.label.length > 0);
});

/* ---------- words that are not words ---------- */

test('keyboard mashing is recognised as not being words', () => {
  const mashes = [
    'zzzqqq', 'asdfghjkl', 'qwerty', 'jkjkjkjk', 'aaaaaa', 'xd', 'hjkl',
    '12345', '?!?!', 'a zxcvbnm', 'sdfsdfsdf', 'mmm', 'a big zzzqqq',
  ];
  for (const mash of mashes) {
    assert.equal(looksLikeNonsense(mash), true, `should be nonsense: ${mash}`);
  }
});

test('real words are never called nonsense, vocabulary or not', () => {
  // The false positive is the expensive one: it means mocking a visitor for
  // typing correctly. Half of these are deliberately outside the vocabulary.
  const words = [
    'a dragon', 'skibidi toilet', 'a giant purple statue', 'a school bus',
    'charlie kirk', 'a helicopter', 'a trampoline', 'an octopus wearing a hat',
    'a lighthouse', 'the eiffel tower', 'a submarine', 'lengths', 'a pineapple',
    'rhythm', 'a quesadilla', 'mount everest', 'a xylophone',
  ];
  for (const word of words) {
    assert.equal(looksLikeNonsense(word), false, `should be a word: ${word}`);
  }
});

test('an empty prompt is not nonsense - it has its own path', () => {
  assert.equal(looksLikeNonsense(''), false);
  assert.equal(looksLikeNonsense('   '), false);
  assert.equal(looksLikeNonsense(null), false);
});

test('the nonsense block survives the schema and stands on the ground', () => {
  const block = normalizeStructure(buildNonsenseBlock('zzzqqq'));

  assert.equal(block.label, 'zzzqqq', 'the typed text is what goes on the face');
  assert.ok(block.parts.length >= 1 && block.parts.length <= MAX_PARTS);
  // Part 0 is the screen; world.js textures that one and nothing else.
  assert.equal(block.parts[0].shape, 'box');

  const bounds = structureBounds(block);
  assert.ok(bounds.width <= STRUCTURE_MAX.width + 0.01, `too wide: ${bounds.width}`);
  assert.ok(bounds.height <= STRUCTURE_MAX.height + 0.01, `too tall: ${bounds.height}`);
  assert.ok(Math.abs(bounds.minY) < 0.01, `floating or buried: ${bounds.minY}`);
});

test('the block face keeps the meme proportions', () => {
  // 1024x689 of caption stretched onto a square would look like a mistake.
  const face = normalizeStructure(buildNonsenseBlock('zzzqqq')).parts[0];
  const ratio = face.width / face.height;
  assert.ok(ratio > 1.35 && ratio < 1.65, `face ratio is ${ratio.toFixed(2)}`);
});
