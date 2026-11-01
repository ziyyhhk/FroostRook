# PGN analysis CLI

`analyze.js` analyzes PGN games with the native FroostRook UCI engine and reports
per-move centipawn loss, a fixed classification, and per-player summaries. It
uses only Node built-ins; `engine.js` is reused for legal move generation and
for replaying moves with correct castling rights, en passant, halfmove clock,
fullmove number, and repetition history.

## Usage

```
node analyze.js --pgn path.pgn [--game N] [--depth 12] [--nodes 100000] [--engine path] [--json out.json] [--quiet]
```

Extra bounding options:

```
node analyze.js --pgn path.pgn --start-ply N --max-plies N
```

| Option | Meaning | Default |
| --- | --- | --- |
| `--pgn PATH` | PGN file to analyze. Required. | none |
| `--game N` | Analyze one game, 1-based, in file order. | all games |
| `--depth N` | `go depth N` search budget. | `12` |
| `--nodes N` | `go nodes N` search budget. Mutually exclusive with `--depth`. | none |
| `--engine PATH` | UCI engine executable. Overrides `FROOSTROOK_ENGINE`. | `native/FroostRook.exe` |
| `--json PATH` | Write the structured JSON document to `PATH`. The JSON is not printed. | none |
| `--quiet` | Suppress the human-readable stdout report. | off |
| `--start-ply N` | First ply to analyze, 1-based. Earlier plies are still parsed and replayed. | `1` |
| `--max-plies N` | Maximum number of plies to analyze, starting at `--start-ply`. | all |
| `--help`, `-h` | Print usage. | none |

`--depth` and `--nodes` are mutually exclusive. If both are passed the CLI
exits with code 2 and an explicit error; it never silently prefers one. If
neither is passed, depth 12 is used. A depth/node budget is applied to every
search, including both searches for a move.

`FROOSTROOK_ENGINE` is honored only when `--engine` is absent. Relative engine
paths are resolved against the current working directory. The default is the
repository's `native/FroostRook.exe` (with `native/kiwa-native.exe` accepted as
a legacy fallback).

Exit codes: `0` success; `1` PGN/replay/engine/analysis failure; `2` command
line usage error (including an out-of-range `--game`). Parse errors are printed
to stderr with the game number, move number, ply, SAN token, and the FEN of the
position in which matching failed.

## PGN support

The parser is self-contained. It supports:

- multiple games per file and tag pairs (including escaped quotes/backslashes);
- move text, move numbers attached or separate (`1.`, `1...`, `1.e4`, `34...Nf6`);
- comments `{...}`, including nested braces, and `;` rest-of-line comments;
- variations `(...)`, nested, with comments inside them; all variation content
  is ignored;
- NAGs `$n`, annotation glyphs `!?`/`?!`/`!!`/`??`, check/mate suffixes `+`/`#`;
- results `1-0`, `0-1`, `1/2-1/2`, `*`, including a result glued to the last move;
- `O-O`, `O-O-O`, `0-0`, `0-0-0` (also lower-case `o-o`);
- pawn pushes and captures, including `exd6` en passant (a following `e.p.`
  token is ignored);
- promotion forms `e8=Q`, `e8Q`, `exd8=Q+` (and lower-case promotion letters);
- `[FEN "..."]` setup games, with or without `[SetUp "1"]`. A `SetUp "1"`
  without a FEN is an error. FENs may have four, five, or six fields; the
  missing halfmove/fullmove fields default to `0 1`.

SAN is converted to UCI by generating the legal moves for the position and
matching SAN semantics: piece letter, destination, capture marker, origin
file/rank/full-square disambiguation, castling side, and promotion letter.
Every move is validated. An unmatched or ambiguous move aborts the run with the
ply, move number, SAN, and FEN. Long-algebraic/UCI move text (for example
`e2e4`) is also accepted as a fallback.

Replay uses `engine.js`, so castling rights, en passant availability, the
halfmove clock, fullmove number, and position history are maintained. Analysis
stops if a position before a move is checkmate or stalemate; any remaining
moves in the file are not processed.

## Engine protocol

One engine process is spawned per run and reused for every position. At startup
the CLI sends `uci`, waits for `uciok`, sets `OwnBook=false` and `Hash=32`,
then sends `isready` and waits for `readyok`. Before every `go` it sends
`position` and then `isready`/`readyok`. Between games it sends `ucinewgame`.

For a game starting from the standard position the command is
`position startpos moves ...`; otherwise it is
`position fen <six fields> moves ...`. All prior moves of the game are included,
so the engine sees the full repetition history.

For each analyzed move the CLI performs two searches with exactly the same
budget:

1. the position before the move, giving `S_before` from the mover's point of
   view and the engine PV's first move;
2. the position after the played move, giving `S_after` from the opponent's
   point of view. The mover's value is `-S_after`.

`info` lines are parsed tolerantly. When MultiPV is present, lines with
`multipv 1` (or no `multipv`) are preferred; the deepest such line wins, and the
later line wins on a depth tie. The engine's PV first move is the "best" move;
if a PV is absent, `bestmove` is used as a fallback. A `bestmove 0000` in a
non-terminal position is treated as an engine failure.

## Scores, mate handling, and point of view

The engine reports scores from the side-to-move's point of view.

- Centipawn scores become `cp`.
- `score mate n` becomes `cp = sign * (MATE_CP - n)` with `MATE_CP = 10000`, and a
  parallel signed `mateIn` (`+n` means the reporting side mates in `n`; `-n`
  means it is mated in `n`). `n` is clamped below `MATE_CP` so a mate score
  never overflows the loss arithmetic.
- Terminal positions are not searched. A checkmate position is evaluated as
  `-MATE_CP` for the side to move (`mateIn` 0), and stalemate as `0` cp.
- `loss = max(0, S_before_mover - S_after_mover)`. The clamp to zero is
  important: the played move can score better than the engine's PV move at the
  same budget. Mate scores are bounded by `MATE_CP`, so this subtraction cannot
  overflow.

The human table's `eval before` and `eval after` columns are both from the
player-to-move's point of view. The `eval after` value is the negated opponent
report. In JSON, `evalBefore` and `evalAfter` retain the engine's side-to-move
orientation and each carries `"pov": "side-to-move"`; `moverCpBefore` and
`moverCpAfter` give the mover-oriented values used for `loss`.

## Classification

Exactly these labels are used; no others are invented.

| Label | Rule |
| --- | --- |
| `best` | Played move equals the engine PV's first move. |
| `excellent` | `loss <= 10` cp. |
| `good` | `10 < loss <= 50` cp. |
| `inaccuracy` | `50 < loss <= 100` cp. |
| `mistake` | `100 < loss <= 250` cp. |
| `blunder` | `loss > 250` cp. |
| `missed mate` | Before the move the mover has a mate score (`mateIn > 0`), and the played move does not lead to a mate score for the mover. A terminal checkmate after the move counts as leading to mate; a slower mate also still counts. |
| `missed win` | Before the move the mover has at least `+200` cp or a mate score, and after the played move the mover has less than `+50` cp, with `loss >= 150`. |

Precedence: `missed mate` first, then `missed win`, then `best`, then the loss
bands. `missed mate` is also counted in the aggregate `blunderCategory`
(`blunder + missed mate`); the exact-label count remains separate in
`counts["missed mate"]`.

`brilliant` is intentionally not implemented. A defensible "brilliant" label
needs reliable sacrifice detection and only-move detection (including whether
the move is the only way to keep the advantage, and whether the material is
genuinely given up rather than tactically recovered). This tool does not
implement either, so claiming `brilliant` would be dishonest.

## Per-player summary

For each player the CLI reports:

- average centipawn loss (ACL), the mean `loss` over analyzed moves where both
  search results are centipawn scores (not mate) and neither position is
  terminal; `acl` is `null` when there are no samples;
- the number of ACL samples (`aclMoves`);
- counts for every label above (`counts`), plus `blunderCategory`;
- the three worst moves by loss, with ply, move number, SAN, played move,
  engine best move, loss, and label.

There is deliberately no "accuracy %" figure. ACL and counts are the only
aggregate metrics, so there is no opaque or invented conversion.

## Output

Without `--quiet`, stdout contains a human-readable report: game tags, start
position, analysis range, final status, a per-move table (ply, move number,
SAN, played UCI, engine best UCI, eval before, eval after, loss, label), and the
per-player summary. With `--json PATH`, the same data is written as a structured
document with:

- top-level engine, budget, and option metadata;
- `games[]` with `tags`, `startFen`, `result`, `finalStatus`, `stoppedEarly`,
  `analysisRange`, all `moves`, and `summary`;
- each move object contains `san`, `uci`, `analyzed`, and (when analyzed)
  `bestUci`, `evalBefore`, `evalAfter`, `moverCpBefore`, `moverCpAfter`, `loss`,
  `label`, `aclSample`, `terminalBefore`, and `terminalAfter`.

Unanalyzed moves (outside `--start-ply`/`--max-plies`) are still present in
JSON with their parsed SAN/UCI and `"analyzed": false`, but without evals or a
label. The human table prints only analyzed moves.

## Tests

```
node test/analyze-test.js
```

The suite covers the synthetic `1. f3 e5 2. g4 Qh4#` mate, castling in both
directions, en passant, promotion, comments/variations, `0-0-0`, the alternative
SAN promotion forms, a real PGN from `test/human-games/`, a malformed PGN, and
the mutually exclusive budget flags. It prints PASS/FAIL lines, prints a
summary, and exits non-zero on any failure.

## Performance and limitations

Measured with the FroostRook 1 Beta native core on this Windows 10 machine:

- depth-12 start-position search: 0.668–0.694 s, 590,750 nodes (seven-run
  bench, idle machine; see [TESTING.md](TESTING.md));
- the regression suite's real-game case (10 plies, 20 searches at
  `nodes 20000`) completes in about 2.5 s including process startup.

The older 2.3.0 figures (about 2 s per depth-12 search, 170 s for a 40-move
game) are history and are not current measurements. No full 40-move game at
depth 12 was timed for this release; analysis cost scales with the number of
positions searched (two per ply).

Because two searches are performed per analyzed move, a full game at depth 12
takes time proportional to twice the number of plies. Use `--max-plies`,
`--start-ply`, or `--nodes` to bound work.

Limitations:

- only checkmate/stalemate stop analysis; draws by fifty-move, threefold
  repetition, or insufficient material are reported in `finalStatus` but are
  still searched (they can still receive a `cp` label);
- variations and comments are ignored, not analyzed;
- only the engine's best line is evaluated; the tool does not search every
  alternative move, so a non-PV move's loss is relative to the *engine's* best
  choice at the same budget, not a full multi-move refutation;
- `brilliant` is not implemented, and there is no accuracy percentage;
- null moves (`--`/`Z0`) are rejected;
- Chess960 is not supported;
- engine analysis is deterministic only insofar as the engine is; the
  persistent hash table can make repeated searches of the same position differ
  slightly, while both sides of each comparison still use the same budget.
