# PGN analysis CLI

`analyze.js` analyzes PGN games with the native FroostRook UCI engine and reports
per-move centipawn loss, a fixed classification, candidate lines, draw-rule
status, and per-player summaries. It uses only Node built-ins; `engine.js` is
reused for legal move generation and for replaying moves with correct castling
rights, en passant, halfmove clock, fullmove number, and repetition history.

## Usage

```
node analyze.js --pgn path.pgn [--game N] [--depth 12] [--nodes 100000] [--multipv 3] [--engine path] [--json out.json] [--quiet]
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
| `--multipv N` | Request `N` candidate lines per position, 1-8. Values outside that range are usage errors. | `3` |
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

## Draw rules and final status

Repetition is tracked with FIDE position identity: same pieces on the same
squares, same side to move, same castling rights, and the same en passant
target only when an en passant capture is actually legal. The halfmove clock is
taken from the replayed position, so `[FEN ...]` games with a non-zero clock
are handled correctly.

Two kinds of draw rules are distinguished:

- **Automatic**: stalemate, dead position (insufficient mating material under
  FIDE 5.2.2, including same-coloured bishops), fivefold repetition, and the
  seventy-five-move rule. These end the game without a claim.
- **Claimable**: threefold repetition and the fifty-move rule. A claimable draw
  is marked as `drawn` only when the PGN result is `1/2-1/2`; without that
  token play is treated as having continued.

`finalStatus` is one of `checkmate`, `stalemate`, `draw-insufficient-material`,
`draw-fivefold`, `draw-seventy-five-move`, `draw-threefold`, `draw-fifty-move`,
the decisive result (`1-0`/`0-1`), or `unfinished`. `finalDraw` carries the
machine-readable reasons, flags, and the engine-shortcut marker described
below. `resultConsistency` compares the score sheet with the replayed position:
`match`, `mismatch`, or `unknown` when the position does not force a result.

When the root position is already a dead position, fivefold repetition,
seventy-five-move count, claimable threefold, or claimable fifty-move count,
the native engine returns an immediate `score cp 0` instead of searching. Such
a root is flagged with `engineShortcut: true` (and on the move's `drawBefore` /
`drawAfter`), and its score is not treated as evidence about the position:
`aclSample` is false for those moves.

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

`info` lines are parsed tolerantly. For each MultiPV rank the deepest line wins
and the later line wins on a depth tie. Rank 1 is the reported best line; its PV
first move is the "best" move, and if the PV is absent, `bestmove` is used as a
fallback. A `bestmove 0000` in a non-terminal position is treated as an engine
failure.

The CLI sets `MultiPV` to `--multipv` (default 3) and collects one line per
rank for the position before each move. These are real engine lines at the same
budget, not post-hoc guesses. Ranks beyond those the engine could resolve in the
budget are simply absent, so `candidates.length` can be smaller than the
requested count. `--multipv 1` restores single-line analysis and is the fastest
mode.

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
position, analysis range, final status, any draw rule that applies, the
score-sheet consistency check, a per-move table (ply, move number, SAN, played
UCI, engine best UCI, eval before, eval after, loss, label), and the per-player
summary. When more than one candidate line was returned, each analyzed move is
followed by a compact `lines:` line with the rank, score, and first six PV
moves.

With `--json PATH`, the same data is written as a structured document with:

- top-level engine, budget, and option metadata (including `multipv`);
- `games[]` with `tags`, `startFen`, `result`, `finalStatus`, `finalDraw`,
  `resultConsistency`, `stoppedEarly`, `analysisRange`, all `moves`, and
  `summary`;
- each move object contains `san`, `uci`, `analyzed`, `drawBefore`, `drawAfter`,
  and (when analyzed) `bestUci`, `candidates`, `evalBefore`, `evalAfter`,
  `moverCpBefore`, `moverCpAfter`, `loss`, `label`, `aclSample`,
  `terminalBefore`, and `terminalAfter`.

A `drawBefore`/`drawAfter` object contains `status`, `reasons`, `known`,
`automatic`, `claimable`, `claimed`, `drawn`, `engineShortcut`, and `source`. A
candidate object contains `rank`, `cp`, `mateIn`, `terminal`, `pv`, `bestUci`,
`depth`, and `nodes`, and is oriented from the side to move just like
`evalBefore`.

Unanalyzed moves (outside `--start-ply`/`--max-plies`) are still present in
JSON with their parsed SAN/UCI and `"analyzed": false`, but without evals or a
label. The human table prints only analyzed moves.

## Tests

```
node test/analyze-test.js
```

The suite covers the synthetic `1. f3 e5 2. g4 Qh4#` mate, castling in both
directions, en passant, promotion, comments/variations, `0-0-0`, the alternative
SAN promotion forms, a real PGN from `test/human-games/`, threefold repetition
(claimed), the fifty-move rule from a setup FEN, an automatic dead-position
draw with no moves, label whitelisting, MultiPV candidate ordering, malformed
PGNs, the mutually exclusive budget flags, and the `--multipv` range check. It
prints PASS/FAIL lines, prints a summary, and exits non-zero on any failure.

## Performance and limitations

Measured with the FroostRook native core on this Windows 10 machine:

- depth-12 start-position search: 0.668–0.694 s, 590,750 nodes (seven-run
  bench, idle machine; see [TESTING.md](TESTING.md));
- the regression suite's real-game case (10 plies, 20 searches at
  `nodes 20000`, default MultiPV 3) completes in about 2.2 s including process
  startup.

The older 2.3.0 figures (about 2 s per depth-12 search, 170 s for a 40-move
game) are history and are not current measurements. No full 40-move game at
depth 12 was timed for this release; analysis cost scales with the number of
positions searched (two per ply) and with the MultiPV count.

Because two searches are performed per analyzed move, a full game at depth 12
takes time proportional to twice the number of plies. MultiPV adds further cost
because the engine must resolve several root moves. Use `--max-plies`,
`--start-ply`, `--nodes`, or `--multipv 1` to bound work.

Limitations:

- only checkmate and stalemate stop the replay loop; a claimable draw is
  reported and searched, and its engine score is flagged as a shortcut (the
  native engine returns 0 for such roots), so it cannot support an ACL sample;
- variations and comments are ignored, not analyzed;
- the played move's loss is measured against the engine's best line at the same
  budget. Other candidate lines are reported for context, but the tool does not
  search every legal alternative or claim a full multi-move refutation;
- `brilliant` is not implemented, and there is no accuracy percentage;
- null moves (`--`/`Z0`) are rejected;
- Chess960 is not supported;
- engine analysis is deterministic only insofar as the engine is; the
  persistent hash table can make repeated searches of the same position differ
  slightly, while both sides of each comparison still use the same budget.
