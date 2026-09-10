/**
 * pack.js - choosing a structure from the offline pack.
 *
 * Shared by the server (when it is over budget or has no key) and the browser
 * (when the network is gone), so "offline" behaves the same in both places.
 *
 * Keyword matching rather than a random draw matters more than it looks: when
 * the wifi dies, typing "a statue of my chemistry teacher" and getting a statue
 * keeps the illusion alive. Nobody at the booth needs to know the model is
 * unreachable.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'made', 'out', 'that', 'is', 'it', 'and', 'with',
  'my', 'some', 'very', 'really', 'giant', 'huge', 'big', 'small', 'tiny',
  'build', 'make', 'add', 'put', 'here', 'please', 'want', 'can', 'you',
]);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * Pick the pack entry that best matches a prompt.
 *
 * @param {{structures: Array<object>}} pack
 * @param {string} [prompt]
 * @returns {object} a raw structure - still needs normalizeStructure() before use
 */
export function pickFromPack(pack, prompt = '') {
  const structures = pack?.structures ?? [];
  if (!structures.length) return {};

  const tokens = tokenize(prompt);
  if (!tokens.length) return randomOf(structures);

  let best = [];
  let bestScore = 0;

  for (const structure of structures) {
    let score = 0;
    tokens.forEach((token, index) => {
      // Earlier words count for more. In "a statue of a dragon" both "statue"
      // and "dragon" are in the pack, but the head noun is what was meant, and
      // in English it comes first.
      const positionWeight = 1 / (1 + index * 0.35);

      for (const keyword of structure.keywords ?? []) {
        // Prefix matching so "roboticist" hits "robot" and "trees" hits "tree".
        if (token === keyword) score += 3 * positionWeight;
        else if (token.startsWith(keyword) || keyword.startsWith(token)) score += 2 * positionWeight;
      }
      if (String(structure.label ?? '').toLowerCase().includes(token)) score += positionWeight;
    });

    if (score > bestScore) {
      bestScore = score;
      best = [structure];
    } else if (score === bestScore && score > 0) {
      best.push(structure);
    }
  }

  return bestScore > 0 ? randomOf(best) : randomOf(structures);
}

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Nudge a structure so repeat draws are not visibly identical. The pack is only
 * sixteen entries and a busy booth will cycle it many times over.
 *
 * Scales the whole structure rather than each part, so proportions survive.
 */
export function jitter(structure) {
  const parts = structure.parts ?? [];
  if (!parts.length) return structure;

  const scale = 0.85 + Math.random() * 0.3;
  const hueShift = Math.random() < 0.5;

  return {
    ...structure,
    parts: parts.map((part) => ({
      ...part,
      width: Math.round(part.width * scale),
      height: Math.round(part.height * scale),
      offsetX: Math.round(part.offsetX * scale),
      offsetY: Math.round(part.offsetY * scale),
      color: hueShift ? nudgeColor(part.color) : part.color,
    })),
  };
}

/** Shift a colour slightly so two copies of the same exhibit are distinguishable. */
function nudgeColor(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const delta = Math.round((Math.random() - 0.5) * 40);
  return '#' + [1, 3, 5]
    .map((i) => Math.max(0, Math.min(255, parseInt(hex.slice(i, i + 2), 16) + delta)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
