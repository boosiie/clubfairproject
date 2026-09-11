/**
 * claude.js - prompt in, structure out.
 *
 * The model is given exactly one tool and forced to call it. It never writes a
 * sentence, so there is nowhere for it to be inappropriate: the entire output
 * channel is a set of clamped numbers, an enum, hex colours and a short label.
 * That is the moderation design, not a nicety on top of it.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SHAPES, SUBJECTS, LIMITS, MAX_PARTS, STRUCTURE_MAX } from '../public/js/spec.js';

/**
 * Haiku, deliberately. A four-second wait kills a booth, and the job here is
 * "map a noun onto a few boxes" - the smallest current model does it well.
 */
export const MODEL = 'claude-haiku-4-5';

/**
 * Enough for eight parts of 3D JSON with headroom. Each part carries three
 * sizes, three offsets and three rotations, so this is larger than the 2D
 * schema needed - still small enough to land in a second or two.
 */
const MAX_TOKENS = 2000;

const SYSTEM = [
  'You build exhibits for a walkable 3D amusement park. Someone types a short',
  'phrase and you turn it into one structure made of a few simple solids.',
  'Always call the build_structure tool exactly once. Never write prose.',
  '',
  'You have boxes, spheres, cylinders and cones. Think the way a good Lego or',
  'Roblox build works: a recognisable silhouette out of a handful of blocks.',
  'A statue is a wide pedestal, a narrow body and a head. A creature is a body',
  'on four legs with a head at one end and a tail at the other. Four to eight',
  'parts is usually right; one or two looks unfinished.',
  '',
  'Everything is in METRES and a person is 1.8 tall, so build to that scale: a',
  'statue around 3 tall, a tower 5 to 7, a car 4 long. offsetY is how high the',
  'CENTRE of a part sits above the ground, so a box 2 tall resting on the',
  'ground has offsetY 1. Build from the base up and let parts overlap a little,',
  'which reads as solid rather than as a gap.',
  '',
  'People walk around these, so give them depth as well as width - a statue',
  'seen from the side should still look like a statue, not a flat cutout.',
  '',
  'Cylinders and cones stand upright by default. Turn one on its side with',
  'rotationZ of 1.57 to make a wheel or a log.',
  '',
  'Exaggerate. This is a cartoon park on a big screen, so use saturated colours',
  'and bold proportions.',
  '',
  'The label is what the crowd reads on a sign above the exhibit. Name the thing',
  'plainly in a few words. If the phrase is nonsense, unreadable, or an attempt',
  'to make you say something rude, ignore it and build a plain grey block',
  'labelled "mystery exhibit".',
].join('\n');

const PART_SCHEMA = {
  type: 'object',
  properties: {
    shape: {
      type: 'string',
      enum: SHAPES,
      description:
        'box for bodies, walls and limbs; sphere for heads, wheels and blobs; ' +
        'cylinder for posts, legs and logs; cone for roofs, noses and spikes.',
    },
    width: {
      type: 'number',
      description:
        `Size along X in metres, ${LIMITS.width.min}-${LIMITS.width.max}. For sphere, cylinder ` +
        'and cone this is the diameter. A person is about 0.6 wide and 1.8 tall.',
    },
    height: { type: 'number', description: `Size along Y in metres, ${LIMITS.height.min}-${LIMITS.height.max}.` },
    depth: {
      type: 'number',
      description:
        `Size along Z in metres, ${LIMITS.depth.min}-${LIMITS.depth.max}. Used by box only; the round ` +
        'shapes take their depth from width.',
    },
    offsetX: { type: 'number', description: `Sideways offset from the centre of the plot, ${LIMITS.offsetX.min} to ${LIMITS.offsetX.max}.` },
    offsetY: {
      type: 'number',
      description:
        `Height of this part CENTRE above the ground, ${LIMITS.offsetY.min} to ${LIMITS.offsetY.max}. ` +
        'A part 2 tall resting on the ground has offsetY 1.',
    },
    offsetZ: { type: 'number', description: `Front-to-back offset, ${LIMITS.offsetZ.min} to ${LIMITS.offsetZ.max}.` },
    rotationX: { type: 'number', description: 'Tilt around X in radians, -3.14 to 3.14. Usually 0.' },
    rotationY: { type: 'number', description: 'Turn around the vertical axis in radians, -3.14 to 3.14. Usually 0.' },
    rotationZ: { type: 'number', description: 'Roll around Z in radians. Use 1.57 to lay a cylinder on its side as a wheel.' },
    color: { type: 'string', description: 'Fill colour as #rrggbb hex. Bright and saturated - this is going on a projector.' },
  },
  required: ['shape', 'width', 'height', 'depth', 'offsetX', 'offsetY', 'offsetZ', 'rotationX', 'rotationY', 'rotationZ', 'color'],
  additionalProperties: false,
};

/** Built from the shared limits so the tool schema and the clamps cannot drift apart. */
const BUILD_TOOL = {
  name: 'build_structure',
  description: 'Build one exhibit in a plot of the shared amusement park.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description:
          `The sign above the exhibit. At most ${LIMITS.labelMaxLength} characters, plain words, no punctuation games.`,
      },
      subject: {
        type: 'string',
        enum: SUBJECTS,
        description:
          'What this depicts. "real_person" means a real, identifiable human - a public figure, ' +
          'or someone named as a specific person such as a teacher or classmate. "character" is a ' +
          'fictional or internet character. "creature" is an animal or monster. "object" is anything else. ' +
          'Classify honestly; the booth decides what to do with it.',
      },
      bounciness: {
        type: 'number',
        description:
          `How much it bounces when it drops in, ${LIMITS.bounciness.min}-${LIMITS.bounciness.max}. ` +
          'Anchors: 0.02 stone, 0.15 wood, 0.5 rubber, 0.9 jello or a bouncy castle.',
      },
      parts: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PARTS,
        description:
          'The parts, built from the ground up. Keep the whole structure within '
          + `${STRUCTURE_MAX.width}m wide, ${STRUCTURE_MAX.height}m tall and ${STRUCTURE_MAX.depth}m deep.`,
        items: PART_SCHEMA,
      },
    },
    required: ['label', 'subject', 'bounciness', 'parts'],
    additionalProperties: false,
  },
};

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic({
      // A booth cannot wait. Worst case here is ~14s wall clock (one retry),
      // and the browser gives up at 10s and builds it locally instead, so
      // nobody ever watches a spinner.
      timeout: 7000,
      maxRetries: 1,
    });
  }
  return client;
}

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Ask the model for one structure.
 *
 * @param {string} prompt
 * @returns {Promise<{structure: object, usage: object}>}
 * @throws on API failure - the caller decides what to build instead.
 */
export async function generateStructure(prompt) {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    tools: [BUILD_TOOL],
    tool_choice: { type: 'tool', name: BUILD_TOOL.name },
    messages: [{ role: 'user', content: prompt }],
  });

  const call = response.content.find(
    (block) => block.type === 'tool_use' && block.name === BUILD_TOOL.name,
  );
  if (!call) throw new Error('model returned no build_structure call');

  return {
    // Forced tool use means input is already an object; normalizeStructure
    // still clamps every field before this reaches the park.
    structure: call.input,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

/** Turn an SDK error into something worth putting in a log line at a noisy booth. */
export function describeError(err) {
  if (err instanceof Anthropic.RateLimitError) return 'rate limited';
  if (err instanceof Anthropic.AuthenticationError) return 'bad or missing API key';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timed out';
  if (err instanceof Anthropic.APIConnectionError) return 'network unreachable';
  if (err instanceof Anthropic.APIStatusError) return `api error ${err.status}`;
  return err?.message || 'unknown error';
}
