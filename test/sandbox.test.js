/**
 * Tests for the three things that keep the booth safe and standing:
 * the spec clamps, the blocklist, and the offline pack.
 *
 * Run with `npm test`. No API key and no network needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSpec, sanitizeLabel, normalizeColor, fitToWorld, LIMITS, SHAPES } from '../public/js/spec.js';
import { screen } from '../server/moderation.js';
import { pickFromPack, jitter } from '../public/js/pack.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/data/fallback.json'), 'utf8'));

/* ---------- spec clamping ---------- */

test('clamps every numeric field into range', () => {
  const spec = normalizeSpec({
    shape: 'rectangle',
    width: 99999,
    height: -400,
    density: 500,
    restitution: 3,
    friction: -2,
    sides: 99,
    color: '#ff0000',
    label: 'test',
  });

  assert.equal(spec.width, LIMITS.width.max);
  assert.equal(spec.height, LIMITS.height.min);
  assert.equal(spec.density, LIMITS.density.max);
  assert.equal(spec.restitution, LIMITS.restitution.max);
  assert.equal(spec.friction, LIMITS.friction.min);
  assert.equal(spec.sides, LIMITS.sides.max);
});

test('restitution never reaches 1, so the pile cannot gain energy forever', () => {
  assert.ok(normalizeSpec({ restitution: 1 }).restitution < 1);
  assert.ok(normalizeSpec({ restitution: 99 }).restitution < 1);
});

test('survives garbage, nulls and hostile shapes without throwing', () => {
  const inputs = [null, undefined, 42, 'a string', [], { shape: 'sphere' }, { width: NaN }, { width: 'wide' }];
  for (const input of inputs) {
    const spec = normalizeSpec(input);
    assert.ok(SHAPES.includes(spec.shape));
    assert.ok(Number.isFinite(spec.width) && spec.width >= LIMITS.width.min);
    assert.ok(/^#[0-9a-f]{6}$/.test(spec.color));
    assert.ok(spec.label.length > 0);
  }
});

test('a model returning prose in the label still yields a short plain label', () => {
  const spec = normalizeSpec({
    label: 'Sure! Here is a very long description of the object you asked me to build for you today',
  });
  assert.ok(spec.label.length <= LIMITS.labelMaxLength);
});

test('labels are stripped of markup and control characters', () => {
  assert.equal(sanitizeLabel('<script>alert(1)</script>'), 'scriptalert1script');
  assert.equal(sanitizeLabel('bowling\u0000 ball\n'), 'bowling ball');
  assert.equal(sanitizeLabel(''), 'mystery object');
  assert.equal(sanitizeLabel(123), 'mystery object');
});

test('colors are normalized, and unreadable ones are lifted off the background', () => {
  assert.equal(normalizeColor('#F00'), '#ff0000');
  assert.equal(normalizeColor('ff0000'), '#ff0000');
  assert.equal(normalizeColor('red'), '#e5484d');
  assert.match(normalizeColor('chartreuse-ish', 'seed'), /^#[0-9a-f]{6}$/);
  // Pure black would be invisible on the dark sandbox background.
  assert.notEqual(normalizeColor('#000000'), '#000000');
});

test('circles and polygons stay round', () => {
  const circle = normalizeSpec({ shape: 'circle', width: 120, height: 20 });
  assert.equal(circle.width, circle.height);
});

test('nothing can be spawned larger than a fraction of the screen', () => {
  const spec = fitToWorld(normalizeSpec({ width: 420, height: 420 }), 600);
  assert.ok(Math.max(spec.width, spec.height) <= 600 * 0.42 + 1);
});

/* ---------- blocklist ---------- */

test('blocks profanity, including padded and leetspeak spellings', () => {
  const blocked = ['fuck', 'FUCK', 'a fuuuuck ball', 'f u c k', 'f.u.c.k', 'sh1t', 'a$$', 'p0rn', 'nigger'];
  for (const input of blocked) {
    assert.equal(screen(input).blocked, true, `expected "${input}" to be blocked`);
  }
});

test('does not block innocent words that merely contain a blocked substring', () => {
  // The Scunthorpe problem. A booth that rejects "class project" is worse than
  // one that occasionally lets a mild word through.
  const allowed = [
    'a bowling ball made of jello',
    'my class project',
    'an assignment due tomorrow',
    'a bass guitar',
    'Scunthorpe town hall',
    'a grasshopper',
    'a cocktail shaker',
    'analysis paralysis',
    'a titanium bar',
    'a duck on a brick',
    'a basketball',
  ];
  for (const input of allowed) {
    assert.equal(screen(input).blocked, false, `expected "${input}" to pass`);
  }
});

test('known false positives: listed words block even in innocent phrases', () => {
  // Documenting the tradeoff rather than pretending it does not exist. A word
  // on the list blocks wherever it appears, so a handful of names and idioms
  // get a grey box. That is the right direction to err at a school booth, and
  // the cost is one boring object. Remove the term from WORDS if you disagree.
  for (const input of ['Dick Van Dyke', 'a hitler moustache', 'weed killer']) {
    assert.equal(screen(input).blocked, true);
  }
});

test('empty and non-string input is not blocked', () => {
  for (const input of ['', '   ', null, undefined, 42]) {
    assert.equal(screen(input).blocked, false);
  }
});

/* ---------- offline pack ---------- */

test('every pack object survives normalization unchanged in spirit', () => {
  for (const object of pack.objects) {
    const spec = normalizeSpec(object);
    assert.ok(SHAPES.includes(spec.shape), `${object.label} has shape ${object.shape}`);
    assert.equal(spec.label, object.label, `${object.label} label was altered`);
    assert.equal(spec.color, object.color.toLowerCase(), `${object.label} colour was altered`);
    assert.equal(spec.density, object.density, `${object.label} density was clamped`);
    assert.equal(spec.restitution, object.restitution, `${object.label} restitution was clamped`);
  }
});

test('pack matching finds the obvious object when the wifi is down', () => {
  const cases = [
    ['a bowling ball', 'bowling ball'],
    ['a trampoline', 'trampoline'],
    ['an anvil the size of a car', 'anvil'],
    ['a giant rubber duck', 'rubber duck'],
    ['something made of jello', 'jello blob'],
    ['a huge boulder', 'boulder'],
  ];
  for (const [prompt, expected] of cases) {
    assert.equal(pickFromPack(pack, prompt).label, expected, `"${prompt}" should match ${expected}`);
  }
});

test('pack matching always returns something, even for nonsense', () => {
  for (const prompt of ['', 'zzzzzz', 'asdfgh qwerty', null]) {
    const picked = pickFromPack(pack, prompt);
    assert.ok(picked.label, `no object returned for "${prompt}"`);
  }
});

test('jittered pack objects stay inside the allowed ranges', () => {
  for (const object of pack.objects) {
    for (let i = 0; i < 20; i++) {
      const spec = normalizeSpec(jitter(object));
      assert.ok(spec.width >= LIMITS.width.min && spec.width <= LIMITS.width.max);
      assert.ok(spec.restitution <= LIMITS.restitution.max);
    }
  }
});
