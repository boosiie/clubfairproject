/**
 * voxel.js - what a creation is made of.
 *
 * The booth used to describe a creation as up to eight primitive solids. Eight
 * blocks is a ceiling, not a style: no prompt makes "a dragon" out of eight
 * boxes look like a dragon. So a creation is now a VOXEL SCULPTURE - a few
 * hundred cubes on a fixed grid, the way MagicaVoxel or a Minecraft build
 * works. The same noun that bought you eight grey boxes now buys a silhouette
 * with a snout, a spine and wings.
 *
 * Two things feed the grid and they meet here:
 *
 *   - the model, which paints layers of characters against a small palette
 *   - the offline generator, blocklist and nonsense paths, whose primitive
 *     solids are RASTERISED into the same grid
 *
 * So there is exactly one thing to render, and an exhibit built with no network
 * at all is made of the same cubes as one the model sculpted. No second render
 * path to keep in step, and no visible second tier of quality at the booth.
 *
 * Pure geometry and shading. Colour policy lives in spec.js, which normalises a
 * palette before handing it here, so this file never has to import back.
 *
 * Units: a voxel is VOXEL metres on a side and a person is about 1.8 tall, so
 * a full-height sculpture stands a little over head height.
 */

/**
 * 16 x 18 x 16 at 0.375m is 6m x 6.75m x 6m - one plot, and just under the
 * 7m headroom the park allows. Sixteen is also enough resolution to read a
 * snout or a wing and few enough characters that the model can hold a whole
 * layer in its head.
 */
export const GRID = { width: 16, height: 18, depth: 16 };
export const VOXEL = 0.375;

/** Small enough that the model commits to a colour scheme instead of dithering. */
export const MAX_PALETTE = 10;

/** '.' is the drawing convention; a space is what you get when it trails off. */
const EMPTY_CHARS = new Set(['.', ' ', '\t']);

/** Guards on model input, so a runaway layer cannot allocate the world. */
const MAX_LAYERS = GRID.height * 2;
const MAX_ROWS = GRID.depth * 2;
const MAX_ROW_LENGTH = GRID.width * 2;

export function gridToWorld(x, y, z) {
  return {
    x: (x - (GRID.width - 1) / 2) * VOXEL,
    // +0.5 puts the bottom face of the y=0 layer exactly on the ground.
    y: (y + 0.5) * VOXEL,
    z: (z - (GRID.depth - 1) / 2) * VOXEL,
  };
}

function keyOf(x, y, z) {
  return (y * GRID.depth + z) * GRID.width + x;
}

function inGrid(x, y, z) {
  return x >= 0 && x < GRID.width && y >= 0 && y < GRID.height && z >= 0 && z < GRID.depth;
}

/**
 * Settle loose cells onto the grid: centre them in X and Z, drop them onto the
 * ground, and discard anything still outside.
 *
 * Centring happens once for the whole sculpture rather than per layer, which is
 * the only way layers stay registered with each other - centring each layer on
 * its own would slide a four-row layer of legs out from under an eight-row
 * layer of body.
 *
 * @param {Array<{x:number,y:number,z:number,i:number}>} cells
 * @param {{centerX?:boolean}} [options] - mirrored sculptures are already
 *   centred on X by construction; re-centring them would break the symmetry.
 * @returns {number[]} flat [x, y, z, paletteIndex, ...]
 */
export function placeCells(cells, options = {}) {
  if (!cells.length) return [];
  const centerX = options.centerX !== false;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const cell of cells) {
    if (cell.x < minX) minX = cell.x;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.z < minZ) minZ = cell.z;
    if (cell.z > maxZ) maxZ = cell.z;
  }

  const shiftX = centerX ? Math.round((GRID.width - 1 - maxX - minX) / 2) : 0;
  const shiftY = -minY;
  const shiftZ = Math.round((GRID.depth - 1 - maxZ - minZ) / 2);

  // A Map rather than an array of cells: two layers can name the same cell, and
  // the last one painted should win rather than stacking a duplicate cube.
  const filled = new Map();
  for (const cell of cells) {
    const x = cell.x + shiftX;
    const y = cell.y + shiftY;
    const z = cell.z + shiftZ;
    if (!inGrid(x, y, z)) continue;
    filled.set(keyOf(x, y, z), [x, y, z, cell.i]);
  }

  const out = [];
  for (const cell of filled.values()) out.push(cell[0], cell[1], cell[2], cell[3]);
  return out;
}

/**
 * Read the model's layers into cells.
 *
 * A layer is a horizontal slice at height `y`. Each row in it is one step
 * further back, and each character across a row is one step to the right, so a
 * layer reads exactly like a top-down map of the sculpture at that height.
 *
 * Mirrored sculptures carry only the right half, and each character is painted
 * on both sides of the centre line: character 0 fills the two middle columns,
 * character 1 the two either side of those, and so on. That is half the tokens
 * for twice the build, and - more to the point - symmetry is most of what makes
 * a pile of cubes read as a creature rather than as a pile of cubes.
 *
 * @param {Array<{y:number, rows:string[]}>} layers
 * @param {Map<string, number>} keyToIndex - palette character to palette index
 * @param {boolean} mirrored
 */
export function cellsFromLayers(layers, keyToIndex, mirrored) {
  const cells = [];
  if (!Array.isArray(layers)) return cells;

  const half = GRID.width / 2;

  for (const layer of layers.slice(0, MAX_LAYERS)) {
    if (!layer || typeof layer !== 'object') continue;
    const y = Math.round(Number(layer.y));
    if (!Number.isFinite(y)) continue;
    const rows = Array.isArray(layer.rows) ? layer.rows : [];

    rows.slice(0, MAX_ROWS).forEach((row, z) => {
      if (typeof row !== 'string') return;
      const chars = [...row.slice(0, MAX_ROW_LENGTH)];
      chars.forEach((char, column) => {
        if (EMPTY_CHARS.has(char)) return;
        // An unknown character is a slip of the pen, not a hole. Painting it in
        // the first palette colour keeps the silhouette solid; dropping it
        // would punch a window through the middle of the build.
        const index = keyToIndex.get(char) ?? keyToIndex.get(char.toUpperCase()) ?? 0;

        if (mirrored) {
          cells.push({ x: half + column, y, z, i: index });
          cells.push({ x: half - 1 - column, y, z, i: index });
        } else {
          cells.push({ x: column, y, z, i: index });
        }
      });
    });
  }

  return cells;
}

/* ---------- rasterising primitive solids ---------- */

/**
 * Undo a part's rotation, so a point can be tested against the shape in its own
 * frame. Three.js composes its default XYZ Euler as Rx*Ry*Rz, so the inverse
 * unwinds in the opposite order.
 */
function toLocal(px, py, pz, part) {
  let x = px, y = py, z = pz;

  if (part.rotationZ) {
    const c = Math.cos(-part.rotationZ), s = Math.sin(-part.rotationZ);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  if (part.rotationY) {
    const c = Math.cos(-part.rotationY), s = Math.sin(-part.rotationY);
    [x, z] = [x * c + z * s, -x * s + z * c];
  }
  if (part.rotationX) {
    const c = Math.cos(-part.rotationX), s = Math.sin(-part.rotationX);
    [y, z] = [y * c - z * s, y * s + z * c];
  }

  return [x, y, z];
}

function containsPoint(part, wx, wy, wz) {
  const [x, y, z] = toLocal(wx - part.offsetX, wy - part.offsetY, wz - part.offsetZ, part);
  const hw = part.width / 2, hh = part.height / 2, hd = part.depth / 2;

  switch (part.shape) {
    case 'sphere':
      return (x / hw) ** 2 + (y / hh) ** 2 + (z / hd) ** 2 <= 1;
    case 'cylinder':
      return Math.abs(y) <= hh && (x / hw) ** 2 + (z / hd) ** 2 <= 1;
    case 'cone': {
      if (Math.abs(y) > hh) return false;
      // Apex at the top, full width at the base.
      const taper = (hh - y) / part.height;
      return (x / (hw * taper || 1e-6)) ** 2 + (z / (hd * taper || 1e-6)) ** 2 <= 1;
    }
    default:
      return Math.abs(x) <= hw && Math.abs(y) <= hh && Math.abs(z) <= hd;
  }
}

/**
 * Turn primitive solids into the same cubes the model sculpts.
 *
 * This is what lets the offline generator, the nonsense block and the redacted
 * block share a single render path with the model. Later parts paint over
 * earlier ones, which matches how the shape libraries are written - the body
 * first, then the details that sit on top of it.
 *
 * @param {Array} parts - already through fitStructure, so resting on the ground
 * @param {{centerX:number, centerZ:number}} center - middle of the parts in metres
 * @returns {Array<{x:number,y:number,z:number,i:number}>} cells, i = part index
 */
export function cellsFromParts(parts, center = { centerX: 0, centerZ: 0 }) {
  const cells = [];
  if (!Array.isArray(parts) || !parts.length) return cells;

  for (let y = 0; y < GRID.height; y++) {
    for (let z = 0; z < GRID.depth; z++) {
      for (let x = 0; x < GRID.width; x++) {
        const at = gridToWorld(x, y, z);
        const wx = at.x + center.centerX;
        const wz = at.z + center.centerZ;

        for (let p = parts.length - 1; p >= 0; p--) {
          if (containsPoint(parts[p], wx, at.y, wz)) {
            cells.push({ x, y, z, i: p });
            break;
          }
        }
      }
    }
  }

  return cells;
}

/* ---------- turning a grid into something worth looking at ---------- */

/** How dark a fully buried face gets, and how much a sky-facing top is lifted. */
const OCCLUSION = 0.42;
const SKYLIGHT = 0.12;

function shadeHex(hex, factor) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return '#' + channels
    .map((v) => Math.max(0, Math.min(255, Math.round(v * factor))))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Drop the cubes nobody can see, and shade the rest by how enclosed they are.
 *
 * Both halves matter. Culling is the difference between four thousand cubes and
 * six hundred, which is the difference between a park that runs at 60fps and
 * one that does not. The shading is what stops a voxel build looking like flat
 * confetti: real ambient occlusion is what tells an eye that a snout sticks out
 * and an armpit goes in, and counting filled neighbours approximates it for
 * nothing. A cube with open sky above it is lifted slightly on top of that,
 * which reads as sunlight and picks out the silhouette against the park.
 *
 * Each cube also carries `rise`, its height as a fraction of the sculpture's
 * own height. That is what lets the park assemble a build from the ground up
 * without the renderer having to measure anything.
 *
 * @param {number[]} voxels - flat [x, y, z, paletteIndex, ...]
 * @param {Array<{color:string, glow:boolean}>} palette
 * @returns {{solid: Array, glow: Array}} instances in metres, ready to draw
 */
export function shadeVoxels(voxels, palette) {
  const filled = new Set();
  for (let i = 0; i < voxels.length; i += 4) {
    filled.add(keyOf(voxels[i], voxels[i + 1], voxels[i + 2]));
  }

  const occupied = (x, y, z) => inGrid(x, y, z) && filled.has(keyOf(x, y, z));

  const solid = [];
  const glow = [];

  // Measured over every cube, including the buried ones that are never drawn,
  // so `rise` means height in the sculpture rather than height among survivors.
  let topY = 0;
  for (let i = 1; i < voxels.length; i += 4) topY = Math.max(topY, voxels[i]);

  for (let v = 0; v < voxels.length; v += 4) {
    const x = voxels[v], y = voxels[v + 1], z = voxels[v + 2];
    const entry = palette[voxels[v + 3]] || palette[0] || { color: '#888888', glow: false };

    const faces = [
      occupied(x + 1, y, z), occupied(x - 1, y, z),
      occupied(x, y + 1, z), occupied(x, y - 1, z),
      occupied(x, y, z + 1), occupied(x, y, z - 1),
    ];
    // Buried on all six sides: it can never be seen, so it is never drawn.
    if (faces.every(Boolean)) continue;

    let neighbours = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx || dy || dz) if (occupied(x + dx, y + dy, z + dz)) neighbours++;
        }
      }
    }

    const shade = 1 - OCCLUSION * (neighbours / 26) + (faces[2] ? 0 : SKYLIGHT);
    const at = gridToWorld(x, y, z);

    // A glowing voxel is a lantern, an eye or a fire: it is its own light
    // source, so occlusion would be a lie. It keeps its colour flat.
    (entry.glow ? glow : solid).push({
      x: at.x,
      y: at.y,
      z: at.z,
      rise: topY ? y / topY : 0,
      color: entry.glow ? entry.color : shadeHex(entry.color, shade),
    });
  }

  return { solid, glow };
}

/** Size of a sculpture in metres, for signs, collision and the drop. */
export function voxelBounds(voxels) {
  if (!voxels || !voxels.length) return { width: VOXEL, height: VOXEL, depth: VOXEL };

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < voxels.length; i += 4) {
    minX = Math.min(minX, voxels[i]); maxX = Math.max(maxX, voxels[i]);
    minY = Math.min(minY, voxels[i + 1]); maxY = Math.max(maxY, voxels[i + 1]);
    minZ = Math.min(minZ, voxels[i + 2]); maxZ = Math.max(maxZ, voxels[i + 2]);
  }

  return {
    width: (maxX - minX + 1) * VOXEL,
    height: (maxY - minY + 1) * VOXEL,
    depth: (maxZ - minZ + 1) * VOXEL,
  };
}
