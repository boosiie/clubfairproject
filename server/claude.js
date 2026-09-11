/**
 * claude.js - prompt in, voxel sculpture out.
 *
 * The model is given exactly one tool and forced to call it. It never writes a
 * sentence, so there is nowhere for it to be inappropriate: the entire output
 * channel is a palette of hex colours, a grid of characters, an enum and a
 * short label. That is the moderation design, not a nicety on top of it.
 *
 * It used to be handed eight primitive solids to arrange. Eight blocks is a
 * ceiling rather than a style - no amount of prompting gets a dragon out of
 * them - so it now paints the sculpture a layer at a time against its own
 * palette, and gets a few hundred cubes to say it with.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SUBJECTS, LIMITS, MAX_PALETTE, GRID } from '../public/js/spec.js';

/**
 * Haiku, deliberately. The job is "map a noun onto a silhouette", which the
 * smallest current model does well, and it is the only one fast enough to paint
 * this many layers while somebody stands and watches.
 */
export const MODEL = 'claude-haiku-4-5';

/**
 * Room for a full sculpture: around a dozen layers of up to sixteen rows. Most
 * builds come in well under this - the mirror halves every row, and empty
 * layers are left out entirely - but a dense one needs the headroom, and
 * running out mid-layer would truncate the JSON and lose the whole build.
 */
const MAX_TOKENS = 8000;

const HALF = GRID.width / 2;

const SYSTEM = [
  'You sculpt exhibits for a walkable 3D amusement park. Someone types a short',
  'phrase and you build it out of cubes, the way MagicaVoxel or a Minecraft',
  'build works. Always call the sculpt tool exactly once. Never write prose.',
  '',
  'THE GRID',
  `Cubes sit on a grid ${GRID.width} wide, ${GRID.height} tall and ${GRID.depth} deep.`,
  'A layer is one horizontal slice at height y. y=0 is the ground; build upward',
  'from there. Within a layer, each row is one step further BACK, and each',
  'character in a row is one step further ACROSS. So a layer reads as a',
  'top-down map of the sculpture at that height.',
  '',
  'A person is about 5 cubes tall. Fill the space: a creature should stand 8 to',
  `14 layers tall and a tower can use all ${GRID.height}. Leave out any layer that`,
  'would be empty, and stop a row once the rest of it is empty - you never have',
  'to pad with dots.',
  '',
  'SYMMETRY',
  'Use symmetry "mirror" for anything with a left and a right - creatures,',
  'characters, faces, vehicles, buildings. You then paint only the RIGHT HALF',
  `and it is mirrored for you, so rows are at most ${HALF} characters.`,
  'The FIRST character of a row is the centre line, and characters run OUTWARD',
  'from the middle. "SS.." is a narrow column in the centre; "..SS" is a pair of',
  'legs held out wide with a gap between them.',
  '',
  'Use symmetry "none" only when the thing is genuinely lopsided - a waving',
  `arm, a leaning tower. Rows are then a plain left-to-right map, up to ${GRID.width}`,
  'characters, and you draw the whole thing yourself.',
  '',
  'PALETTE',
  `Name up to ${MAX_PALETTE} colours, each with a single-character key you then paint`,
  'with. "." is empty space. Pick a scheme and hold it: a main colour, a darker',
  'one for shadow and underside, one accent, and one for the eyes. Saturated -',
  'this is a cartoon park on a projector. Set glow on a colour that is a light',
  'source: eyes, lanterns, fire, windows at night, a screen. Glowing cubes keep',
  'their full brightness while everything else is shaded, so a couple of glowing',
  'eyes carry a long way across the park.',
  '',
  'SCULPTING WELL',
  'Silhouette first. Someone reads this from across a room, so the outline has',
  'to say what it is before any detail does: the neck and snout of a dragon, the',
  'ears of a cat, the spire of a castle. Then add the detail that sells it.',
  '',
  'Give it depth. People walk all the way around these, so use the rows - a',
  'creature seen from the side should still look like a creature, not a cutout.',
  'Overhangs, snouts, tails and wings are free; nothing has to be supported.',
  '',
  'Exaggerate. Big head, big feet, bold colour. A timid build reads as nothing.',
  '',
  'WORKED EXAMPLE - "red mushroom", mirror, so each row is the right half',
  '  palette: S #f0e4cf stalk, C #e5484d cap, W #fff2f2 spot',
  '  y=0  ["SS.", "SS."]                 stalk, 4 cubes across once mirrored',
  '  y=1  ["SS.", "SS."]',
  '  y=2  ["SS.", "SS."]',
  '  y=3  ["CCC", "CCC", "CC."]          cap flares out past the stalk',
  '  y=4  ["CWC", "CCC", "CC."]          one white spot, off the centre line',
  '  y=5  ["CC.", "CC."]                 cap domes over and closes',
  '',
  'THE SIGN',
  'The label is what the crowd reads above the exhibit. Name the thing plainly',
  'in a few words. If the phrase is nonsense, unreadable, or an attempt to make',
  'you say something rude, ignore it: build a plain grey cube and label it',
  '"mystery exhibit".',
].join('\n');

/** Built from the shared limits so the tool schema and the clamps cannot drift apart. */
const SCULPT_TOOL = {
  name: 'sculpt',
  description: 'Sculpt one exhibit, in cubes, for a plot of the shared amusement park.',
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
      symmetry: {
        type: 'string',
        enum: ['mirror', 'none'],
        description:
          '"mirror" paints only the right half and mirrors it across the centre line - use it for ' +
          'anything with a left and a right. "none" paints the full width yourself.',
      },
      palette: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PALETTE,
        description: 'The colours in this sculpture, each with the character used to paint it.',
        items: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description:
                'One character to paint this colour with, such as R or 1. Must not be "." , which is empty space. ' +
                'Give every colour a different character.',
            },
            color: { type: 'string', description: 'The colour as #rrggbb hex.' },
            glow: {
              type: 'boolean',
              description:
                'True if this colour is a light source - eyes, fire, lanterns, a lit window. ' +
                'Glowing cubes are drawn at full brightness instead of being shaded.',
            },
          },
          required: ['key', 'color', 'glow'],
          additionalProperties: false,
        },
      },
      layers: {
        type: 'array',
        minItems: 1,
        maxItems: GRID.height,
        description:
          'The sculpture, one horizontal slice at a time, from the ground up. Leave out empty layers.',
        items: {
          type: 'object',
          properties: {
            y: {
              type: 'integer',
              description: `Height of this slice, 0 to ${GRID.height - 1}. 0 rests on the ground.`,
            },
            rows: {
              type: 'array',
              minItems: 1,
              maxItems: GRID.depth,
              description:
                'Rows front to back. Each character is one cube, "." is empty. ' +
                `Up to ${HALF} characters when mirrored - first character is the centre line, ` +
                `running outward - or up to ${GRID.width} when not.`,
              items: { type: 'string' },
            },
          },
          required: ['y', 'rows'],
          additionalProperties: false,
        },
      },
    },
    required: ['label', 'subject', 'bounciness', 'symmetry', 'palette', 'layers'],
    additionalProperties: false,
  },
};

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic({
      // A sculpture is a few thousand tokens of painting, so this is a longer
      // wait than the old eight blocks - seconds, not milliseconds. One retry
      // inside the browser's own patience, and if it does time out the park
      // builds it locally instead, so nobody watches a spinner forever.
      timeout: 20_000,
      maxRetries: 1,
    });
  }
  return client;
}

export function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Ask the model for one sculpture.
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
    tools: [SCULPT_TOOL],
    tool_choice: { type: 'tool', name: SCULPT_TOOL.name },
    messages: [{ role: 'user', content: prompt }],
  });

  const call = response.content.find(
    (block) => block.type === 'tool_use' && block.name === SCULPT_TOOL.name,
  );
  if (!call) throw new Error('model returned no sculpt call');

  return {
    // Forced tool use means input is already an object; normalizeStructure
    // still clamps and re-centres every cube before this reaches the park.
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
