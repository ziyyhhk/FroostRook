# FroostRook 1 Beta

<img src="assets/froostrook.png" alt="FroostRook 1 Beta" width="200" align="right">

FroostRook 1 Beta is a from-scratch chess engine: a C++17 search core with a
handcrafted evaluator, a Node.js front-end, an embedded opening repertoire, a
human-move predictor and a PGN analysis tool. It plays the standard game,
speaks UCI, and ships as a single static Windows executable.

This is the repository formerly named `ziyyhhk/kiwa-engine`. GitHub redirects
the old URL and keeps the history, tags and releases.

> **Name and version:** the public engine name is exactly **FroostRook 1 Beta**
> (capital F, R and B). `1.0.0-beta` is the package version used in archives.
> The UCI handshake returns `id name FroostRook 1 Beta`.

## Contents

- [Quick start](#quick-start)
- [What changed in 1 Beta](#what-changed-in-1-beta)
- [Engine and UCI](#engine-and-uci)
- [Game analysis](#game-analysis)
- [Measured results](#measured-results)
- [NNUE prototype (experimental)](#nnue-prototype-experimental)
- [Building](#building)
- [Tests](#tests)
- [Limitations and honest gaps](#limitations-and-honest-gaps)
- [Data and licences](#data-and-licences)

## Quick start

Download `FroostRook.exe` from
[Releases](https://github.com/ziyyhhk/FroostRook/releases) and import it into
any UCI chess GUI (Arena, Cute Chess, BanksiaGUI, Nibbler, ...). The executable
is statically linked and needs no DLLs or Node.js.

From a terminal:

```
FroostRook.exe
uci
isready
position startpos moves e2e4 e7e5
go movetime 1000
quit
```

The `full` archive adds the Node front-end, opening book sources, predictor,
PGN analyzer, tests and documentation:

```
node uci.js                 # UCI session through the front-end
node play.js                # play in the terminal
node analyze.js --pgn game.pgn --depth 12
```

## What changed in 1 Beta

- **Search:** internal iterative reduction and futility pruning of quiet moves,
  a pawn-attack cache that survives across evaluations, and ep keys only when
  a legal ep capture exists. At depth 12 from the start position the engine
  visits 13.2% fewer nodes and finishes 7.8% sooner than 2.3.0. In a 40-game
  head-to-head it scored 51.3% (+9 Elo, 95% CI −99 to +116): **the playing
  strength is approximately unchanged**, not a measured gain.
- **MultiPV:** real multipv 1–8 output with ordered, distinct root lines, and
  `bestmove` always equal to line 1. MultiPV searches run single-threaded.
- **Analysis:** new `analyze.js` PGN analyzer with consistent before/after
  evaluation at the same budget, disclosed move labels, ACL, JSON output and a
  42-check regression suite.
- **Identity:** engine, front-end, package, docs and CI now identify as
  FroostRook 1 Beta; the GitHub repository was renamed in place.
- **NNUE:** a trained prototype (trainer, quantized net, metrics, self-test)
  lives in `tools/nnue` and `data/nnue`. It is **not integrated** and is not
  used for play; its measured quality is below the handcrafted evaluator. See
  [the prototype section](#nnue-prototype-experimental).
- **NPS:** on an idle machine the depth-12 bench measures 0.87 M nodes/s for
  1 Beta and 0.92 M for 2.3.0. The 0.47 M figure in the 2.3.0 notes could not
  be reproduced with this bench and is not used as a baseline; raw NPS is 6%
  lower while time-to-depth is 8% lower. No evaluation terms were removed.
  See [docs/TESTING.md](docs/TESTING.md) for the full method.

## Engine and UCI

FroostRook implements the standard UCI handshake and search commands, plus:

| Option | Default | Range |
| --- | --- | --- |
| `Threads` | 1 | 1–8 (independent searches over private TT slices) |
| `Hash` | 64 MB | 1–512 |
| `MultiPV` | 1 | 1–8 |
| `OwnBook` / `Book Depth` / `Book Variety` / `Book Style` | on / 24 / 100 / Balanced | see [docs/UCI.md](docs/UCI.md) |
| `Opening Diversity` / `Random Seed` | 50 / 0 | book spread and reproducibility |
| `Move Overhead` | 30 ms | 0–1000 |
| `Clear Book Memory`, `Clear Hash` | buttons | |

The native engine also accepts `d`, `eval`, `bookmemory`, `perft <d>` and
`bench` for diagnostics. `FroostRook.exe perft 5` and `FroostRook.exe bench`
run without a GUI.

Full option and command reference: [docs/UCI.md](docs/UCI.md).

## Game analysis

`analyze.js` replays a PGN game, searches every position before and after the
played move at the same depth or node budget, and reports centipawn loss plus
one of: `best`, `excellent`, `good`, `inaccuracy`, `mistake`, `blunder`,
`missed mate`, `missed win`.

```
node analyze.js --pgn game.pgn --depth 12
node analyze.js --pgn game.pgn --nodes 100000 --game 2 --json out.json
```

It reports average centipawn loss per player and the worst moves, but no
invented "accuracy percentage" or Brilliant-style labels: the classification
rule and thresholds are documented, and every label follows from the
before/after scores. See [docs/ANALYSIS.md](docs/ANALYSIS.md) for the exact
method, JSON schema and measured runtime. The analyzer is not a tablebase and
does not prove that a move is objectively best; it reports what this engine
sees at the chosen budget.

## Measured results

All measurements below are from this project's own binaries on the same laptop
(Windows 10, 2 physical cores, 4 logical). They are small-sample, short-time-
control results, not a rating. Sample-error intervals cover game noise only.

### Correctness

- Start-position perft: depth 5 = **4,865,609** nodes (exact).
- Kiwipete, castling-rights, underpromotion and en-passant perft suites match
  the published counts (`test/perft.js`, `test/perft-native.js`).
- FIDE rules checks pass: ep only keyed when a legal ep capture exists,
  twofold in search vs threefold at root, 50-move, insufficient material,
  checkmate/stalemate scores, castling-rights repetition.
- Full UCI smoke suite passes, including book options, mate in one, `stop`
  during `go infinite` at 1/2/4 threads, and MultiPV ordering.

### Search and speed

Depth-12 bench from the start position, portable builds (`FroostRook.exe`),
seven runs each on an otherwise idle machine. NPS is process wall time here;
the engine also reports CPU-time NPS (1 Beta: 0.90–1.02 M, median 0.92 M):

| Build | nodes | wall time | CPU time | wall NPS |
| --- | --- | --- | --- | --- |
| KiwaChess 2.3.0 baseline | 680,757 | 0.724–0.780 s | not instrumented | 0.87–0.94 M |
| FroostRook 1 Beta | 590,750 | 0.668–0.694 s | 0.579–0.657 s | 0.85–0.88 M |

Medians: 681 ms vs 739 ms, 590,750 vs 680,757 nodes. The shipped build visits
13.2% fewer nodes and reaches the same depth 7.8% sooner, while raw NPS is 5.8%
lower because the average surviving node costs more. **This is a
time-to-depth improvement, not an NPS recovery.**

The previous release documented 0.75 → 0.47 M (portable) and 0.72 → 0.54 M
(native). Those figures cannot be reproduced with this bench: the 2.3.0
baseline itself measures 0.87–0.94 M here. The old numbers were taken with a
different bench and machine state, so they are reported only as history. On
same-bench, idle measurements there is no 0.47 M regression; there is a small
(5.8%) NPS cost for a 7.8% time-to-depth gain.

An aggressive move-count pruning variant (590 k → 308 k nodes at depth 12) was
built and rejected: it scored 43.3% against the Stockfish anchor, versus 51.3%
for the shipped build, and is not in the release. That result is recorded in
[docs/TESTING.md](docs/TESTING.md) rather than hidden.

### Strength

| Match | Games | Result | Score | Elo / performance (95% CI) |
| --- | --- | --- | --- | --- |
| FroostRook 1 Beta vs KiwaChess 2.3.0, 100 ms/move, no book, 20 colour-swapped openings | 40 | +16 =9 −15 | 51.3% | +9 (−99 to +116) |
| FroostRook 1 Beta vs Stockfish `UCI_Elo 2200`, 100 ms/move, book on, 20 paired openings | 40 | +19 =3 −18 | 51.3% | performance 2209 (2101–2317) |
| KiwaChess 2.3.0 control vs the same Stockfish setting | 40 | +23 =1 −16 | 58.8% | performance 2261 (2151–2371) |

**No strength gain is claimed.** The head-to-head result is +9 Elo with a 95%
interval that includes zero and a large positive and negative range. The
Stockfish control shows 2.3.0 at 2261 and 1 Beta at 2209 on this scale; the
intervals overlap heavily. A 40-game bullet sample cannot resolve differences
below roughly 100 Elo at 95% confidence. Earlier in development a 120-game
head-to-head with an aggressive pruning build scored 54.6% (+32, 95% CI −30 to
+94); that build was not shipped because it measured 43.3% against Stockfish
and its colour split was unstable. All variants and both match types are in
[docs/TESTING.md](docs/TESTING.md).

The 2.3.0 binary is the previous release asset, kept byte-identical as the
baseline. Both sides use the same movetime and the same opening pairs with
colours swapped. Treat the absolute anchored number as "roughly this strong on
Stockfish's UCI_Elo scale", not a CCRL rating: Stockfish's own limited-strength
calibration is an unknown, and 100 ms/move is bullet chess.

No 3000 Elo claim is made anywhere. The engine is a handcrafted, single-author
engine; reaching 3000 requires an integrated NNUE and far more testing.

### Tactics (WAC)

WAC (300 positions), same binary and hardware:

| Budget | KiwaChess 2.3.0 | FroostRook 1 Beta |
| --- | --- | --- |
| 100,000 nodes/move | 223/300 | 238/300 |
| 100 ms/move | 229/300 | 235/300 |

WAC rewards tactics and is not a playing-strength rating; it is reported
because it separates search changes from noise. The +15 at a fixed node budget
is the clearest evidence that the search changes help; the +6 at a fixed clock
shows that the gain partly pays for the slightly lower NPS.

## NNUE prototype (experimental)

`tools/nnue/` contains a working but **experimental** NNUE-style pipeline:

- 768-input (piece × square, both perspectives) → 32 → 32 → 1 quantized MLP;
- incremental accumulators for the first layer, with a self-check over 223,296
  comparisons and 0 mismatches;
- trained on 876 public Lichess games (55,824 plies, CC0), split **by game**
  into 717 train / 159 validation games to prevent leakage;
- quantized inference reproduces the float net closely (val MSE 0.214706 vs
  0.214711) and the file is 51,556 bytes with a checksum;
- native benchmark: 7.8 µs per full refresh, 3.7 µs per incremental evaluation
  (128k / 269k evaluations/s, single-threaded on this laptop).

It is **not integrated into the playing engine**. On validation it beats a
constant predictor (MSE 0.2147 vs 0.2234, sign accuracy 59.4%) but is **worse
than a two-parameter material baseline (MSE 0.2044)**, and sanity checks fail:
a synthetic queen-up position evaluates near +12 cp. It learns a tempo/opening
bias, not material. That is a prototype of the training and quantization path,
not a usable evaluator, and the release does not pretend otherwise. Full
details and reproduction commands are in [docs/NNUE.md](docs/NNUE.md).

## Building

See [docs/BUILD.md](docs/BUILD.md). Short version (Windows, MSYS2 UCRT64 GCC):

```
cd native
g++ -O3 -std=c++17 -static -o FroostRook.exe kiwa.cpp
```

`native/build.bat` does the same and leaves a legacy `kiwa-native.exe` copy for
scripts written before the rename. `-march=native` builds are faster but are
not portable; do not publish them as the generic release asset.

The Node front-end has no npm dependencies. `native.js` looks for
`FroostRook.exe` (environment overrides `FROOSTROOK_NATIVE`, then legacy
`KIWA_NATIVE`), falls back to the legacy filename, and finally to the pure-JS
search if no binary exists. The JS fallback is correct but much slower and has
no MultiPV.

## Tests

```
npm run test:all
```

runs perft (JS and native), rules, book checks, book fallback, prediction,
UCI smoke (including MultiPV and stop), opening smoke and the analyzer suite.
The CI workflow builds the portable binary and runs the same set on
`windows-latest` for every push and tag. Strength tools (`test/wac-native.js`,
`test/elo.js`) are separate because they take minutes.

## Limitations and honest gaps

- **No NNUE strength.** The prototype is not connected to search.
- **No measurable Elo gain over 2.3.0.** +9 Elo in 40 self-play games (95% CI
  −99 to +116); the anchored results also overlap. The new work is search
  efficiency, MultiPV and analysis, not a proven strength step.
- **Raw NPS is about 6% lower than 2.3.0** on the depth-12 bench, while
  time-to-depth is 8% better. The older 0.47 M figure cannot be reproduced
  with the current bench.
- **Threads > 1 is often slower** on a 2-core laptop. The design runs
  independent searches with private TT slices; it is not a shared-TT Lazy SMP.
- **Bullet-time evidence only.** Every match here is 100 ms/move. Strength
  ordering can change at longer time controls.
- **The analyzer's labels are engine-relative**, not tablebase truth.
- **The JS fallback is weaker** and lacks MultiPV, `stop` and true threading.
- **The book is opening theory**, 24 plies by default, no tablebases.
- **Internal legacy names remain** in some file names and scripts
  (`native/kiwa.cpp`, `--kiwa` in the measurement tool, `kiwa-native.exe`
  fallback). They are kept so old tooling and links do not break; all public
  branding is FroostRook.
- **The icon is an AI-generated placeholder**, not commissioned art and not the
  old avatar. See [assets/README.md](assets/README.md).
- **No source licence file is included**; the data sources and their licences
  are listed below. Ask the repository owner before redistribution.

## Data and licences

| What | Source | Licence |
| --- | --- | --- |
| WAC test positions | [jdart1/arasan-chess `tests/wacnew.epd`](https://github.com/jdart1/arasan-chess/blob/master/tests/wacnew.epd) | BSD-style (Arasan repository); test fixture only |
| Opening book lines | [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) TSVs `a`–`e` | CC0 1.0 |
| Curated gambits and traps | `book-data/traps.tsv`, written for this project | this project |
| Human games for the predictor | public Lichess exports, 876 games / 55,824 plies, game ids recorded in `test/data/human-games.meta.json` | CC0 1.0 |
| NNUE prototype data | derived from the same CC0 game set, split by game | CC0 1.0 |
| Stockfish | separate binary, not vendored or redistributed | GPL-3.0 (upstream) |
