# FroostRook 1 Beta — test and measurement report

This is the full record behind the numbers in `README.md`. It covers what was
tested, how, on what hardware, and what the results do **not** prove. Every
number below came from a run of the binaries and scripts in this repository.
No Elo, speed or accuracy figure is estimated or extrapolated.

- Date of final runs: 2026-11-01.
- Hardware: Intel Core i3-5005U (2 physical cores, 4 logical threads, 2.0 GHz),
  Windows 10 Home Single Language 10.0.19045, 8 GB RAM.
- Toolchain: MSYS2 UCRT64 g++ 16.2.0 (`-O3 -std=c++17 -static`), Node.js
  v24.21.0.
- Engine under test: `FroostRook.exe` built with the same generic x86-64
  command CI uses (`-O3 -std=c++17 -static`, no `-march=native`). Measurement
  binary 4,633,795 bytes, SHA-256
  `e98d46ad12785e7230cdcb490e5a4ad34db2d156c3e8b7a07500a2cbb85b3a6a`;
  UCI id `FroostRook 1 Beta`. A rebuild with the same source and flags is not
  byte-identical because the resource/linker timestamps change, so the
  CI-built asset's hash can differ.
- Baselines: `fr1-release.exe`, the published `v1.0.0-beta` asset, SHA-256
  `4a64a22eb35b02b3f82a52ec15b3e47b29cbb4f11854e4baf43f24fe0dd3d6b2`;
  and `kiwa-2.3.0-baseline.exe`, the published 2.3.0 asset.
- Opponent: Stockfish 19 (`stockfish-windows-x86-64-universal.exe`),
  `UCI_LimitStrength=true`, `UCI_Elo=2200`, 1 thread, 16 MB hash.

Timing runs were made with no other work on the machine. Match runs note when
other load was present; the match clock is per move, so the effect is shared
by both sides, but it can still change the effective time control.

## 1. Move generation and rules

`npm run test:all` (exit 0) includes:

| Suite | Result |
| --- | --- |
| JavaScript perft, 9 positions to their published depths | all pass |
| Native perft, same 9 positions | all pass |
| Rules (castling, ep, promotion, repetition, 50-move, mate/stalemate) | all pass |
| Book data and book fallback | pass |
| Prediction model | pass |
| UCI smoke incl. MultiPV and book options | pass |
| Stop during `go infinite` / `go movetime`, 1/2/4 threads | pass |
| Opening book native suite | 140 games, 766 book plies, 7 personalities |
| Book fallback suite | 49 games, 0 illegal answers |
| PGN analyzer regression | 62 checks, 0 failures |

Perft start position depth 5 = **4,865,609** nodes in both generators. The
suite also covers Kiwipete (4,085,603 at depth 4), positions 3–6, a dedicated
en-passant position, castling rights and underpromotion. Castling, ep and
promotion are additionally exercised through the PGN parser and the analyzer's
special-move fixture.

UCI checklist (run manually on the release binary):

```
uci                  -> id name FroostRook 1 Beta, all options, uciok
isready              -> readyok
position startpos
go depth 10          -> info lines, bestmove
go infinite + stop   -> bestmove within 1.4 s
quit                 -> clean exit
setoption name MultiPV value 3 + go depth 6
                     -> 3 ordered, distinct root lines; bestmove = line 1
```

## 2. Speed and NPS

Workload: `FroostRook.exe bench 12` — fixed depth 12 from the start position,
64 MB hash, one thread. Nine interleaved runs per build on an idle machine,
reported as medians with observed ranges. `bench` reports search nodes, wall
time, process CPU time (new builds) and NPS.

| Build | nodes | wall time median (range) | wall NPS median (range) | CPU NPS median |
| --- | --- | --- | --- | --- |
| KiwaChess 2.3.0 | 680,757 | 702 ms (664–768) | 0.970 M (0.886–1.025) | not instrumented |
| FroostRook 1.0.0-beta | 590,750 | 630 ms (605–707) | 0.938 M (0.836–0.976) | 0.995 M |
| FroostRook 1.0.1-beta | 567,818 | 621 ms (593–639) | 0.914 M (0.889–0.958) | 0.956 M |

All builds return `b1c3` with score `cp 8` at depth 12.

Against 2.3.0 the patch still has 5.7% lower raw NPS, but reaches the same
depth in 11.5% less wall time because it visits 16.6% fewer nodes. Against
1.0.0-beta it visits 3.9% fewer nodes and reaches depth 12 in 1.4% less time;
wall NPS is 2.5% lower and CPU NPS 3.9% lower, consistent with the cost of
SEE-ordered captures. Nine runs still leave several percent of run-to-run
variation, so these are small effects, not precise constants.

Note on the historical regression: the 2.3.0 notes recorded 0.75 → 0.47 M
(portable) and 0.72 → 0.54 M (native). The 2.3.0 binary in this repository
does **not** reproduce 0.47 M on the current bench; it measures 0.886–1.025 M.
The old figures were produced with a different bench and/or machine state and
are not comparable. This report only compares same-bench, idle runs. It makes
no claim of recovering the 0.75 M figure.

### Search variants tested and rejected

An intermediate build added shallow move-count pruning on top of futility
pruning (skip quiet moves once `legal > 6 + depth²`). It reduced depth-12 nodes
to 308,072 and wall time to about 0.5 s, and it won a 120-game self-play match
65.5/120 (+54 =23 −43, 54.6%, +32 Elo, 95% CI −30 to +94). However:

- vs Stockfish UCI_Elo 2200 (60 games): 26/60 = 43.3%, performance 2153,
  95% CI 2064–2242, with a colour split of 38.3% as White / 48.3% as Black;
- the shipped build without that rule scored 51.3% against the same anchor
  in 40 games (performance 2209, 95% CI 2101–2317);
- the 2.3.0 control scored 58.8% (performance 2261, 95% CI 2151–2371).

The rule was removed from the release. This is a judgement call on
conflicting short samples, not a proof that the rule is bad; it is documented
because it shaped the final build.

## 3. Tactics (WAC)

`test/wac-native.js`, 300 positions, one process per engine, same hardware.
The fixed-node run is deterministic; the clock run is not.

| Budget | KiwaChess 2.3.0 | 1.0.0-beta | 1.0.1-beta |
| --- | --- | --- | --- |
| 100,000 nodes/move | 223/300 (74.3%) | 238/300 (79.3%) | 248/300 (82.7%) |
| 100 ms/move, median of 3 | 236/300 (78.7%) | 234/300 (78.0%) | 241/300 (80.3%) |

The patch removes internal iterative reduction and orders captures by SEE.
The fixed-node run is deterministic and is the cleanest signal: +25 over 2.3.0
and +10 over 1.0.0-beta. The 100 ms runs were 2.3.0 236/232/236, 1.0.0-beta
236/233/234 and 1.0.1-beta 241/242/239. The timed gain over 1.0.0-beta (+7) is
smaller than the fixed-node gain and within the fixture's spread, so it is not
treated as a rating result.

WAC is a tactics fixture, not a playing-strength rating.

## 4. Strength matches

All matches are paired: each opening is played twice with colours swapped.
Adjudication is checkmate, stalemate, threefold, 50-move, dead material, or a
300-ply cap scored as a draw. Both engines get the same fixed time control
within a match (60 ms/move for the patch duel, 100 ms/move for the anchors).
Error is 1σ sampling error from the binomial score (173.7/√(n·p·(1−p)));
95% intervals multiply that by 1.96. These intervals cover game noise only.

### 4.1 FroostRook 1 Beta vs KiwaChess 2.3.0

- 20 opening pairs = 40 games, book off, no tablebases.
- FroostRook 20.5/40 (+16 =9 −15) = **51.3%**.
- Elo difference **+9**, 1σ ±55, 95% CI **−99 to +116**.
- Colour split: 11/20 as White (55.0%), 9.5/20 as Black (47.5%).
- Mean reported depth 9.3 vs 9.1; 61,569 vs 76,166 nodes/move.
- Mean game length 132.8 plies, 12.7 s wall per game.

An earlier 120-game match of the rejected aggressive variant scored 54.6%
(+32, 95% CI −30 to +94); that result does not apply to the shipped build.

### 4.2 FroostRook 1 Beta vs Stockfish `UCI_Elo 2200`

- 20 paired openings = 40 games, book on.
- FroostRook 20.5/40 (+19 =3 −18) = **51.3%**.
- Performance Elo **2209** vs the 2200 anchor (1σ ±55, 95% CI 2101–2317).
- Mean depth 8.2 vs Stockfish 19.3; 50,762 vs 35,988 nodes/move.
- Mean game length 119.8 plies, 11.3 s wall per game.

### 4.3 Control: KiwaChess 2.3.0 vs the same Stockfish setting

- 20 paired openings = 40 games, book on, same anchor and TC.
- 2.3.0 23.5/40 (+23 =1 −16) = **58.8%**.
- Performance Elo **2261** vs 2200 (1σ ±56, 95% CI 2151–2371).
- Mean depth 7.4 vs Stockfish 21.4; 59,386 vs 32,636 nodes/move.

### 4.4 Patch search build vs 1.0.0-beta (240 games)

- 120 opening pairs = 240 games, book off, 60 ms/move, colours swapped.
- New build (IIR removed, SEE capture ordering) 127.5/240
  (+103 =49 −88) = **53.1%**.
- Elo difference **+22**, 1σ ±22, 95% CI **−22 to +66**.
- Colour split: 67.5/120 as White (56.3%), 60/120 as Black (50.0%).
- Mean reported depth 8.2 vs 8.5; 33,989 vs 38,182 nodes/move.
- Outcomes: checkmate 191, threefold 27, dead material 17, 50-move 2,
  300-ply cap 3. Mean game length 139.7 plies, 8.1 s wall.
- The new side is the pre-icon candidate binary. The final source differs only
  by removing compile-time experiment switches and embedding the icon; at
  100,000 nodes both binaries solve exactly the same WAC positions, and both
  visit 567,818 nodes at bench depth 12.
- PGN: `.build/duel-niir-see.pgn` (local run; not shipped).

### 4.5 Patch vs Stockfish `UCI_Elo 2200` (120 games)

- 60 paired openings = 120 games, book on, 100 ms/move, colours swapped.
- Final generic x86-64 binary (same build flags as CI): 56.5/120
  (+48 =17 −55) = **47.1%**.
- Performance Elo **2180** vs the 2200 anchor (1σ ±32, 95% CI 2117–2243).
- Colour split: 30.5/60 as White (50.8%), 26/60 as Black (43.3%).
- Mean reported depth 9.0 vs Stockfish 19.9; 57,715 vs 43,500 nodes/move.
- Outcomes: checkmate 103, 300-ply cap 11, 50-move 2, threefold 4. Mean game
  length 138.8 plies, 13.0 s wall.
- The 1.0.0-beta control on the same anchor was 2209 (2101–2317, 40 games).
  The patch's point estimate is 29 Elo lower, with heavily overlapping
  intervals. This does not show a regression either; it simply does not
  confirm the duel's positive sign.

### What the matches mean

The 240-game patch comparison is the largest sample and points to +22 Elo, but
its 95% interval (−22 to +66) includes zero. Against the Stockfish anchor the
same patch measured 2180, 29 points below the previous release's 2209 point
estimate and well inside its interval. The two measurements disagree in sign,
which is what samples of this size do when the true difference is small.
**The patch has not demonstrated a strength gain; the honest summary is "no
regression proven, possible small gain, possible small loss".** The colour
split (56.3% White vs 50.0% Black in the duel) also shows that part of the
score is a first-move effect.

The 1 Beta and 2.3.0 point estimates on the anchor differ by 52 Elo, and the
95% intervals overlap by a wide margin. The direct 40-game comparison is +9
Elo with an interval spanning roughly ±107. **Neither result demonstrates a
strength increase.** The sample cannot resolve differences below about 100 Elo
at 95% confidence, and all games are bullet chess on two cores. No 3000 Elo
claim is made; nothing here supports one.

The absolute anchored number is a performance estimate on Stockfish's
`UCI_Elo` scale. Stockfish's limited-strength calibration is an unknown, so it
is not a CCRL rating and should not be quoted as one.

## 5. Threads

`test/thread-bench.js` with one repetition per thread count, three workloads.
Threads > 1 run independent searches over private TT slices, not shared-TT
Lazy SMP.

| Workload | 1 thread | 2 threads | 4 threads |
| --- | --- | --- | --- |
| depth 14 startpos | 2,043 ms | 2,644 ms (0.77×) | 4,628 ms (0.44×) |
| 300 k nodes, Italian | 461 ms | 530 ms (0.87×) | 870 ms (0.53×) |
| 300 k nodes, open | 287 ms | 330 ms (0.87×) | 537 ms (0.53×) |

All searches returned legal moves with no crashes or hangs, but throughput on
this 2-core laptop falls with thread count. Multithreading is a correctness
feature here, not a speedup claim.

## 6. NNUE prototype

See [NNUE.md](NNUE.md) for the architecture, format and reproduction steps.
Summary of independently rerun checks:

- exact JS ↔ C++ parity on the 192-position self-test: 192/192, 0 mismatches;
- incremental accumulators: 223,296 self-check comparisons, 0 mismatches;
- quantized validation MSE 0.214706 vs float 0.214711;
- validation MSE 0.2147 beats a constant predictor (0.2234) but loses to a
  two-parameter material baseline (0.2044); queen-up probe evaluates +12 cp;
- native inference: 5.2 µs per full refresh and 2.3 µs per incremental
  evaluation in the latest run (194k / 432k per second). Repeated runs varied
  widely with machine load: about 70k–194k full refreshes/s and 148k–467k
  incremental/s.

The evaluator is **not compiled into the playing engine and not used in any
match above**. The playing engine always uses the handcrafted evaluator; that
is the fallback by construction, not a switchable option.

## 7. PGN analysis

`node test/analyze-test.js` runs 62 checks and passes. It verifies:

- every label follows from the before/after scores at the same budget;
- terminal mate scores and missed-mate labels;
- threefold, fifty-move, fivefold, 75-move and dead-position draws, plus
  claimable-vs-automatic status and score-sheet consistency;
- MultiPV candidate lines: deepest line per rank, distinct and ordered, and
  `--multipv` bounds;
- no "brilliant" or accuracy percentage is invented;
- comments, variations and malformed SAN do not corrupt the move list;
- castling, en passant and all promotion spellings parse;
- JSON schema and per-player ACL/worst-move output on a real game.

The analyzer makes no tablebase claims; labels describe what this engine sees
at the chosen depth/node budget.

## 8. Reproduction

```
npm run test:all
node test/wac-native.js nodes=100000 300
node test/wac-native.js 100 300
node test/thread-bench.js 1,2,4
node test/elo.js --pairs 20 --ms 100 --book false \
  --kiwa native/FroostRook.exe --opp <kiwa-2.3.0-baseline.exe>
node test/elo.js --pairs 20 --ms 100 --anchor 2200 \
  --stockfish <stockfish.exe>
```

For the anchored match the harness sets `UCI_LimitStrength=true` and
`UCI_Elo=2200` on Stockfish and leaves the book enabled. For duels the book is
disabled by default so both engines play the same opening pairs from move one.

## 9. Known gaps

- Bullet only (60–100 ms/move). No longer-time-control match was run.
- 40–240 game samples; confidence intervals are wide. The 240-game duel and
  the 120-game anchor disagree in sign for the patch.
- The 120-game anchor used the final source; the 240-game duel used an earlier
  build of the same search code (identical fixed-node WAC results and bench
  node count) without the Windows icon resource.
- One opponent setting (Stockfish 19 `UCI_Elo 2200`) plus self-play.
- No independent third-party testing, no CCRL submission.
- Threads > 1 are slower on this hardware.
- The NNUE is experimental and not integrated.
- The icon is the approved supplied artwork with a derived transparent mask;
  see `assets/README.md`.
