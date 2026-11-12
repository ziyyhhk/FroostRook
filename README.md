# FroostRook 1.0.3 Beta

<img src="assets/engine-icon.png" alt="FroostRook 1.0.3 Beta" width="200" align="right">

FroostRook 1.0.3 Beta is a from-scratch chess engine: a C++17 search core with a
handcrafted evaluator, a Node.js front-end, an embedded opening repertoire, a
human-move predictor and a PGN analysis tool. It plays the standard game,
speaks UCI, and ships as a single static Windows executable.

This is the repository formerly named `ziyyhhk/kiwa-engine`. GitHub redirects
the old URL and keeps the history, tags and releases.

> **Name and version:** the public engine name is exactly **FroostRook 1.0.3 Beta**
> (capital F, R and B). `1.0.3-beta` is the package version used in archives.
> The UCI handshake returns `id name FroostRook 1.0.3 Beta`.

## 1.0.3-beta re-issue (2026-11-12)

The `v1.1.0-beta` tag was retired per the maintainer's call and its work was
merged into this re-issue of `v1.0.3-beta`. The re-issued build contains
everything listed under "What changed in 1.1.0 Beta" below, **plus the
named-only opening-book reweight** (1,269 rows re-weighted from ~73,242
qualifying CC0 Lichess games, theory unchanged, openings suite green) and
the experimental `NNUE` scaffold (option-gated, default OFF). Strength is
**not** claimed as improved: the engine's search tree is byte-identical to
the 2026-11-11 1.0.3-beta/1.1.0-beta line (bench 660,264), and every match
remains bullet-time. Assets were re-verified by fresh download.

## Contents

- [Quick start](#quick-start)
- [1.0.3-beta re-issue (2026-11-12)](#103-beta-re-issue-2026-11-12)
- [What changed in 1.1.0 Beta](#what-changed-in-110-beta)
- [What changed in 1.0.3 Beta](#what-changed-in-103-beta)
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

## What changed in 1.1.0 Beta

- **UCI pondering support (feature).** `position ... ponder <move>` sets up
  the predicted position, `go ponder` searches it, `ponderhit` converts the
  ongoing search to the normal clock budget without restarting it, and `stop`
  aborts it promptly. A regression suite (`test/ponder-test.js`) covers both
  the ponderhit and the out-of-book-stop paths, and is wired into `npm run
  test:all` and the CI workflow.
- **Release identity:** UCI handshake `id name FroostRook 1.0.3 Beta`,
  package.json 1.0.3-beta, `app.rc` 1.0.3.0, `build.bat` portability default
  (`build.bat native` for CPU-specific builds), CI builds the portable x86-64
  asset only.
- **Strength parity, not an Elo gain.** The engine's normal search is
  byte-for-byte identical to 1.0.3-beta (same bench node count, same WAC).
  The bullet-time duel against the shipped 1.0.3-beta binary is in the
  results table below; every match remains 60–100 ms/move bullet chess; no
  rating claim is made.
- **Substantial experimental work was measured and rejected, and is not in
  the release:** Texel-tuned evaluation (**36.3%** vs 1.0.3-beta, −98 Elo);
  an endgame opposition term (**41.3%**, −61 Elo); a frequency-weighted
  opening-book regeneration from ~73k CC0 games (reverted after it reduced
  the Positional personality's median theory depth below the book-suite
  floor); and an NNUE retrained on 601k Stockfish-labelled positions
  (63.1/63.3% decisive sign accuracy vs 62.6% for a two-parameter material
  baseline — a wash; still material-blind on synthetic queen-up probes — and
  not integrated). Details in [docs/TESTING.md](docs/TESTING.md) and
  [docs/NNUE.md](docs/NNUE.md).

## What changed in 1.0.3 Beta

- **Multithreading fixed.** `Threads` now runs Lazy SMP over one shared
  transposition table instead of independent searches over private table
  slices. At depth 14 on this machine a 2-thread search finishes in ~2.1x the
  wall time of one thread (~5.0x at 4 threads), and all helper output is
  suppressed so `bestmove` always comes from thread 0. UCI output, MultiPV
  and book handling are unchanged. The match evidence below shows **no
  playing-strength gain and no loss** (48.1%, −13 ±39): multithreading is a
  correctness and scaling fix, not an Elo feature.
- **Race-free transposition table.** Entries are now 16 bytes (full 64-bit
  key + packed 8-byte payload) with a documented release/acquire
  publish protocol: writers store the payload before the key, readers load
  the key before the payload, and each field is at most 8 bytes and naturally
  aligned, so concurrent searchers can never splice two positions'
  move/score/depth/flag together. Replacement prefers fresh entries, with a
  depth-gated variant behind `-DKIWA_TT_DEPTH_PREF`.
- **Mate-distance pruning** in the main search (a loss worse than a mate in
  ply is scored as such and cut immediately). Zero-cost in ordinary play;
  exact `perft` counts are unchanged.
- **Tactical screening:** WAC at 100,000 nodes solves **250/300** (versus
  248/300 for 1.0.2-beta). Experiments that lost tactics were rejected and
  are not enabled: improving-based reverse futility (−6 WAC), history-based
  LMR reduction (+8.3% nodes, no gain), razoring (−29 WAC), singular
  extensions (+0), late-move pruning (+1). All remain behind build switches
  and default to off.
- **NNUE prototype retrained** with best-checkpoint export (validation-optimal
  epoch 17 instead of the overfit final epoch): validation MSE 0.213855 vs
  0.214711 before, sign accuracy 59.86% vs 59.36%, parity selftest 192/192.
  It is **still not integrated** and still weaker than a two-parameter
  material baseline on validation (MSE 0.2044). The trainer now also reads a
  larger `games.txt` corpus via `--dataset` (built by `tools/nnue/dataset.js`).
- **Build hygiene:** `native/build.bat` default is the portable generic
  x86-64 build (`-march=x86-64 -mtune=generic`); `build.bat native` keeps the
  machine-specific build for local use. Windows executable metadata is now
  1.0.3.0 (it was stale at 1.0.1.0 in 1.0.2-beta). CI builds the portable
  binary only.
- **Clock-speed sanity check:** at depth 12 the 1.0.3 search visits ~660k
  nodes (versus 573,342 for 1.0.2-beta) at parity NPS on this laptop; the
  deeper tree is the price of the always-overwrite/keeping policy and was
  tolerated only because tactical strength did not regress. See
  [docs/TESTING.md](docs/TESTING.md) for the full A/B record.
- **The 1.0.3-beta engine is measured at strength parity with 1.0.2-beta**
  in a 60 ms/move, no-book, colour-swapped, 40-paired-opening duel:
  48.1% (+31 =15 −34, −13 ±39 1σ, n=80). The gains are correctness
  (threading, TT race freedom), tactics at fixed node budget, and the
  retrained prototype — not Elo, and no such claim is made.

## What changed in 1 Beta

- **Evaluation (patch 1.0.2-beta):** a piece-threat term (pawns attacking
  a piece, and undefended attacked pieces), king danger from weighted enemy
  attacks on the king ring plus open files next to the king, a
  rook-behind-passed-pawn bonus, and king-shield scoring removed from the
  endgame half. The attack maps are built once per positional-cache miss and
  the extras cache is larger; the depth-12 bench visits 573,342 nodes (versus
  567,818 for 1.0.1-beta). WAC at 100,000 nodes is 248/300, equal to
  1.0.1-beta. In 60 ms/move, no-book, paired-opening matches against
  KiwaChess 2.3.0 the 1.0.2-beta build scores 55.0% over 80 games (+35 Elo,
  95% CI −41 to +111); three earlier runs of the same evaluation scored 55.3%
  over 200 games, so the four runs together are 55.2% over 280 games (+36,
  95% CI −6 to +78). The shipped 1.0.1-beta scored 46.7% in the same fixture.
  The new terms cost about 29% of CPU NPS, so the gain is measured at fixed
  time with fewer nodes per second. See
  [docs/TESTING.md](docs/TESTING.md#10-evaluation-rework-2026-11-03).
- **Search (patch 1.0.1-beta):** internal iterative reduction was **removed**
  after A/B testing showed it cost tactics without a node win, and captures are
  now ordered by SEE instead of MVV-LVA. At depth 12 from the start position
  the current build visits 567,818 nodes, versus 590,750 for 1.0.0-beta and
  680,757 for 2.3.0. On WAC at 100,000 nodes it solves 248/300, versus 238 for
  1.0.0-beta and 223 for 2.3.0. At 100 ms the medians of three runs are
  241/300 for the patch, 234 for 1.0.0-beta and 236 for 2.3.0; timed WAC is
  noisy, so the fixed-node run is the cleaner tactical signal. Match evidence
  is in [Measured results](#measured-results).
- **Search (1.0.0-beta baseline):** futility pruning of quiet moves, a
  pawn-attack cache that survives across evaluations, and ep keys only when a
  legal ep capture exists.
- **MultiPV:** real multipv 1–8 output with ordered, distinct root lines, and
  `bestmove` always equal to line 1. MultiPV searches run single-threaded.
- **Analysis:** new `analyze.js` PGN analyzer with consistent before/after
  evaluation at the same budget, disclosed move labels, ACL, JSON output and a
  42-check regression suite. Patch `1.0.1-beta` adds threefold/fifty-move/
  dead-position recognition with score-sheet consistency checks, up to eight
  MultiPV candidate lines per position, and grows the suite to 62 checks.
- **Identity:** engine, front-end, package, docs and CI now identify as
  FroostRook 1 Beta; the GitHub repository was renamed in place.
- **Branding (patch 1.0.1-beta):** the approved frozen-rook artwork is now the
  README logo, Windows executable icon (16–256 px, transparent outside the
  rounded square), documentation mark and a 1280×640 social-preview image.
- **NNUE:** a trained prototype (trainer, quantized net, metrics, self-test)
  lives in `tools/nnue` and `data/nnue`. It is **not integrated** and is not
  used for play; its measured quality is below the handcrafted evaluator. The
  patch adds a reproducible Lichess-dump dataset builder, but the shipped net
  was **not** retrained on it. See
  [the prototype section](#nnue-prototype-experimental).
- **NPS and time-to-depth (patch 1.0.1-beta):** nine interleaved depth-12
  bench runs on an idle machine give 0.914 M nodes/s / 621 ms for the patch,
  0.938 M / 630 ms for 1.0.0-beta, and 0.970 M / 702 ms for 2.3.0. Raw NPS is
  still 5.7% below 2.3.0, but the patch reaches depth 12 in 11.5% less time
  because it visits 16.6% fewer nodes. Against 1.0.0-beta it uses 3.9% fewer
  nodes and is 1.4% faster to the same depth; NPS is 2.5% lower, consistent
  with the cost of SEE capture ordering. No evaluation terms were removed and
  no strength was traded for NPS. The 0.47 M figure in the 2.3.0 notes could
  not be reproduced with this bench and is not used as a baseline. See
  [docs/TESTING.md](docs/TESTING.md) for the full method.

## Engine and UCI

FroostRook implements the standard UCI handshake and search commands, plus:

| Option | Default | Range |
| --- | --- | --- |
| `Threads` | 1 | 1–8 (Lazy SMP over a shared transposition table) |
| `Hash` | 64 MB | 1–512 |
| `MultiPV` | 1 | 1–8 |
| `OwnBook` / `Book Depth` / `Book Variety` / `Book Style` | on / 24 / 100 / Balanced | see [docs/UCI.md](docs/UCI.md) |
| `Opening Diversity` / `Random Seed` | 50 / 0 | book spread and reproducibility |
| `Move Overhead` | 30 ms | 0–1000 |
| `Clear Book Memory`, `Clear Hash` | buttons | |

UCI pondering is supported end to end: `position ... ponder <move>` sets up the
predicted position, `go ponder` searches it, `ponderhit` converts the ongoing
search to the normal clock budget without restarting it, and `stop` abandons a
ponder search whose prediction was wrong. See [docs/UCI.md](docs/UCI.md#pondering)
and `test/ponder-test.js`.

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

Depth-12 bench from the start position, portable generic x86-64 builds. The
2.3.0, 1.0.0 and 1.0.1 rows are nine interleaved runs each on an otherwise
idle machine. The 1.0.2 row is from the five-run CPU-only set in
[docs/TESTING.md](docs/TESTING.md#10-evaluation-rework-2026-11-03-shipped-as-102-beta),
where wall-clock time was not recorded:

| Build | nodes | wall time median (range) | CPU NPS median | wall NPS median (range) |
| --- | --- | --- | --- | --- |
| KiwaChess 2.3.0 baseline | 680,757 | 702 ms (664–768) | not instrumented | 0.970 M (0.886–1.025) |
| FroostRook 1.0.0-beta | 590,750 | 630 ms (605–707) | 0.995 M | 0.938 M (0.836–0.976) |
| FroostRook 1.0.1-beta | 567,818 | 621 ms (593–639) | 0.956 M | 0.914 M (0.889–0.958) |
| FroostRook 1.0.2-beta | 573,342 | not recorded | 0.719 M | not recorded |
| FroostRook 1.0.3-beta | 660,264 | not recorded | parity with 1.0.2 on the same loaded machine | not recorded |
| FroostRook 1.0.3-beta | 660,264 | not recorded | parity with 1.0.3 on the same machine | not recorded |

Against 2.3.0 the patch visits 16.6% fewer nodes and reaches the same depth
11.5% sooner, while raw wall NPS is 5.7% lower. Against 1.0.0-beta it visits
3.9% fewer nodes and reaches depth 12 in 1.4% less time; wall NPS is 2.5%
lower and CPU NPS 3.9% lower, consistent with SEE ordering making each node
slightly costlier. **This is a time-to-depth improvement, not an NPS
recovery.**

In the five-run set where both evaluation builds were measured interleaved,
the 1.0.1 control ran at 1.010 M CPU NPS and 1.0.2 at 0.719 M, so the new
terms cost about 29% per node. 1.0.2 visits about 1% more nodes and reaches
depth 12 in 797 ms of CPU time versus 562 ms for 1.0.1. The 55.0% match score
is at fixed time, so it is achieved despite this cost, not by searching more
nodes.

The previous release documented 0.75 → 0.47 M (portable) and 0.72 → 0.54 M
(native). Those figures cannot be reproduced with this bench: the 2.3.0
baseline itself measures 0.886–1.025 M here. The old numbers were taken with a
different bench and machine state, so they are reported only as history. On
same-bench, idle measurements there is no 0.47 M regression.

An aggressive move-count pruning variant (590 k → 308 k nodes at depth 12) was
built and rejected: it scored 43.3% against the Stockfish anchor, versus 51.3%
for the shipped build, and is not in the release. That result is recorded in
[docs/TESTING.md](docs/TESTING.md) rather than hidden.

### Strength

| Match | Games | Result | Score | Elo / performance (95% CI) |
| --- | --- | --- | --- | --- |
| 1.0.1-beta search build vs 1.0.0-beta release, 60 ms/move, no book, 120 paired openings | 240 | +103 =49 −88 | 53.1% | +22 (−22 to +66) |
| 1.0.1-beta vs Stockfish `UCI_Elo 2200`, 100 ms/move, book on, 60 paired openings | 120 | +48 =17 −55 | 47.1% | performance 2180 (2117–2243) |
| 1.0.0-beta vs KiwaChess 2.3.0, 100 ms/move, no book, 20 colour-swapped openings | 40 | +16 =9 −15 | 51.3% | +9 (−99 to +116) |
| 1.0.0-beta vs Stockfish `UCI_Elo 2200`, 100 ms/move, book on, 20 paired openings | 40 | +19 =3 −18 | 51.3% | performance 2209 (2101–2317) |
| KiwaChess 2.3.0 control vs the same Stockfish setting | 40 | +23 =1 −16 | 58.8% | performance 2261 (2151–2371) |
| **1.0.2-beta (new eval) vs KiwaChess 2.3.0, 60 ms/move, no book, 40 paired openings** | **80** | **+34 =20 −26** | **55.0%** | **+35 (−41 to +111)** |
| Same evaluation before the rook-cache fix, three runs (30+30+40 pairs) | 200 | +93 =35 −72 | 55.3% | +37 (−12 to +85) |
| For comparison: 1.0.1-beta release vs KiwaChess 2.3.0, same 60 ms fixture | 60 | +21 =14 −25 | 46.7% | −23 (−111 to +65) |
| **1.0.3-beta vs the shipped 1.0.2-beta binary, 60 ms/move, no book, 40 colour-swapped pairs** | **80** | **+31 =15 −34** | **48.1%** | **−13 (−89 to +63)** |
| **1.0.3-beta vs Stockfish `UCI_Elo 2200`, 100 ms/move, book on, 20 paired openings** | **40** | **+21 =4 −15** | **57.5%** | **performance 2253 (2145–2361)** |
| **1.0.3-beta vs the shipped 1.0.3-beta binary, 60 ms/move, no book, 40 colour-swapped pairs** | **80** | **+28 =13 −39** | **43.1%** | **−48 ±39 1σ (CI includes zero)** |

The 1.0.2-beta evaluation was measured in four runs against the same 2.3.0
binary and fixture: the corrected build scored 44/80, and three earlier runs
(before the rook-behind-passer cache fix described in TESTING §10) scored
38/60, 29.5/60 and 43/80. All four together are 154.5/280 = 55.2%, +36 Elo
(95% CI −6 to +78). The same fixture measured the shipped 1.0.1-beta at
46.7%, so the improvement over the release is direct. The 95% interval still
touches zero, and the match is 60 ms/move bullet chess; treat +36 as a point
estimate, not a rating.

**The patch's gain is plausible but not proven, and the two tests disagree.**
The new search build scored 53.1% over 240 games, a +22 Elo point estimate
whose 95% interval (−22 to +66) still includes zero. Against Stockfish
`UCI_Elo 2200` the same patch scored 47.1%, performance 2180 (2117–2243),
29 points below the previous release's 2209 point estimate but well inside its
interval. Neither measurement establishes a strength change; the honest
summary is "no regression proven, possible small gain, possible small loss".
The candidate and final binaries share the same search source; at 100,000
nodes they solve exactly the same WAC set. Colours were split 56.3% as White
and 50.0% as Black in the duel, so some of the result is a first-move effect
rather than a clean engine difference.

The older 40-game tests (1.0.0-beta against KiwaChess 2.3.0 and Stockfish)
could not resolve differences below roughly 100 Elo at 95% confidence. An
earlier 120-game head-to-head with an aggressive pruning build scored 54.6%
(+32, 95% CI −30 to +94); that build was not shipped because it measured 43.3%
against Stockfish and its colour split was unstable. All variants and match
types are in [docs/TESTING.md](docs/TESTING.md).

The 2.3.0 binary is the previous release asset, kept byte-identical as the
baseline. Both sides use the same movetime and the same opening pairs with
colours swapped. Treat the absolute anchored number as "roughly this strong on
Stockfish's UCI_Elo scale", not a CCRL rating: Stockfish's own limited-strength
calibration is an unknown, and 100 ms/move is bullet chess.

No 3000 Elo claim is made anywhere. The engine is a handcrafted, single-author
engine; reaching 3000 requires an integrated NNUE and far more testing.

### Tactics (WAC)

WAC (300 positions), each build run separately on the same hardware:

| Budget | KiwaChess 2.3.0 | 1.0.0-beta | 1.0.1-beta | 1.0.2-beta | 1.0.3-beta |
| --- | --- | --- | --- | --- | --- |
| 100,000 nodes/move | 223/300 | 238/300 | 248/300 | 248/300 | 250/300 |
| 100 ms/move (median of 3) | 236/300 | 234/300 | 241/300 | not measured |

WAC rewards tactics and is not a playing-strength rating; it is reported
because it separates search changes from noise. At a fixed node budget the
patch solves 10 more positions than 1.0.0-beta and 25 more than 2.3.0 (248 vs
238 vs 223); 1.0.2 also solves 248/300, and its timed WAC was not re-run. At
100 ms the patch's three runs were 239, 241 and 242 (median
241), versus 233–236 for 1.0.0-beta and 232–236 for 2.3.0. The timed gain over
1.0.0-beta (+7) is smaller than the fixed-node gain and sits within this
fixture's run-to-run spread; the deterministic fixed-node result is the
stronger evidence.

### Elo by version

| Version | Stockfish `UCI_Elo 2200` performance (95% CI) | Score vs KiwaChess 2.3.0 | Elo vs 2.3.0 (95% CI) |
| --- | --- | --- | --- |
| KiwaChess 2.3.0 | 2261 (2151–2371) | control | — |
| FroostRook 1.0.0-beta | 2209 (2101–2317) | 51.3% (40 games, 100 ms) | +9 (−99 to +116) |
| FroostRook 1.0.1-beta | 2180 (2117–2243) | 46.7% (60 games, 60 ms) | −23 (−111 to +65) |
| FroostRook 1.0.2-beta | not measured | 55.0% (80 games, 60 ms) | +35 (−41 to +111) |
| FroostRook 1.0.3-beta | 2253 (2145–2361), 40 games, 100 ms, book on | 48.1% vs 1.0.2-beta (80 games, 60 ms) | n/a vs 2.3.0 |
| FroostRook 1.0.3-beta | n/a (engine core unchanged) | 43.1% vs 1.0.3-beta (80 games, 60 ms) — a bullet-time, loaded-machine result; identical search tree in both binaries, CI includes zero | n/a vs 2.3.0 |

Stockfish matches used 100 ms/move with the book on: 40 games for 2.3.0,
1.0.0 and 1.0.3-beta; 120 for 1.0.1. The 2.3.0 matches used no book; 1.0.0,
1.0.2 and 1.0.3 played at 100 ms/move against the anchor, while the
1.0.1-vs-1.0.2 rows used 60 ms, so the 1.0.1 rows are not directly comparable
to the others. The four 1.0.2 evaluation runs together are 55.2% over 280
games (+36, 95% CI −6 to +78). 1.0.3-beta anchors at 2253 (2145–2361),
in line with the previous releases' 2180–2261 band; the 1.0.1-vs-1.0.2
transitive estimate of ~2238 sits comfortably inside its interval. The direct
1.0.1-vs-1.0.2 match has not been run; the +58 figure assumes transitivity
through 2.3.0. No comparable Elo measurement exists in this report for Kiwa
2.0.1 or 2.2.0.

## NNUE prototype (experimental)

`tools/nnue/` contains a working but **experimental** NNUE-style pipeline:

- 768-input (piece × square, both perspectives) → 32 → 32 → 1 quantized MLP;
- incremental accumulators for the first layer, with a self-check over 223,296
  comparisons and 0 mismatches;
- trained on 876 public Lichess games (55,824 plies, CC0), split **by game**
  into 717 train / 159 validation games to prevent leakage;
- the trainer now exports the validation-optimal checkpoint (epoch 17)
  instead of the overfit final epoch: val MSE 0.213855 (vs 0.214711
  previous), sign accuracy 59.86%;
- quantized inference reproduces the float net closely (both 0.213855) and
  the file is 51,556 bytes with a checksum;
- native benchmark: parity selftest 192/192 in the latest run,
  ~156k evaluations/s full refresh and ~320k incremental (single pass,
  loaded laptop; timings vary substantially with machine load).

It is **not integrated into the playing engine**. On validation it beats a
constant predictor (MSE 0.2139 vs 0.2234) but remains **worse
than a two-parameter material baseline (MSE 0.2044)**, and sanity checks fail:
a synthetic queen-up position evaluates near +11 cp. It learns a tempo/opening
bias, not material. That is a prototype of the training and quantization path,
not a usable evaluator, and the release does not pretend otherwise. Full
details and reproduction commands are in [docs/NNUE.md](docs/NNUE.md).

## Building

See [docs/BUILD.md](docs/BUILD.md). Short version (Windows, MSYS2 UCRT64 GCC):

```
cd native
windres app.rc -O coff -o app.o
g++ -O3 -march=x86-64 -mtune=generic -std=c++17 -static -o FroostRook.exe kiwa.cpp app.o
```

`native/build.bat` does the same and leaves a legacy `kiwa-native.exe` copy for
scripts written before the rename. `build.bat native` uses `-march=native` for
a faster local binary; it may crash on older CPUs and is never the release
asset.

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
- **The 1.0.2-beta eval gain is a point estimate.** Four runs of the same
  evaluation against 2.3.0 total 55.2% over 280 games, +36 Elo with a 95%
  interval (−6 to +78) that still touches zero, in 60 ms/move games only. The
  threat and king-safety weights are hand values, not tuned by SPSA or a
  regression over a corpus.
- **The 1.0.2-beta eval is about 29% slower per node** than 1.0.1-beta on the
  depth-12 bench (median CPU NPS 719 k versus 1,010 k over five interleaved
  runs on an idle laptop). The WAC result is unchanged (248 vs 248 of 300), and
  the match gain is measured at fixed time despite fewer nodes per second.
- **No proven strength gain from patch 1.0.1-beta.** The 240-game duel against
  1.0.0-beta scored 53.1% (+22 Elo, 95% CI −22 to +66), but the 120-game
  anchored match measured 2180 (2117–2243), below the previous release's 2209
  point estimate. The two samples disagree in sign; neither proves a change.
  The new work is search efficiency, MultiPV and analysis. No 3000 Elo claim
  is made.
- **Raw NPS is about 5.7% lower than 2.3.0** on the depth-12 bench, while
  time-to-depth is 11.5% better. The older 0.47 M figure cannot be reproduced
  with the current bench.
- **No measured strength gain from 1.0.3-beta.** The 60 ms/move, no-book,
  colour-swapped duel against the shipped 1.0.2-beta binary scored 48.1%
  (+31 =15 −34, −13 ±39 1σ, n=80) — statistical parity. The release adds
  correct multithreading (Lazy SMP), a race-free transposition table,
  mate-distance pruning, an NNUE retrain and packaging changes; it does not
  add Elo, and no such claim is made. Searching at fixed node budget is
  modestly better on WAC (250/300 vs 248/300) at the cost of ~15% more nodes
  at depth 12.
- **Threads > 1 uses Lazy SMP** over a shared transposition table with a
  per-helper move-order perturbation; it is the standard, unsynchronized
  design. It scales walls-clock time at machine-width but gives no guarantee
  of additional strength at bullet time. On this 2-core laptop, depth-14
  searches finish in ~2.1x (2 threads) and ~5.0x (4 threads) the wall time of
  a 1-thread search.
- **Bullet-time evidence only.** Every match here is 60–100 ms/move. Strength
  ordering can change at longer time controls.
- **The analyzer's labels are engine-relative**, not tablebase truth.
- **The JS fallback is weaker** and lacks MultiPV, `stop` and true threading.
- **The book is opening theory**, 24 plies by default, no tablebases.
- **Internal legacy names remain** in some file names and scripts
  (`native/kiwa.cpp`, `--kiwa` in the measurement tool, `kiwa-native.exe`
  fallback). They are kept so old tooling and links do not break; all public
  branding is FroostRook.
- **The icon is the approved frozen-rook artwork** supplied for this project,
  with a transparent rounded-square mask derived from the source image. See
  [assets/README.md](assets/README.md).
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
