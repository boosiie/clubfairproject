/**
 * offline.js - building exhibits with no network at all.
 *
 * The offline pack answers "a ferris wheel" beautifully and "a giant purple
 * hamster" not at all. Sixteen canned exhibits is fine as a wifi-drops
 * fallback; it is not fine as the way the booth runs all day, which is what
 * happens on a school network that blocks the API outright. By person twenty
 * everyone is getting the same ferris wheel and "type anything" is a lie.
 *
 * So this builds a structure out of the words themselves. It reads a subject
 * ("dragon" -> creature), a size ("giant" -> bigger), and a material
 * ("marble" -> heavy, pale, dead weight) out of the prompt, then assembles an
 * archetype from those parameters. It is not a model and does not pretend to
 * be: it is a parameterised shape library with a vocabulary. But "a giant
 * purple dragon" produces a large purple creature, which is the thing the
 * booth is promising.
 *
 * Same output shape as the model, so everything downstream - clamping, the
 * blocklist, the park - is identical whether this or Haiku built it.
 */

import { hslToHex } from './spec.js';

/* ---------- deterministic randomness ---------- */

/**
 * The same prompt always builds the same exhibit. That matters at a booth:
 * someone who liked what they got can type it again and show a friend, and two
 * people typing different words never get the same thing by accident.
 */
function seedFrom(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeRng(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- vocabulary ---------- */

/**
 * Subject words to archetypes. First match in the prompt wins, so the order of
 * the lists inside an archetype does not matter but the archetype order does:
 * "statue of a dragon" should be a statue, not a dragon.
 */
const ARCHETYPES = [
  ['statue', ['statue', 'monument', 'memorial', 'bust', 'sculpture', 'plaque', 'shrine', 'trophy']],
  ['ride', ['ferris', 'carousel', 'coaster', 'rollercoaster', 'ride', 'swing', 'wheel', 'carnival']],
  ['tower', ['tower', 'skyscraper', 'lighthouse', 'obelisk', 'pillar', 'column', 'castle', 'clock', 'silo', 'rocket', 'spaceship', 'missile']],
  ['building', ['house', 'building', 'school', 'shop', 'store', 'stand', 'stall', 'hut', 'cabin', 'barn', 'shed', 'church', 'library', 'gym', 'garage', 'tent']],
  ['vehicle', ['car', 'truck', 'bus', 'van', 'tank', 'train', 'tractor', 'boat', 'ship', 'bike', 'motorcycle', 'plane', 'jet', 'cart']],
  ['creature', ['dragon', 'dinosaur', 'dino', 'trex', 'lizard', 'snake', 'shark', 'whale', 'cat', 'dog', 'puppy', 'kitten', 'bear', 'horse', 'cow', 'pig', 'sheep', 'goat', 'frog', 'bird', 'duck', 'chicken', 'penguin', 'monkey', 'elephant', 'giraffe', 'lion', 'tiger', 'wolf', 'fox', 'rat', 'mouse', 'hamster', 'bunny', 'rabbit', 'turtle', 'crab', 'octopus', 'spider', 'bug', 'beast', 'monster', 'creature', 'animal', 'worm', 'slug', 'squid']],
  // The brainrot words are here on purpose: they are what this crowd actually
  // types, and a recognisable little guy beats a generic blob every time.
  ['character', ['guy', 'dude', 'man', 'woman', 'kid', 'baby', 'person', 'robot', 'alien', 'ghost', 'zombie', 'skeleton', 'clown', 'wizard', 'knight', 'ninja', 'pirate', 'character', 'mascot', 'blob', 'goblin', 'troll', 'gnome', 'elf', 'thing', 'creature', 'skibidi', 'toilet', 'sigma', 'rizz', 'gyatt', 'ohio', 'brainrot', 'meme', 'npc', 'chungus', 'gigachad', 'doge', 'plushie', 'plush']],
  ['food', ['pizza', 'burger', 'hamburger', 'hotdog', 'donut', 'doughnut', 'cake', 'cupcake', 'cookie', 'icecream', 'sundae', 'taco', 'burrito', 'sandwich', 'fries', 'nugget', 'pancake', 'waffle', 'sushi', 'ramen', 'noodle', 'candy', 'lollipop', 'bread', 'cheese', 'egg', 'apple', 'banana', 'melon', 'watermelon', 'fruit', 'snack', 'food']],
  ['tree', ['tree', 'plant', 'bush', 'flower', 'cactus', 'mushroom', 'palm', 'forest', 'shrub']],
];

/** Words that change the size of whatever was asked for. */
const SIZES = [
  [1.45, ['giant', 'huge', 'massive', 'enormous', 'mega', 'colossal', 'gigantic', 'titanic', 'skyscraping']],
  [1.2, ['big', 'large', 'tall', 'oversized', 'jumbo']],
  [0.62, ['tiny', 'small', 'mini', 'little', 'miniature', 'baby', 'pocket']],
];

/**
 * Materials set the physics and tint the palette. This is where "a bowling ball
 * made of jello" gets its joke back without a model: jello is light, absurdly
 * bouncy and pink, and you can feel that the moment it lands.
 */
const MATERIALS = {
  jello: { bounce: 0.85, hue: 330, sat: 78, light: 66 },
  jelly: { bounce: 0.85, hue: 330, sat: 78, light: 66 },
  rubber: { bounce: 0.8, hue: 12, sat: 40, light: 44 },
  bouncy: { bounce: 0.85, hue: 90, sat: 72, light: 58 },
  balloon: { bounce: 0.78, hue: 0, sat: 78, light: 62 },
  inflatable: { bounce: 0.78, hue: 210, sat: 72, light: 58 },
  foam: { bounce: 0.5, hue: 40, sat: 50, light: 70 },
  slime: { bounce: 0.6, hue: 110, sat: 80, light: 50 },
  cheese: { bounce: 0.35, hue: 45, sat: 85, light: 58 },
  wood: { bounce: 0.18, hue: 28, sat: 44, light: 40 },
  wooden: { bounce: 0.18, hue: 28, sat: 44, light: 40 },
  plastic: { bounce: 0.42, hue: 200, sat: 70, light: 58 },
  glass: { bounce: 0.22, hue: 190, sat: 45, light: 72 },
  ice: { bounce: 0.2, hue: 192, sat: 62, light: 70 },
  paper: { bounce: 0.1, hue: 45, sat: 25, light: 82 },
  stone: { bounce: 0.04, hue: 30, sat: 8, light: 56 },
  rock: { bounce: 0.04, hue: 30, sat: 8, light: 52 },
  concrete: { bounce: 0.03, hue: 210, sat: 5, light: 58 },
  marble: { bounce: 0.04, hue: 40, sat: 10, light: 84 },
  brick: { bounce: 0.05, hue: 12, sat: 50, light: 44 },
  metal: { bounce: 0.12, hue: 210, sat: 10, light: 62 },
  steel: { bounce: 0.12, hue: 210, sat: 8, light: 60 },
  iron: { bounce: 0.08, hue: 215, sat: 8, light: 45 },
  gold: { bounce: 0.1, hue: 45, sat: 85, light: 55 },
  silver: { bounce: 0.12, hue: 210, sat: 6, light: 76 },
  bronze: { bounce: 0.1, hue: 30, sat: 45, light: 45 },
  lead: { bounce: 0.02, hue: 250, sat: 6, light: 42 },
  diamond: { bounce: 0.2, hue: 185, sat: 55, light: 80 },
};

const COLORS = {
  red: 0, crimson: 352, orange: 26, amber: 40, yellow: 52, gold: 45,
  lime: 84, green: 130, emerald: 150, teal: 174, cyan: 188, sky: 200,
  blue: 220, navy: 228, indigo: 250, purple: 275, violet: 282,
  magenta: 310, pink: 330, rose: 344, brown: 26, tan: 34,
};

const GREYS = { black: 18, grey: 55, gray: 55, white: 92, silver: 78 };

/**
 * Hue per archetype when nobody named a colour or a material, and how far it
 * may drift from prompt to prompt.
 *
 * The spread is the point. Without it every unrecognised prompt comes out the
 * same blue blob, and a booth where "skibidi toilet" and "zzzqqq" build the
 * identical object is a booth where typing does not matter. Trees stay green
 * because their spread is narrow; a blob can be anything because nothing about
 * the word constrains it.
 */
const DEFAULT_HUES = {
  statue: [36, 24], tower: [25, 60], building: [12, 90], vehicle: [215, 180],
  creature: [128, 120], character: [270, 220], food: [34, 60], tree: [125, 30],
  ride: [320, 200], blob: [200, 360],
};

/* ---------- reading the prompt ---------- */

function tokenize(prompt) {
  return String(prompt)
    .toLowerCase()
    // "ice cream" and "roller coaster" should match their single-word keys.
    .replace(/\bice\s+cream\b/g, 'icecream')
    .replace(/\broller\s*coaster\b/g, 'rollercoaster')
    .replace(/\bt[\s-]?rex\b/g, 'trex')
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** Singularise crudely, so "dragons" and "cats" still match. */
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const WORD_TO_ARCHETYPE = new Map();
for (const [name, words] of ARCHETYPES) {
  for (const word of words) if (!WORD_TO_ARCHETYPE.has(word)) WORD_TO_ARCHETYPE.set(word, name);
}

/**
 * Which word in the prompt is the thing being asked for.
 *
 * Two English patterns, and they point opposite ways. In a compound the head
 * noun is last - "a school bus" is a bus, not a school. But an "of" phrase puts
 * the head first - "a statue of a dragon" is a statue, not a dragon. So: take
 * the last match before any "of", and otherwise the last match in the prompt.
 */
function findSubject(tokens) {
  const ofIndex = tokens.indexOf('of');
  const head = ofIndex > 0 ? tokens.slice(0, ofIndex) : tokens;

  for (const scope of [head, tokens]) {
    for (let i = scope.length - 1; i >= 0; i--) {
      const archetype = WORD_TO_ARCHETYPE.get(scope[i]);
      if (archetype) return { archetype, matched: scope[i] };
    }
  }
  return { archetype: 'blob', matched: null };
}

export function readPrompt(prompt) {
  const tokens = tokenize(prompt).map(stem);
  const set = new Set(tokens);

  const { archetype, matched } = findSubject(tokens);

  let scale = 1;
  for (const [factor, words] of SIZES) {
    if (words.some((word) => set.has(word))) {
      scale = factor;
      break;
    }
  }

  let material = null;
  for (const token of tokens) {
    if (MATERIALS[token]) {
      material = MATERIALS[token];
      break;
    }
  }

  let hue = null;
  let saturation = null;
  for (const token of tokens) {
    if (token in COLORS) {
      hue = COLORS[token];
      break;
    }
    if (token in GREYS) {
      hue = 210;
      saturation = 6;
      break;
    }
  }
  // "rainbow" is common enough at a booth to be worth a special case.
  const rainbow = set.has('rainbow');

  return { tokens, archetype, matched, scale, material, hue, saturation, rainbow };
}

/* ---------- palette ---------- */

function buildPalette(read, rng) {
  const { archetype, material, hue, saturation, rainbow } = read;

  // An explicit colour word beats the material's tint, which beats a hue drawn
  // from the archetype's band. Someone who typed "purple" wants purple.
  const [centre, spread] = DEFAULT_HUES[archetype] ?? [210, 120];
  const drifted = (centre + (rng() - 0.5) * spread + 360) % 360;
  const baseHue = hue ?? material?.hue ?? drifted;
  const baseSat = saturation ?? (hue !== null ? 70 : material?.sat ?? 58);
  const baseLight = material?.light ?? 56;

  const spin = (degrees) => (baseHue + degrees + 360) % 360;
  const pick = (h, s, l) => hslToHex(h, Math.max(0, Math.min(100, s)), Math.max(8, Math.min(94, l)));

  if (rainbow) {
    const start = Math.floor(rng() * 360);
    return {
      primary: pick((start) % 360, 80, 58),
      secondary: pick((start + 60) % 360, 80, 58),
      accent: pick((start + 180) % 360, 82, 62),
      dark: pick((start + 120) % 360, 70, 40),
      light: pick((start + 300) % 360, 78, 70),
    };
  }

  return {
    primary: pick(baseHue, baseSat, baseLight),
    secondary: pick(spin(18), baseSat - 8, baseLight - 10),
    accent: pick(spin(165), Math.max(55, baseSat), baseLight + 8),
    dark: pick(baseHue, baseSat - 14, Math.max(18, baseLight - 26)),
    light: pick(baseHue, Math.max(28, baseSat - 12), Math.min(88, baseLight + 22)),
  };
}

/* ---------- archetype builders ---------- */

/**
 * Every builder works in metres and stacks upward from the ground, the same way
 * the schema asks the model to. A person is about 1.8 tall, so a statue on a
 * pedestal lands near 3 and a tower near 6.
 */
const part = (shape, w, h, d, x, y, z, color, extra = {}) => ({
  shape,
  width: w,
  height: h,
  depth: d,
  offsetX: x,
  offsetY: y,
  offsetZ: z,
  rotationX: extra.rx ?? 0,
  rotationY: extra.ry ?? 0,
  rotationZ: extra.rz ?? 0,
  color,
});

const BUILDERS = {
  statue(s, c, rng) {
    const lean = (rng() - 0.5) * 0.5;
    return [
      part('box', 2.2 * s, 0.5 * s, 2.2 * s, 0, 0.25 * s, 0, c.dark),
      part('box', 1.7 * s, 0.28 * s, 1.7 * s, 0, 0.64 * s, 0, c.secondary),
      part('cylinder', 0.9 * s, 1.7 * s, 0.9 * s, 0, 1.63 * s, 0, c.primary),
      part('box', 1.5 * s, 0.22 * s, 0.22 * s, 0.1 * s, 2.3 * s, 0, c.primary, { rz: 0.5 + lean }),
      part('sphere', 0.68 * s, 0.68 * s, 0.68 * s, 0, 2.82 * s, 0, c.light),
    ];
  },

  tower(s, c, rng) {
    const tall = (3.4 + rng() * 1.6) * s;
    return [
      part('box', 2.6 * s, 0.6 * s, 2.6 * s, 0, 0.3 * s, 0, c.dark),
      part('box', 1.9 * s, tall, 1.9 * s, 0, 0.6 * s + tall / 2, 0, c.primary),
      part('sphere', 0.9 * s, 0.9 * s, 0.9 * s, 0, 0.6 * s + tall * 0.78, 1 * s, c.light),
      part('box', 2.3 * s, 0.24 * s, 2.3 * s, 0, 0.72 * s + tall, 0, c.secondary),
      part('cone', 2.5 * s, 1.7 * s, 2.5 * s, 0, 1.7 * s + tall, 0, c.accent),
    ];
  },

  building(s, c, rng) {
    const wide = (3.6 + rng() * 1.2) * s;
    return [
      part('box', wide, 2.6 * s, 3.4 * s, 0, 1.3 * s, 0, c.primary),
      part('box', 0.9 * s, 1.6 * s, 0.14 * s, 0, 0.8 * s, 1.74 * s, c.dark),
      part('box', 0.8 * s, 0.7 * s, 0.14 * s, wide * 0.28, 1.9 * s, 1.74 * s, c.light),
      part('cone', wide * 1.25, 1.5 * s, wide * 1.25, 0, 3.35 * s, 0, c.accent),
    ];
  },

  vehicle(s, c, rng) {
    const long = (4.4 + rng() * 1.2) * s;
    const wheel = 0.9 * s;
    // Cylinders stand upright by default, so a wheel is one turned on its side.
    const axle = { rz: Math.PI / 2 };
    return [
      part('cylinder', wheel, 0.35 * s, wheel, -long * 0.3, wheel / 2, 1.1 * s, c.dark, axle),
      part('cylinder', wheel, 0.35 * s, wheel, long * 0.3, wheel / 2, 1.1 * s, c.dark, axle),
      part('cylinder', wheel, 0.35 * s, wheel, -long * 0.3, wheel / 2, -1.1 * s, c.dark, axle),
      part('cylinder', wheel, 0.35 * s, wheel, long * 0.3, wheel / 2, -1.1 * s, c.dark, axle),
      part('box', long, 1 * s, 2.3 * s, 0, 1.1 * s, 0, c.primary),
      part('box', long * 0.5, 0.85 * s, 2 * s, -long * 0.12, 2 * s, 0, c.light),
      part('sphere', 0.3 * s, 0.3 * s, 0.3 * s, long * 0.46, 1.2 * s, 0.7 * s, c.accent),
    ];
  },

  creature(s, c, rng) {
    const facing = rng() < 0.5 ? 1 : -1;
    const legY = 0.5 * s;
    return [
      part('box', 0.4 * s, 1 * s, 0.4 * s, -1 * s * facing, legY, 0.55 * s, c.secondary),
      part('box', 0.4 * s, 1 * s, 0.4 * s, -1 * s * facing, legY, -0.55 * s, c.secondary),
      part('box', 0.4 * s, 1 * s, 0.4 * s, 0.8 * s * facing, legY, 0.55 * s, c.secondary),
      part('box', 0.4 * s, 1 * s, 0.4 * s, 0.8 * s * facing, legY, -0.55 * s, c.secondary),
      part('box', 3.2 * s, 1.2 * s, 1.5 * s, 0, 1.6 * s, 0, c.primary, { rz: -0.08 * facing }),
      part('cylinder', 0.5 * s, 1.8 * s, 0.5 * s, -2.1 * s * facing, 1.9 * s, 0, c.secondary, { rz: 0.9 * facing }),
      part('sphere', 1.15 * s, 1.15 * s, 1.15 * s, 1.9 * s * facing, 2.3 * s, 0, c.light),
      part('cone', 1.1 * s, 1.1 * s, 1.1 * s, -0.2 * s * facing, 2.7 * s, 0, c.accent),
    ];
  },

  character(s, c, rng) {
    const head = (1.15 + rng() * 0.3) * s;
    return [
      part('cylinder', 0.5 * s, 0.9 * s, 0.5 * s, -0.45 * s, 0.45 * s, 0, c.secondary),
      part('cylinder', 0.5 * s, 0.9 * s, 0.5 * s, 0.45 * s, 0.45 * s, 0, c.secondary),
      part('box', 1.7 * s, 1.5 * s, 1.1 * s, 0, 1.65 * s, 0, c.primary),
      part('cylinder', 0.35 * s, 1.2 * s, 0.35 * s, -1.05 * s, 1.65 * s, 0, c.secondary, { rz: 0.2 }),
      part('cylinder', 0.35 * s, 1.2 * s, 0.35 * s, 1.05 * s, 1.65 * s, 0, c.secondary, { rz: -0.2 }),
      part('sphere', head, head, head, 0, 2.4 * s + head * 0.5, 0, c.light),
      part('sphere', 0.26 * s, 0.26 * s, 0.26 * s, -0.28 * s, 2.55 * s + head * 0.5, head * 0.42, c.dark),
      part('sphere', 0.26 * s, 0.26 * s, 0.26 * s, 0.28 * s, 2.55 * s + head * 0.5, head * 0.42, c.dark),
    ];
  },

  food(s, c, rng) {
    const layers = 2 + Math.floor(rng() * 2);
    const parts = [part('cylinder', 2.6 * s, 0.3 * s, 2.6 * s, 0, 0.15 * s, 0, c.dark)];
    let y = 0.3 * s;
    for (let i = 0; i < layers; i++) {
      const w = (2.2 - i * 0.4) * s;
      const h = (0.6 - i * 0.08) * s;
      parts.push(part('cylinder', w, h, w, 0, y + h / 2, 0, i % 2 ? c.light : c.primary));
      y += h;
    }
    parts.push(part('sphere', 0.5 * s, 0.5 * s, 0.5 * s, 0, y + 0.25 * s, 0, c.accent));
    return parts;
  },

  tree(s, c, rng) {
    const trunk = (2 + rng() * 0.9) * s;
    return [
      part('cylinder', 0.55 * s, trunk, 0.55 * s, 0, trunk / 2, 0, c.dark),
      part('sphere', 2.1 * s, 2.1 * s, 2.1 * s, -0.6 * s, trunk + 0.3 * s, 0.3 * s, c.secondary),
      part('sphere', 2.1 * s, 2.1 * s, 2.1 * s, 0.6 * s, trunk + 0.5 * s, -0.3 * s, c.primary),
      part('sphere', 2.4 * s, 2.4 * s, 2.4 * s, 0, trunk + 1.2 * s, 0, c.light),
    ];
  },

  ride(s, c) {
    // A ferris wheel read as a ring of cars, which is what makes it legible
    // from the ground rather than just a big disc.
    const parts = [
      part('box', 0.5 * s, 5 * s, 0.5 * s, -1.6 * s, 2.5 * s, 0, c.dark, { rz: -0.3 }),
      part('box', 0.5 * s, 5 * s, 0.5 * s, 1.6 * s, 2.5 * s, 0, c.dark, { rz: 0.3 }),
      part('cylinder', 0.7 * s, 0.6 * s, 0.7 * s, 0, 5 * s, 0, c.accent, { rz: Math.PI / 2 }),
    ];
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      parts.push(part(
        'box', 0.8 * s, 0.8 * s, 0.8 * s,
        Math.cos(angle) * 2.9 * s, 5 * s + Math.sin(angle) * 2.9 * s, 0,
        i % 2 ? c.primary : c.secondary,
      ));
    }
    return parts;
  },

  /**
   * The fallback for a word we do not know, which at a booth is a lot of them.
   * A tapering stack reads as a deliberate object; equal blobs read as a smudge.
   */
  blob(s, c, rng) {
    const stack = 3 + Math.floor(rng() * 2);
    const round = rng() < 0.5;
    const parts = [];
    let y = 0;
    for (let i = 0; i < stack; i++) {
      const w = (2.4 - i * 0.5) * s;
      const h = (1.1 - i * 0.18) * s;
      parts.push(part(
        round ? 'sphere' : 'box',
        w, h, w,
        (rng() - 0.5) * 0.2 * s, y + h / 2, (rng() - 0.5) * 0.2 * s,
        [c.primary, c.light, c.secondary, c.accent][i % 4],
        { ry: rng() * 0.6 },
      ));
      y += h * 0.92;
    }
    return parts;
  },
};

/* ---------- the entry point ---------- */

/**
 * Build a structure from a prompt, with no network and no model.
 *
 * @param {string} prompt
 * @returns {object} a raw structure - still needs normalizeStructure() before use
 */
export function buildOffline(prompt) {
  const read = readPrompt(prompt);
  const rng = makeRng(seedFrom(String(prompt).toLowerCase().trim()));
  const palette = buildPalette(read, rng);

  // A little size variation on top of the size words, so ten people typing
  // "a dragon" do not get ten identical dragons standing in a row.
  const scale = read.scale * (0.92 + rng() * 0.18);
  const build = BUILDERS[read.archetype] ?? BUILDERS.blob;

  return {
    label: prompt,
    subject: read.archetype === 'creature' ? 'creature'
      : read.archetype === 'character' ? 'character'
        : 'object',
    bounciness: read.material?.bounce ?? 0.2,
    parts: build(scale, palette, rng),
  };
}

/** Names that describe the shape without naming anyone. */
const ARCHETYPE_LABELS = {
  statue: 'a statue', tower: 'a tower', building: 'a building',
  vehicle: 'a vehicle', creature: 'a creature', character: 'a character',
  food: 'a snack', tree: 'a tree', ride: 'a fairground ride', blob: 'a mystery exhibit',
};

/**
 * Stock prompts for attract mode, so an idle screen fills the park with
 * something varied rather than the same exhibit over and over.
 */
export const ATTRACT_PROMPTS = [
  'a marble statue', 'a ferris wheel', 'a giant purple dragon', 'a clock tower',
  'a bouncy castle', 'a school bus', 'a rainbow tree', 'a giant robot',
  'a stone lighthouse', 'a golden trophy', 'a wooden cabin', 'a huge donut',
  'a tiny dinosaur', 'a rocket', 'a snack stand', 'a green monster',
];

/**
 * Build an exhibit from a prompt, with no network and no model.
 *
 * @param {string} prompt
 * @param {{anonymise?: boolean}} [options] - anonymise drops the typed text from
 *   the sign. Offline there is no model to classify whether a prompt names a
 *   real person, so when the booth is not set to `allow` we never put typed
 *   text on a sign at all.
 */
export function buildFromPrompt(prompt, { anonymise = false } = {}) {
  const read = readPrompt(prompt);
  return {
    ...buildOffline(prompt),
    label: anonymise ? ARCHETYPE_LABELS[read.archetype] : prompt,
    source: 'generated',
  };
}
