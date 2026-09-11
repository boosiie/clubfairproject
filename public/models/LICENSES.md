# Models

Everything here is CC0 (public domain). Nothing in this folder requires
attribution to use, but it is recorded anyway because the people who made it
deserve the credit and because a school project should be able to show where
its assets came from.

Re-download or update with `npm run fetch-models`.

## RobotExpressive.glb

The walkable avatar. 464 KB, 14 animation clips (Idle, Walking, Running, Jump,
Dance, Wave and more); the park uses Idle, Walking, Running and Jump.

- **Author:** [Tomás Laulhé](https://www.patreon.com/quaternius) (Quaternius)
- **Modifications:** [Don McCurdy](https://donmccurdy.com/) — facial morph
  targets, FBX2GLTF conversion, material cleanup
- **Licence:** CC0 1.0
- **Source:** the three.js repository,
  `examples/models/gltf/RobotExpressive/RobotExpressive.glb`

Quaternius asks that you consider supporting the Patreon if you use the work.
That is a request, not a licence condition.

---

## Adding more models

Everything a visitor builds is made of boxes, spheres, cylinders and cones — on
purpose, so that every prompt makes something different. A fixed catalogue of
downloaded models would mean the fortieth person gets the same tree as the
twelfth. Models are for the things that are the *same* every time: the avatar,
and any scenery you want along the road.

If you want more of those, these are the good CC0 sources. They are the sort of
site a school network often blocks, so download at home:

- **kenney.nl/assets** — low-poly kits (Nature, City, Furniture, Holiday,
  Platformer). CC0. The closest match to this art style.
- **quaternius.com** — CC0 low-poly characters, animals and vehicles, by the
  same person who made the avatar above.
- **poly.pizza** — searchable, filterable by licence. Check each model: the
  library is a mix of CC0 and CC-BY.

Prefer `.glb` (one file, textures included). Drop it in this folder, load it in
`public/js/world.js` the way the avatar is loaded, and add a row here saying
where it came from and under what licence.

**Check the licence on anything you add.** CC0 needs nothing. CC-BY needs a
credit somewhere visible. Anything that says "personal use only" or has no
licence at all does not belong in a project you are going to project onto a wall
in a school.
