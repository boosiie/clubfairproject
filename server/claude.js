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
 * Enough for six parts of JSON with headroom. Larger than the old single-object
 * schema needed, still small enough that a response lands in about a second.
 */
const MAX_TOKENS = 1200;

const SYSTEM = [
  'You build exhibits for a walkable 2D amusement park. Someone types a short',
  'phrase and you turn it into one structure made of a few simple parts.',
  'Always call the build_structure tool exactly once. Never write prose.',
  '',
  'Think in silhouettes. You have rectangles, circles, polygons and capsules,',
  'and a person will recognise the thing from its outline alone. A statue is a',
  'wide pedestal, a narrow body and a head. A tower is a tall box with a',
  'triangle on top. A creature is a body with legs, a head and maybe a tail.',
  'Three to six parts is usually right; one or two looks unfinished.',
  '',
  'Parts stack upward from the ground. offsetY is how high the centre of a part',
  'sits above the ground, so build from the base up and let parts overlap a',
  'little - they are welded into one rigid object, and overlapping reads as',
  'solid rather than as a gap.',
  '',
  'Exaggerate. This is a cartoon park on a big screen, so use saturated colours',
  'and bold proportions. Anchor only genuinely permanent architecture; leave',
  'everything else free so it can be knocked over, which is half the fun.',
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
        'rectangle for bodies, walls and planks; circle for heads, wheels and balls; ' +
        'polygon for roofs, cones and spikes; capsule for limbs, logs and rounded bodies.',
    },
    width: {
      type: 'number',
      description:
        `Width in pixels, ${LIMITS.width.min}-${LIMITS.width.max}. For circle and polygon ` +
        'this is the diameter and height is ignored. A person is about 60 wide and 170 tall.',
    },
    height: { type: 'number', description: `Height in pixels, ${LIMITS.height.min}-${LIMITS.height.max}.` },
    offsetX: {
      type: 'number',
      description: `Sideways offset from the centre of the plot, ${LIMITS.offsetX.min} to ${LIMITS.offsetX.max}. 0 is centred.`,
    },
    offsetY: {
      type: 'number',
      description:
        `Height of this part's centre above the ground, ${LIMITS.offsetY.min} to ${LIMITS.offsetY.max}. ` +
        'A part of height 80 resting on the ground has offsetY 40.',
    },
    rotation: {
      type: 'number',
      description: 'Tilt in radians, -3.14 to 3.14. Use 0 unless the part is meant to lean, like an arm or a ramp.',
    },
    sides: {
      type: 'integer',
      description: `Sides when shape is polygon, ${LIMITS.sides.min}-${LIMITS.sides.max}. Use 3 for a roof or cone. Ignored otherwise.`,
    },
    color: { type: 'string', description: 'Fill colour as #rrggbb hex. Bright and saturated - this is going on a projector.' },
  },
  required: ['shape', 'width', 'height', 'offsetX', 'offsetY', 'rotation', 'sides', 'color'],
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
      anchored: {
        type: 'boolean',
        description:
          'True only for permanent architecture that should be bolted down and never topple. ' +
          'False for almost everything - being knocked over is half the fun.',
      },
      density: {
        type: 'number',
        description:
          `How heavy for its size, ${LIMITS.density.min}-${LIMITS.density.max}. ` +
          'Anchors: 0.0008 inflatable, 0.003 wood, 0.008 stone, 0.02 solid metal.',
      },
      restitution: {
        type: 'number',
        description:
          `Bounciness, ${LIMITS.restitution.min}-${LIMITS.restitution.max}. ` +
          'Anchors: 0.02 stone, 0.1 wood, 0.4 rubber, 0.8 a bouncy castle.',
      },
      parts: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PARTS,
        description:
          `The parts, built from the ground up. Keep the whole structure within ` +
          `${STRUCTURE_MAX.width} wide and ${STRUCTURE_MAX.height} tall.`,
        items: PART_SCHEMA,
      },
    },
    required: ['label', 'subject', 'anchored', 'density', 'restitution', 'parts'],
    additionalProperties: false,
  },
};

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic({
      // A booth cannot wait. Worst case here is ~14s wall clock (one retry),
      // and the browser gives up at 10s and uses its offline pack instead, so
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
