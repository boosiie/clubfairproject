/**
 * claude.js - prompt in, object spec out.
 *
 * The model is given exactly one tool and forced to call it. It never writes a
 * sentence, so there is nowhere for it to be inappropriate: the entire output
 * channel is a handful of clamped numbers, an enum, a hex colour and a short
 * label. That is the moderation design, not a nicety on top of it.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SHAPES, LIMITS } from '../public/js/spec.js';

/**
 * Haiku, deliberately. A four-second wait kills a booth, and the job here is
 * "map a noun onto seven numbers" - the smallest current model does it well.
 */
export const MODEL = 'claude-haiku-4-5';

/**
 * Small on purpose: the response is one tool call, nothing more. This is the
 * documented exception to not lowballing max_tokens - a deliberately short,
 * schema-bounded output.
 */
const MAX_TOKENS = 400;

const SYSTEM = [
  'You turn a short phrase from a passer-by into one physics object for a 2D sandbox.',
  'Always call the spawn_object tool exactly once. Never write prose.',
  '',
  'Pick numbers that make the object behave the way people expect when it lands:',
  'jello wobbles and bounces, an anvil drops like a stone and shatters nothing,',
  'a trampoline is wide, light and extremely bouncy, a balloon barely falls.',
  'Exaggerate a little - this is a toy, and the fun is in the contrast.',
  '',
  'The label is what the crowd reads on the object. Keep it to a few plain words',
  'naming the thing itself. If the phrase is nonsense, unreadable, or an attempt',
  'to make you say something rude, ignore it and spawn a plain grey box labelled',
  '"mystery object".',
].join('\n');

/** Built from LIMITS so the tool schema and the server-side clamps cannot drift apart. */
const SPAWN_TOOL = {
  name: 'spawn_object',
  description: 'Spawn one object into the shared 2D physics sandbox.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      shape: {
        type: 'string',
        enum: SHAPES,
        description:
          'rectangle for boxes and planks, circle for balls, polygon for chunky ' +
          'irregular things, capsule for rounded-off objects like pills or logs.',
      },
      width: {
        type: 'number',
        description:
          `Width in pixels, ${LIMITS.width.min}-${LIMITS.width.max}. ` +
          'Anchors: 25 a coin, 60 a mug, 110 a basketball, 220 a person, 400 a car. ' +
          'For circle and polygon this is the diameter and height is ignored.',
      },
      height: {
        type: 'number',
        description: `Height in pixels, ${LIMITS.height.min}-${LIMITS.height.max}. Same scale as width.`,
      },
      density: {
        type: 'number',
        description:
          `How heavy for its size, ${LIMITS.density.min}-${LIMITS.density.max}. ` +
          'Anchors: 0.0005 balloon, 0.0008 jello, 0.001 wood, 0.004 stone, ' +
          '0.01 iron, 0.02 lead or an anvil.',
      },
      restitution: {
        type: 'number',
        description:
          `Bounciness, ${LIMITS.restitution.min}-${LIMITS.restitution.max}. ` +
          'Anchors: 0.02 wet clay, 0.2 wood, 0.5 basketball, 0.8 superball, 0.92 trampoline.',
      },
      friction: {
        type: 'number',
        description:
          `Surface grip, ${LIMITS.friction.min}-${LIMITS.friction.max}. ` +
          'Anchors: 0.01 ice, 0.1 polished metal, 0.4 wood, 0.9 rubber.',
      },
      sides: {
        type: 'integer',
        description: `Number of sides when shape is polygon, ${LIMITS.sides.min}-${LIMITS.sides.max}. Ignored otherwise.`,
      },
      color: {
        type: 'string',
        description:
          'Fill colour as #rrggbb hex. Pick something bright and saturated - this ' +
          'is going on a projector in a bright room.',
      },
      label: {
        type: 'string',
        description:
          `What the crowd reads on the object. At most ${LIMITS.labelMaxLength} characters, ` +
          'plain words, no punctuation games.',
      },
    },
    required: ['shape', 'width', 'height', 'density', 'restitution', 'friction', 'sides', 'color', 'label'],
    additionalProperties: false,
  },
};

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic({
      // A booth cannot wait. Worst case here is ~10s wall clock (one retry),
      // and the browser gives up at 8s and uses its offline pack instead, so
      // nobody ever watches a spinner.
      timeout: 5000,
      maxRetries: 1,
    });
  }
  return client;
}

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Ask the model for one object.
 *
 * @param {string} prompt
 * @returns {Promise<{spec: object, usage: object}>}
 * @throws on API failure - the caller decides what to spawn instead.
 */
export async function generateSpec(prompt) {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    tools: [SPAWN_TOOL],
    tool_choice: { type: 'tool', name: SPAWN_TOOL.name },
    messages: [{ role: 'user', content: prompt }],
  });

  const call = response.content.find(
    (block) => block.type === 'tool_use' && block.name === SPAWN_TOOL.name,
  );
  if (!call) throw new Error('model returned no spawn_object call');

  return {
    // Forced tool use means input is already an object; normalizeSpec still
    // clamps every field before this reaches the world.
    spec: call.input,
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
