# Swift Sitegen

A fast static site generator that is a drop-in for **makefun-site 1.0.0**:
`run(input)` in [`solve.js`](solve.js) returns makefun-site's exact answer
for every case — the output tree as a JSON object `{path: text}`, byte for
byte — and [`main.ts`](main.ts) is the driver that reads the cases and
writes the answers.

Entered in the make.fun bounty
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122).

![Competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)
![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/valdodamanik12-blip/swift-sitegen/rank.svg)
![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/valdodamanik12-blip/swift-sitegen/reward.svg)

## How it works

The build is the same one makefun-site does — front matter, permalinks,
markdown, templates, collections, the build report — written to run
leaner:

- **One-pass HTML escaping** with a fast path that returns a string
  untouched when it holds no special character, and segment-flushed inline
  rendering: plain runs between markup constructs are escaped in a single
  call instead of character by character.
- **Memoised slugify** with an ASCII fast path (pure-ASCII text skips the
  Unicode normalisation, which is the identity there); titles, tag names
  and headings repeat across a site, so each slug is computed once.
- **Line-gated block classification**: a line's first character decides
  which grammar checks run at all, and the front matter is scanned line by
  line without splitting the whole body.
- **Array-joined template rendering** over pre-split lookup paths, and
  cards memoised per source, since layouts ask for the same cards again
  and again.

Nothing is cached from one case to the next: every memo lives for exactly
one `run()` call, so answers stay independent per case and byte-identical
across runs.

## Layout

- `main.ts` — the driver: sets the V8 flags before importing the entry,
  reads `cases.json`, answers each case alone, writes `answers.json`.
- `solve.js` — the generator itself, dependency-free ES module.
- `package.json` — marks the entry as an ES module.

## License

MIT — see [LICENSE](LICENSE).
