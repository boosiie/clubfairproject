/**
 * moderation.js - the short blocklist that guards the one free-text field.
 *
 * The schema does most of the work: the model can only emit numbers, an enum,
 * a hex colour, and a 28-character label. This file guards the label.
 *
 * It runs twice per request:
 *   1. On the student's typed prompt, BEFORE the API call. Cheap, and it means
 *      an obvious troll costs nothing and gets a shrug instead of a reaction.
 *   2. On the label the model returned, AFTER the API call.
 *
 * Blocked input still spawns an object - a plain grey box labelled "redacted".
 * Nothing on screen ever says "you typed something bad", because the reaction
 * is the reward. A boring grey box is the correct punishment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Matched as whole words after normalization. Word matching is what keeps
 * "class", "assignment" and "Scunthorpe" working.
 *
 * This list is deliberately short and deliberately incomplete. Extend it for
 * your own school and crowd in server/blocklist.local.txt (gitignored, one
 * term per line, `#` for comments) - that file is merged in at startup.
 */
const WORDS = [
  'fuck', 'fucker', 'fucking', 'shit', 'shitty', 'bitch', 'bastard', 'cunt',
  'dick', 'cock', 'penis', 'vagina', 'boob', 'boobs', 'tit', 'tits', 'ass',
  'asshole', 'arse', 'anus', 'butthole', 'nude', 'nudes', 'naked', 'porn',
  'porno', 'sex', 'sexy', 'orgasm', 'masturbate', 'cum', 'jizz', 'horny',
  'slut', 'whore', 'pedo', 'pedophile', 'rape', 'rapist', 'molest',
  'nigger', 'nigga', 'faggot', 'fag', 'tranny', 'retard', 'retarded', 'spic',
  'chink', 'kike', 'wetback', 'nazi', 'hitler', 'kkk', 'klan', 'lynch',
  'suicide', 'kys', 'heroin', 'cocaine', 'meth', 'weed', 'bong', 'vape',
  'nutsack', 'scrotum', 'testicle', 'testicles', 'piss', 'turd', 'queef',
  'twat', 'wanker', 'bollocks',
];

/**
 * Matched anywhere in the normalized string, including inside other words.
 * Reserve this for spellings with no innocent reading - substring matching is
 * what causes false positives.
 */
const SUBSTRINGS = ['nigg', 'fagg', 'kkk', 'rapey'];

/** Leetspeak and homoglyph folding, applied before matching. */
const CHAR_MAP = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't',
  '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't',
};

const COMBINING_MARKS = /[\u0300-\u036f]/g;

function loadLocalTerms() {
  try {
    return fs
      .readFileSync(path.join(here, 'blocklist.local.txt'), 'utf8')
      .split('\n')
      .map((line) => line.split('#')[0].trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return []; // No local list is the normal case.
  }
}

/** Collapse runs of a repeated letter: "fuuuck" -> "fuck". */
function collapseRuns(str) {
  return str.replace(/([a-z])\1+/g, '$1');
}

const allWords = [...WORDS, ...loadLocalTerms()];

/**
 * Two sets, matched against two forms of the input.
 *
 * The collapsed set exists only to catch stretched spellings ("fuuuck"), and
 * carries a minimum length because collapsing is lossy: "kkk" collapses to "k",
 * and a set containing "k" would block "duck", "brick" and "basketball".
 */
const rawWords = new Set(allWords);
const collapsedWords = new Set(allWords.map(collapseRuns).filter((w) => w.length >= 4));

/**
 * Fold a string to bare lowercase letters so "F.U.C.K", "fuuuuck" and "fu(k"
 * all land on the same token stream.
 */
function normalize(input) {
  const folded = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .split('')
    .map((ch) => CHAR_MAP[ch] ?? ch)
    .join('')
    .replace(/[^a-z\s]/g, ' ');

  return {
    spaced: folded.replace(/\s+/g, ' ').trim(),
    squashed: folded.replace(/\s+/g, ''),
    collapsedSquashed: collapseRuns(folded.replace(/\s+/g, '')),
  };
}

/**
 * Does the raw text look like someone padding a word to dodge a filter?
 * "f u c k" and "f.u.c.k" do. "Scunthorpe" and "bowling balls" do not.
 *
 * Only when this is true do we match words against the separator-stripped
 * form, which is what keeps the Scunthorpe problem from biting.
 */
function looksPadded(text) {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const singles = tokens.filter((t) => t.length === 1).length;
  if (singles >= 3) return true;
  // Punctuation wedged between two letters: "f.u.c.k", "s-h-i-t".
  return /[a-z][^a-z0-9\s][a-z][^a-z0-9\s][a-z]/i.test(text);
}

/**
 * @param {string} text
 * @returns {{blocked: boolean, reason?: string}}
 */
export function screen(text) {
  if (typeof text !== 'string' || !text.trim()) return { blocked: false };

  const { spaced, squashed, collapsedSquashed } = normalize(text);

  for (const sub of SUBSTRINGS) {
    if (squashed.includes(sub)) return { blocked: true, reason: 'substring' };
  }

  for (const token of spaced.split(' ')) {
    if (rawWords.has(token)) return { blocked: true, reason: 'word' };
    if (collapsedWords.has(collapseRuns(token))) return { blocked: true, reason: 'stretched' };
  }

  // Only once the text looks deliberately padded do we match against the
  // separator-stripped form. Doing it unconditionally is what turns a blocklist
  // into a machine for rejecting "Scunthorpe" and "class project".
  if (looksPadded(text)) {
    for (const word of rawWords) {
      if (word.length >= 3 && (squashed.includes(word) || collapsedSquashed.includes(word))) {
        return { blocked: true, reason: 'padded' };
      }
    }
  }

  return { blocked: false };
}

/** The exhibit a blocked prompt gets. Boring on purpose. */
export const REDACTED_STRUCTURE = {
  label: 'redacted',
  subject: 'object',
  anchored: false,
  density: 0.006,
  restitution: 0.05,
  parts: [
    { shape: 'rectangle', width: 130, height: 90, offsetX: 0, offsetY: 45, rotation: 0, sides: 4, color: '#8f8f8f' },
  ],
};

/**
 * What a real-person exhibit becomes under REAL_PEOPLE=generic: the structure
 * the model built, under a name that identifies nobody.
 */
export const ANONYMOUS_LABEL = 'a statue of someone';

export const blocklistSize = rawWords.size + SUBSTRINGS.length;
