/**
 * fetch-models.js - download the CC0 models the park uses.
 *
 * The models are committed, so a fresh clone already works and the booth needs
 * no network. This exists to re-download them if one gets deleted, and as the
 * record of exactly where each file came from.
 *
 *   npm run fetch-models
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public/models');

/**
 * Every entry must be CC0 or otherwise clearly free to redistribute, and must
 * be recorded in public/models/LICENSES.md. Do not add a model here without
 * checking its licence - this repository gets projected onto a wall at a school.
 */
const MODELS = [
  {
    file: 'RobotExpressive.glb',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/RobotExpressive.glb',
    licence: 'CC0 1.0',
    author: 'Tomas Laulhe (Quaternius), modified by Don McCurdy',
  },
];

async function main() {
  fs.mkdirSync(target, { recursive: true });
  let failures = 0;

  for (const model of MODELS) {
    const destination = path.join(target, model.file);
    process.stdout.write(`  ${model.file.padEnd(28)} `);

    try {
      const response = await fetch(model.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const bytes = Buffer.from(await response.arrayBuffer());
      // A blocked network often answers with an HTML block page rather than
      // failing, and an HTML file saved as .glb fails much later and much more
      // confusingly than it needs to.
      if (bytes.subarray(0, 4).toString('ascii') !== 'glTF') {
        throw new Error('not a glTF file - the network may have returned a block page');
      }

      fs.writeFileSync(destination, bytes);
      console.log(`ok  ${Math.round(bytes.length / 1024)} KB  ${model.licence}`);
    } catch (error) {
      failures += 1;
      console.log(`FAILED  ${error.message}`);
    }
  }

  if (failures) {
    console.log(`\n${failures} download(s) failed. The committed copies are still in place,`);
    console.log('and the park falls back to a built-in blocky avatar if one is missing.');
    process.exit(1);
  }
  console.log('\nAll models present. Licences are recorded in public/models/LICENSES.md.');
}

main();
