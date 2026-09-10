/**
 * index.js - the booth server.
 *
 * Serves the park and answers one endpoint, POST /api/build.
 *
 * Design rule, and it is the important one: this endpoint NEVER fails. Not on a
 * blocked word, not on a dead API key, not on a rate limit, not on a timeout.
 * Every request returns a buildable structure and a `source` saying where it
 * came from. An error screen at a club fair is an empty booth.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeStructure } from '../public/js/spec.js';
import { pickFromPack, jitter } from '../public/js/pack.js';
import { screen, REDACTED_STRUCTURE, ANONYMOUS_LABEL, blocklistSize } from './moderation.js';
import { generateStructure, describeError, isConfigured, MODEL } from './claude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const PORT = Number(process.env.PORT || 3000);
/** Longest prompt we will pay for. Also shrinks the prompt-injection surface. */
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH || 140);
/** Floor between builds from one client. Stops someone holding Enter down. */
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 1200);
/** Whole-booth ceiling, in case the QR code sends a crowd to their phones. */
const MAX_CALLS_PER_MINUTE = Number(process.env.MAX_CALLS_PER_MINUTE || 40);
/** Hard spend guard for the day. Past this the pack takes over, silently. */
const MAX_CALLS_PER_DAY = Number(process.env.MAX_CALLS_PER_DAY || 1500);
/** Set MOCK=1 to run the whole booth with no API key at all. */
const MOCK = process.env.MOCK === '1' || !isConfigured();

/**
 * What to do when the model says an exhibit depicts a real, identifiable person
 * - a public figure, or a named teacher or classmate.
 *
 *   allow   build it as asked (default)
 *   generic build the same structure under a name that identifies nobody
 *   block   a grey box, same as a blocked word
 *
 * Students will absolutely try teachers and classmates as well as politicians,
 * so this is the dial to reach for if your advisor would rather not have named
 * statues of real people on a screen in a school gym.
 */
const REAL_PEOPLE = ['allow', 'generic', 'block'].includes(process.env.REAL_PEOPLE)
  ? process.env.REAL_PEOPLE
  : 'allow';

const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/data/fallback.json'), 'utf8'));

const stats = {
  startedAt: Date.now(),
  builds: 0,
  modelCalls: 0,
  fallbacks: 0,
  blocked: 0,
  anonymised: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
};

const lastSeenByClient = new Map();
let minuteWindow = { startedAt: Date.now(), count: 0 };
let dayWindow = { startedAt: Date.now(), count: 0 };

function budgetAvailable(clientId) {
  const now = Date.now();

  if (now - minuteWindow.startedAt > 60_000) minuteWindow = { startedAt: now, count: 0 };
  if (now - dayWindow.startedAt > 86_400_000) dayWindow = { startedAt: now, count: 0 };

  const last = lastSeenByClient.get(clientId) ?? 0;
  if (now - last < MIN_INTERVAL_MS) return { ok: false, why: 'too fast' };
  if (minuteWindow.count >= MAX_CALLS_PER_MINUTE) return { ok: false, why: 'busy' };
  if (dayWindow.count >= MAX_CALLS_PER_DAY) return { ok: false, why: 'daily budget spent' };

  lastSeenByClient.set(clientId, now);
  if (lastSeenByClient.size > 500) {
    for (const [key, seen] of lastSeenByClient) {
      if (now - seen > 300_000) lastSeenByClient.delete(key);
    }
  }
  return { ok: true };
}

function fromPack(prompt) {
  return jitter(pickFromPack(pack, prompt));
}

const app = express();
app.use(express.json({ limit: '8kb' }));

app.use(express.static(path.join(root, 'public'), { maxAge: '1h' }));
// Matter.js is served from node_modules rather than a CDN on purpose: the venue
// wifi will die, and a park that cannot load its physics engine is a blank
// screen. Everything this page needs is on the laptop.
app.use('/vendor', express.static(path.join(root, 'node_modules/matter-js/build'), { maxAge: '1d' }));

app.get('/api/status', (_req, res) => {
  res.json({
    mock: MOCK,
    model: MOCK ? null : MODEL,
    realPeople: REAL_PEOPLE,
    blocklistSize,
    packSize: pack.structures.length,
    uptimeSeconds: Math.round((Date.now() - stats.startedAt) / 1000),
    callsToday: dayWindow.count,
    dailyBudget: MAX_CALLS_PER_DAY,
    ...stats,
  });
});

app.post('/api/build', async (req, res) => {
  const raw = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
  const prompt = raw.trim().slice(0, MAX_PROMPT_LENGTH);
  const clientId = req.ip || 'local';

  stats.builds += 1;

  if (!prompt) {
    return res.json({ structure: normalizeStructure(fromPack('')), source: 'fallback', note: 'empty prompt' });
  }

  // 1. Screen the input before spending anything on it. A troll gets a grey box
  //    and no reaction, which is both cheaper and less fun for them.
  if (screen(prompt).blocked) {
    stats.blocked += 1;
    return res.json({ structure: normalizeStructure(REDACTED_STRUCTURE), source: 'blocked' });
  }

  // 2. No key, mock mode, rate limited, or out of budget: use the pack. The
  //    response shape is identical, so the park cannot tell the difference.
  const budget = budgetAvailable(clientId);
  if (MOCK || !budget.ok) {
    stats.fallbacks += 1;
    return res.json({
      structure: normalizeStructure(fromPack(prompt)),
      source: 'fallback',
      note: MOCK ? 'mock mode' : budget.why,
    });
  }

  minuteWindow.count += 1;
  dayWindow.count += 1;

  try {
    const { structure, usage } = await generateStructure(prompt);
    stats.modelCalls += 1;
    stats.inputTokens += usage.input_tokens;
    stats.outputTokens += usage.output_tokens;

    const normalized = normalizeStructure(structure);

    // 3. Screen the label the model chose. The schema means this is the only
    //    free text that reaches the screen, so this is the whole output surface.
    if (screen(normalized.label).blocked) {
      stats.blocked += 1;
      return res.json({ structure: normalizeStructure(REDACTED_STRUCTURE), source: 'blocked' });
    }

    // 4. Real-person policy. The model classified the subject in the same tool
    //    call, which is more robust than trying to keep a list of names.
    if (normalized.subject === 'real_person' && REAL_PEOPLE !== 'allow') {
      stats.anonymised += 1;
      if (REAL_PEOPLE === 'block') {
        return res.json({ structure: normalizeStructure(REDACTED_STRUCTURE), source: 'blocked' });
      }
      return res.json({
        structure: { ...normalized, label: ANONYMOUS_LABEL },
        source: 'model',
        note: 'anonymised',
      });
    }

    return res.json({ structure: normalized, source: 'model' });
  } catch (err) {
    stats.errors += 1;
    console.warn(`[build] ${describeError(err)} - falling back to pack`);
    return res.json({ structure: normalizeStructure(fromPack(prompt)), source: 'fallback', note: 'api unavailable' });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Amusement park running:   http://localhost:${PORT}`);
  console.log(`  Mode:                     ${MOCK ? 'MOCK (offline pack only, no API calls)' : MODEL}`);
  console.log(`  Offline pack:             ${pack.structures.length} structures`);
  console.log(`  Blocklist:                ${blocklistSize} terms`);
  console.log(`  Real people:              ${REAL_PEOPLE}`);

  if (!MOCK) {
    console.log(`  Daily call budget:        ${MAX_CALLS_PER_DAY}\n`);
  } else if (process.env.MOCK === '1') {
    console.log('\n  MOCK=1 - no API calls will be made.\n');
  } else {
    console.log('\n  No ANTHROPIC_API_KEY found - running on the offline pack.');
    console.log('  Copy .env.example to .env and add a key for live generation.\n');
  }
});
