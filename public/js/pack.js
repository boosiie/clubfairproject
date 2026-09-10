/**
 * pack.js - choosing an object from the offline pack.
 *
 * Shared by the server (when it is over budget or has no key) and the browser
 * (when the network is gone), so "offline" behaves the same in both places.
 *
 * Keyword matching rather than a random draw matters more than it looks: when
 * the wifi dies, typing "bowling ball" and getting a bowling ball keeps the
 * illusion alive. Nobody at the booth needs to know the model is unreachable.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'made', 'out', 'that', 'is', 'it', 'and', 'with',
  'my', 'some', 'very', 'really', 'giant', 'huge', 'big', 'small', 'tiny',
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
 * @param {{objects: Array<object>}} pack
 * @param {string} [prompt]
 * @returns {object} a raw spec - still needs normalizeSpec() before use
 */
export function pickFromPack(pack, prompt = '') {
  const objects = pack?.objects ?? [];
  if (!objects.length) return {};

  const tokens = tokenize(prompt);
  if (!tokens.length) return randomOf(objects);

  let best = [];
  let bestScore = 0;

  for (const object of objects) {
    let score = 0;
    tokens.forEach((token, index) => {
      // Earlier words count for more. In "an anvil the size of a car" both
      // "anvil" and "car" are real objects in the pack, but the head noun is
      // the one the person meant, and in English it comes first.
      const positionWeight = 1 / (1 + index * 0.35);

      for (const keyword of object.keywords ?? []) {
        // Prefix matching so "bouncing" hits "bouncy" and "melons" hits "melon".
        if (token === keyword) score += 3 * positionWeight;
        else if (token.startsWith(keyword) || keyword.startsWith(token)) score += 2 * positionWeight;
      }
      if (String(object.label ?? '').toLowerCase().includes(token)) score += positionWeight;
    });
    if (score > bestScore) {
      bestScore = score;
      best = [object];
    } else if (score === bestScore && score > 0) {
      best.push(object);
    }
  }

  return bestScore > 0 ? randomOf(best) : randomOf(objects);
}

function randomOf(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Nudge a pack object so repeat draws are not visibly identical. The offline
 * pack is only 32 objects and a busy booth will cycle it many times over.
 */
export function jitter(spec) {
  const scale = 0.82 + Math.random() * 0.36;
  return {
    ...spec,
    width: Math.round(spec.width * scale),
    height: Math.round(spec.height * scale),
    restitution: spec.restitution * (0.9 + Math.random() * 0.2),
  };
}
