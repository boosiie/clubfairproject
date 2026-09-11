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
import { matchPack, jitter } from './pack.js';

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
  jello: { density: 0.0009, restitution: 0.85, hue: 330, sat: 78, light: 66 },
  jelly: { density: 0.0009, restitution: 0.85, hue: 330, sat: 78, light: 66 },
  rubber: { density: 0.0022, restitution: 0.8, hue: 12, sat: 40, light: 44 },
  bouncy: { density: 0.0018, restitution: 0.85, hue: 90, sat: 72, light: 58 },
  balloon: { density: 0.0006, restitution: 0.78, hue: 0, sat: 78, light: 62 },
  inflatable: { density: 0.0007, restitution: 0.78, hue: 210, sat: 72, light: 58 },
  foam: { density: 0.0008, restitution: 0.5, hue: 40, sat: 50, light: 70 },
  slime: { density: 0.0012, restitution: 0.6, hue: 110, sat: 80, light: 50 },
  cheese: { density: 0.0015, restitution: 0.35, hue: 45, sat: 85, light: 58 },
  wood: { density: 0.0032, restitution: 0.18, hue: 28, sat: 44, light: 40 },
  wooden: { density: 0.0032, restitution: 0.18, hue: 28, sat: 44, light: 40 },
  plastic: { density: 0.0022, restitution: 0.42, hue: 200, sat: 70, light: 58 },
  glass: { density: 0.004, restitution: 0.22, hue: 190, sat: 45, light: 72 },
  ice: { density: 0.0022, restitution: 0.2, hue: 192, sat: 62, light: 70 },
  paper: { density: 0.0007, restitution: 0.1, hue: 45, sat: 25, light: 82 },
  stone: { density: 0.011, restitution: 0.04, hue: 30, sat: 8, light: 56 },
  rock: { density: 0.011, restitution: 0.04, hue: 30, sat: 8, light: 52 },
  concrete: { density: 0.012, restitution: 0.03, hue: 210, sat: 5, light: 58 },
  marble: { density: 0.011, restitution: 0.04, hue: 40, sat: 10, light: 84 },
  brick: { density: 0.009, restitution: 0.05, hue: 12, sat: 50, light: 44 },
  metal: { density: 0.015, restitution: 0.12, hue: 210, sat: 10, light: 62 },
  steel: { density: 0.016, restitution: 0.12, hue: 210, sat: 8, light: 60 },
  iron: { density: 0.017, restitution: 0.08, hue: 215, sat: 8, light: 45 },
  gold: { density: 0.019, restitution: 0.1, hue: 45, sat: 85, light: 55 },
  silver: { density: 0.014, restitution: 0.12, hue: 210, sat: 6, light: 76 },
  bronze: { density: 0.015, restitution: 0.1, hue: 30, sat: 45, light: 45 },
  lead: { density: 0.02, restitution: 0.02, hue: 250, sat: 6, light: 42 },
  diamond: { density: 0.013, restitution: 0.2, hue: 185, sat: 55, light: 80 },
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
    light: pick(baseHue, Math.max(12, baseSat - 30), Math.min(90, baseLight + 26)),
  };
}

/* ---------- archetype builders ---------- */

const part = (shape, width, height, offsetX, offsetY, color, extra = {}) => ({
  shape,
  width: Math.round(width),
  height: Math.round(height),
  offsetX: Math.round(offsetX),
  offsetY: Math.round(offsetY),
  rotation: extra.rotation ?? 0,
  sides: extra.sides ?? 4,
  color,
});

const BUILDERS = {
  statue(s, c, rng) {
    const lean = (rng() - 0.5) * 0.5;
    return [
      part('rectangle', 170 * s, 62 * s, 0, 31 * s, c.dark),
      part('rectangle', 132 * s, 26 * s, 0, 75 * s, c.secondary),
      part('capsule', 78 * s, 160 * s, 0, 168 * s, c.primary),
      part('rectangle', 104 * s, 22 * s, 44 * s, 232 * s, c.primary, { rotation: -0.75 + lean }),
      part('circle', 58 * s, 58 * s, 0, 277 * s, c.light),
    ];
  },

  tower(s, c, rng) {
    const tall = 200 + rng() * 90;
    return [
      part('rectangle', 168 * s, 60 * s, 0, 30 * s, c.dark),
      part('rectangle', 126 * s, tall * s, 0, (60 + tall / 2) * s, c.primary),
      part('circle', 74 * s, 74 * s, 0, (60 + tall * 0.72) * s, c.light),
      part('rectangle', 150 * s, 22 * s, 0, (72 + tall) * s, c.secondary),
      part('polygon', 172 * s, 172 * s, 0, (128 + tall) * s, c.accent, { sides: 3 }),
    ];
  },

  building(s, c, rng) {
    const wide = 250 + rng() * 60;
    return [
      part('rectangle', wide * s, 180 * s, 0, 90 * s, c.primary),
      part('rectangle', 62 * s, 96 * s, -wide * 0.22 * s, 48 * s, c.dark),
      part('rectangle', 54 * s, 50 * s, wide * 0.24 * s, 120 * s, c.light),
      part('polygon', (wide + 50) * s, (wide + 50) * s, 0, 246 * s, c.accent, { sides: 3 }),
    ];
  },

  vehicle(s, c, rng) {
    const long = 290 + rng() * 70;
    return [
      part('circle', 76 * s, 76 * s, -long * 0.3 * s, 38 * s, c.dark),
      part('circle', 76 * s, 76 * s, long * 0.3 * s, 38 * s, c.dark),
      part('rectangle', long * s, 92 * s, 0, 104 * s, c.primary),
      part('rectangle', long * 0.5 * s, 74 * s, -long * 0.1 * s, 186 * s, c.light),
      part('circle', 26 * s, 26 * s, long * 0.44 * s, 118 * s, c.accent),
    ];
  },

  creature(s, c, rng) {
    const facing = rng() < 0.5 ? 1 : -1;
    return [
      part('rectangle', 30 * s, 74 * s, -58 * facing * s, 37 * s, c.secondary),
      part('rectangle', 30 * s, 74 * s, 34 * facing * s, 37 * s, c.secondary),
      part('capsule', 220 * s, 104 * s, 0, 126 * s, c.primary, { rotation: -0.08 * facing }),
      part('capsule', 128 * s, 38 * s, -142 * facing * s, 158 * s, c.secondary, { rotation: 0.55 * facing }),
      part('circle', 96 * s, 96 * s, 116 * facing * s, 190 * s, c.light),
      part('polygon', 104 * s, 104 * s, -6 * facing * s, 214 * s, c.accent, { sides: 3 }),
    ];
  },

  character(s, c, rng) {
    const head = 116 + rng() * 26;
    return [
      part('capsule', 50 * s, 62 * s, -40 * s, 31 * s, c.secondary),
      part('capsule', 50 * s, 62 * s, 40 * s, 31 * s, c.secondary),
      part('capsule', 156 * s, 132 * s, 0, 126 * s, c.primary),
      part('circle', head * s, head * s, 0, (192 + head * 0.5) * s, c.light),
      part('circle', 30 * s, 30 * s, -28 * s, (206 + head * 0.5) * s, c.dark),
      part('circle', 30 * s, 30 * s, 28 * s, (206 + head * 0.5) * s, c.dark),
    ];
  },

  food(s, c, rng) {
    const layers = 2 + Math.floor(rng() * 2);
    const parts = [part('rectangle', 230 * s, 44 * s, 0, 22 * s, c.dark)];
    let y = 44;
    for (let i = 0; i < layers; i++) {
      const w = (200 - i * 34) * s;
      const h = (62 - i * 8) * s;
      parts.push(part('capsule', w, h, (rng() - 0.5) * 20 * s, (y + h / 2 / s) * s, i % 2 ? c.light : c.primary));
      y += h / s;
    }
    parts.push(part('circle', 46 * s, 46 * s, 0, (y + 26) * s, c.accent));
    return parts;
  },

  tree(s, c, rng) {
    const trunk = 170 + rng() * 60;
    return [
      part('rectangle', 54 * s, trunk * s, 0, (trunk / 2) * s, c.dark),
      part('circle', 168 * s, 168 * s, -74 * s, (trunk + 20) * s, c.secondary),
      part('circle', 168 * s, 168 * s, 74 * s, (trunk + 34) * s, c.primary),
      part('circle', 196 * s, 196 * s, 0, (trunk + 92) * s, c.light),
    ];
  },

  ride(s, c) {
    return [
      part('rectangle', 26 * s, 250 * s, -84 * s, 125 * s, c.dark, { rotation: 0.32 }),
      part('rectangle', 26 * s, 250 * s, 84 * s, 125 * s, c.dark, { rotation: -0.32 }),
      part('circle', 296 * s, 296 * s, 0, 300 * s, c.primary),
      part('circle', 190 * s, 190 * s, 0, 300 * s, c.secondary),
      part('circle', 84 * s, 84 * s, 0, 300 * s, c.accent),
    ];
  },

  /**
   * The fallback for a word we do not know, which at a booth is a lot of them.
   * A tapering stack reads as a deliberate object; heavily overlapped blobs of
   * the same size just read as a smudge.
   */
  blob(s, c, rng) {
    const stack = 3 + Math.floor(rng() * 2);
    const round = rng() < 0.5;
    const parts = [];
    let y = 0;
    for (let i = 0; i < stack; i++) {
      const w = (210 - i * 46) * s;
      const h = (116 - i * 20) * s;
      parts.push(part(
        round ? 'circle' : 'capsule',
        w,
        h,
        (rng() - 0.5) * 16 * s,
        y + h / 2,
        [c.primary, c.light, c.secondary, c.accent][i % 4],
      ));
      y += h * 0.95;
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
    anchored: read.archetype === 'ride' || read.archetype === 'tower',
    density: read.material?.density ?? 0.004,
    restitution: read.material?.restitution ?? 0.12,
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
 * A pack hit this strong beats anything the generator produces. Roughly: the
 * head noun of the prompt is one of the pack's own keywords.
 */
const PACK_MATCH_THRESHOLD = 3.5;

/**
 * The whole offline path in one call: pick a hand-authored exhibit when the
 * pack genuinely knows the thing, and generate one when it does not.
 *
 * The split is by adjectives. The pack has a beautiful ferris wheel but only
 * one, in one colour; the generator has no beautiful ferris wheel but does
 * understand "purple" and "made of jello". So a bare noun goes to the pack and
 * anything with a colour or a material goes to the generator.
 *
 * @param {object} pack
 * @param {string} prompt
 * @param {{anonymise?: boolean}} [options] - anonymise drops the typed text
 *   from the sign. Offline there is no model to classify whether a prompt names
 *   a real person, so when the booth is not set to `allow` we simply never put
 *   typed text on a sign.
 */
export function buildFromPrompt(pack, prompt, { anonymise = false } = {}) {
  const read = readPrompt(prompt);
  const described = Boolean(read.material || read.hue !== null || read.rainbow);

  if (!described) {
    const { structure, score } = matchPack(pack, prompt);
    if (score >= PACK_MATCH_THRESHOLD) {
      return { ...jitter(structure), label: anonymise ? structure.label : prompt, source: 'pack' };
    }
  }

  return {
    ...buildOffline(prompt),
    label: anonymise ? ARCHETYPE_LABELS[read.archetype] : prompt,
    source: 'generated',
  };
}
