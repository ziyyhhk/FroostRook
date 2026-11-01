# FRNN1 — experimental NNUE-style evaluator

**Status: research prototype. Not integrated into the engine.** `native/kiwa.cpp`,
`engine.js` and the UCI layer do not reference any of this; the experimental
evaluator only exists behind `native/nnue_bench.exe` and the offline trainer.
With the data available here it is **likely weaker than the existing
handcrafted evaluation**, and — as measured below — it is also weaker than a
two-parameter material baseline on the same validation split.

This document specifies the network, the exact integer inference, the binary
format, the training data/split and the measured results, so the prototype is
reproducible and auditable.

## Contents

- [Files](#files)
- [Architecture](#architecture)
- [Feature set](#feature-set)
- [Fixed-point evaluation](#fixed-point-evaluation)
- [Binary format](#binary-format)
- [Training data and split](#training-data-and-split)
- [Targets and loss](#targets-and-loss)
- [Training procedure and results](#training-procedure-and-results)
- [C++ inference and benchmark](#c-inference-and-benchmark)
- [Honest assessment](#honest-assessment)
- [Reproducing](#reproducing)

## Files

| Path | Purpose |
| --- | --- |
| `tools/nnue/pgn.js` | Self-contained PGN reader, 0x88 board, legal move generation, SAN/`UCI` replay, feature extraction, perft. Does not depend on `engine.js`. |
| `tools/nnue/dataset.js` | Optional reproducible dataset builder: merges the in-repo CC0 exports with a deterministic filtered subset of Lichess monthly dumps and writes `data/nnue/games.txt` plus provenance. **Not used to train the shipped net**, and its output format is not yet consumed by `train.js`. |
| `tools/nnue/train.js` | Trains the float network, normalizes activation ranges, quantizes, writes the binary, the training log, `metrics.json` and the selftest set; runs the accumulator self-check. |
| `native/nnue.h` / `native/nnue.cpp` | Dependency-free C++17 loader, dual-perspective accumulator, incremental add/remove, fixed-point forward pass. |
| `native/nnue_bench.cpp` | `nnue_bench <net> <positions>`: exact selftest, incremental-vs-refresh check, timing. |
| `data/nnue/frnn1.bin` | Quantized network (51,556 bytes, checksum `0x7e7e30c7`). |
| `data/nnue/train.log` | Per-epoch training/validation log and final metrics. |
| `data/nnue/selftest.txt` | 192 `<fen>|<expected_cp>` lines exported from validation games. |
| `data/nnue/metrics.json` | Machine-readable summary of the shipped run. |

## Architecture

```
768 inputs -> feature transformer 768 x 32 -> clipped ReLU (0..255)
           -> hidden layer 32 x 32          -> clipped ReLU (0..255)
           -> output 32 x 1                -> centipawns (side to move)
```

- H1 = 32, H2 = 32. No king buckets, no additional handcrafted inputs.
- The feature transformer produces a **dual-perspective accumulator**: one
  vector for White's perspective and one for Black's. `evaluate` uses the
  accumulator belonging to the side to move.
- During training the output is interpreted as a score in centipawns and the
  loss is computed on `sigmoid(cp / K)` with **K = 400 cp**. The exported
  network returns centipawns directly (integer, clamped to ±4000).
- Weights are `int16`, biases are `int32`, the accumulator is `int32`, hidden
  activations are `uint8` in `0..255`. No floating point is used in inference.

## Feature set

Board convention (the engine's): `int8_t board[128]`, 0x88, empty = 0, White
`1..6` = P,N,B,R,Q,K, Black `9..14` (`piece | 8`), `square = rank * 16 + file`,
`a1 = 0`, rank 0 is White's first rank, side 0 = White to move, 1 = Black.

Inputs are relative to the side to move. For a piece on 0x88 square `sq` and
perspective `p` (0 = White, 1 = Black):

```
rel  = ((piece >> 3) ^ p) & 1        // 0 = own piece, 1 = enemy piece
type = (piece & 7) - 1               // 0..5 = P,N,B,R,Q,K
s    = (sq >> 4) * 8 + (sq & 7)      // a1 = 0, h8 = 63
if p == 1: s ^= 56                   // mirror ranks for the Black perspective
index = rel * 384 + type * 64 + s    // 0..767
```

Piece codes are the engine's: White `1..6` = P,N,B,R,Q,K, Black `9..14`
(`piece | 8`). The side-to-move perspective is the one used by the output; the
other accumulator is maintained for incremental updates. Both are built from
the same table. `featureIndex()` in `tools/nnue/pgn.js` and in `native/nnue.h`
must stay identical.

## Fixed-point evaluation

Let `s1/s2/s3` be the per-layer shifts stored in the header (`shift1`,
`shift2`, `shift3`) and `S1 = 2^s1`, etc.

```
acc[p][h] = b1q[h] + sum over pieces W1q[featureIndex(piece,sq,p) * H1 + h]
a1[h]     = clip( floor((acc[side][h] + S1/2) / S1), 0, 255 )   if acc > 0 else 0
z2[j]     = b2q[j] + sum_h a1[h] * W2q[h * H2 + j]
a2[j]     = clip( floor((z2[j] + S2/2) / S2), 0, 255 )          if z2 > 0 else 0
out       = b3q + sum_j a2[j] * W3q[j]
cp        = clamp( divRoundHalfAwayFromZero(out, S3), -4000, +4000 )
```

`divRoundHalfAwayFromZero(x, S)` is `floor((x + S/2)/S)` for `x >= 0` and
`-floor((-x + S/2)/S)` for `x < 0`. For positive values the clipped ReLU uses
the same floor of a rounded quotient.

Quantization:

- `W1q = round(W1 * 2^s1)`, `b1q = round(b1 * 2^s1)`.
- `W2q = round(W2 * 2^s2)`, `b2q = round(b2 * 2^s2)`.
- `W3q = round(W3 * 2^s3)`, `b3q = round(b3 * 2^s3)`.
- `round` is JavaScript `Math.round` (nearest integer, ties toward +Infinity).
- Weights are saturated to `[-32768, 32767]` and counted if that happens.
- The shifts are chosen after training from the actual weight magnitudes:
  the largest `k in [0, 14]` with `max|W| * 2^k <= 30000`. They are stored in
  the file, so the format is not tied to one fixed scale. In the shipped net:
  `s1 = 10`, `s2 = 14`, `s3 = 14`; maximum `|W1q|/|W2q|/|W3q| =
  22160 / 4176 / 14407`; zero int16 clipping events.

Before quantization, activation ranges are normalized using the positive
homogeneity of ReLU (`W1/s`, `W2*s` leaves the function unchanged): the
training-set maximum of `a1` and `a2` is scaled down to at most 200. The final
run scaled `a2` by `1/1.076` and left `a1` unchanged (`max a1 = 164.3`). This
changes the mathematical function only by rounding at quantization time.

Rounding is exact integer arithmetic and is mirrored line for line by
`native/nnue.cpp` and `makeEvaluator()` in `tools/nnue/train.js`.

## Binary format

Little-endian. Magic bytes `46 52 4E 4E 31 00` = `"FRNN1\0"`.

### Header (32 bytes)

| Offset | Size | Type | Field |
| --- | --- | --- | --- |
| 0 | 6 | bytes | magic `"FRNN1\0"` |
| 6 | 1 | u8 | version = 1 |
| 7 | 1 | u8 | flags = 0 |
| 8 | 2 | u16 | H1 (32) |
| 10 | 2 | u16 | H2 (32) |
| 12 | 2 | u16 | input features = 768 |
| 14 | 1 | u8 | shift1 |
| 15 | 1 | u8 | shift2 |
| 16 | 1 | u8 | shift3 |
| 17 | 1 | u8 | reserved = 0 |
| 18 | 2 | u16 | clamp1 = 255 |
| 20 | 2 | u16 | clamp2 = 255 |
| 22 | 2 | u16 | clampOut = 4000 |
| 24 | 4 | u32 | reserved = 0 |
| 28 | 4 | u32 | FNV-1a32 checksum of the payload |

### Payload

In order, all little-endian:

1. `b1`: H1 × int32
2. `W1`: 768 × H1 int16, row-major `[feature * H1 + h]`
3. `b2`: H2 × int32
4. `W2`: H1 × H2 int16, row-major `[h * H2 + j]`
5. `b3`: 1 × int32
6. `W3`: H2 × int16

For H1 = H2 = 32: payload = 51,524 bytes, file = 51,556 bytes. The checksum is
FNV-1a32 (`offset basis 0x811c9dc5`, prime `0x01000193`) over payload bytes
only, stored at header offset 28. The C++ loader rejects bad magic, version,
feature count, sizes, shifts, clamps, file length and checksum.

## Training data and split

- Source: `test/human-games/*.pgn`, 8 files, **876 standard games / 55,824
  plies**, fetched by `test/fetch-human-games.js` from the Lichess standard
  games database export. License: **CC0 1.0**. No downloads happen during
  training.
- Result distribution: 457 White wins, 384 Black wins, 35 draws.
- The PGN reader rejects non-standard variants (85 blocks), games with no
  moves (23), `SetUp`/`FEN` starts, aborted games and duplicate `GameId`s
  (6 blocks).
- Positions are sampled at ply >= 12, with the side to move at that ply. Both
  colors occur naturally.
- **Split by game**, never by position:
  `FNV-1a32("kiwa-frnn1 " + GameId) % 100 >= 80` -> validation. This gives
  **717 train games / 159 validation games**, and **37,302 train positions /
  9,153 validation positions**. A game is wholly in one side of the split, so
  there is no game-level leakage.
- Targets use the **final game result only**: win = 1.0, draw = 0.5, loss =
  0.0, flipped for Black to move. No engine or material labels are used.
- This 876-game set was the only data used for the shipped net. A larger-data
  pipeline exists (`tools/nnue/dataset.js`, below) but was **not** run for the
  shipped binary and is **not** wired into `train.js`.

### Optional dump-based dataset builder (not used for the shipped net)

`tools/nnue/dataset.js` is a starting point for a larger corpus:

```
node tools/nnue/dataset.js --help
node tools/nnue/dataset.js --months 2013-01,2013-06 --max-dump-games 6000 \
  --min-elo 1600 --min-base-seconds 180 --min-plies 40
```

- It downloads Lichess standard monthly dumps (CC0) to an out-of-repo cache
  (default `<tmp>/frnn1-dump-cache`), so the repository does not grow by
  gigabytes. `--no-download` uses an existing cache; `--stats-only` prints
  counts without writing.
- Games are filtered by header: Standard only, no `SetUp`/`FEN`, decisive or
  drawn result, `Termination=Normal`, base time control ≥ 180 s, both ratings
  ≥ 1600, and at least 40 plies. The filters drop bullet noise and
  time-forfeit losses, the two largest label-noise sources for a
  result-trained net.
- Selection is deterministic: games are ranked by
  `FNV-1a32("frnn1-games " + GameId)` and the lowest `--max-dump-games` are
  kept, then written sorted by id. Output is `data/nnue/games.txt` (one game
  per line, tab-separated header plus UCI moves) and
  `data/nnue/dataset.meta.json` with counts, filters, split sizes and a
  SHA-256 of the file.
- The split rule is game-level (70/15/15 by `FNV-1a32("frnn1-split " + id)`),
  so no game can leak across train/validation/test.
- **Status:** tool only. It has not been executed for a published run, its
  `games.txt` format is not read by `train.js`, and no retrained network is
  shipped. The numbers in this document all come from the 876-game set.

## Targets and loss

The network output is a centipawn score from the side-to-move perspective.
Training minimizes

```
loss = mean( (sigmoid(cp / 400) - target)^2 )
```

with Adam (β1 = 0.9, β2 = 0.999, eps = 1e-8), batch 64, L2 = 0, 24 epochs,
learning rate 2e-4 (multiplied by 0.9 per epoch in the last third, floor 2e-5).
The feature layer uses a 5× learning-rate multiplier and the two small layers
0.3× (this was selected in a small sweep; it was the best of the tried
configurations). Initialization: `b1 = 64`, `W1 ~ N(0, 4)`, `b2 = 64`,
`W2 ~ N(0, 0.05)`, `W3 ~ N(0, 0.3)`, `b3 = 0`. The full run takes about
83 seconds on the development machine.

## Training procedure and results

Final run: `node tools/nnue/train.js --epochs 24 --batch 64 --lr 0.0002 --l2 0 --w1mult 5 --w2mult 0.3 --w3mult 0.3`
(seed 12345, min ply 12).

Per-epoch MSE in score space (`train.log`):

| epoch | train | val | epoch | train | val |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.235938 | 0.223211 | 13 | 0.218733 | 0.214796 |
| 2 | 0.235412 | 0.222998 | 14 | 0.216661 | 0.214356 |
| 3 | 0.234978 | 0.222708 | 15 | 0.214765 | 0.214016 |
| 4 | 0.234397 | 0.222337 | 16 | 0.212982 | 0.213887 |
| 5 | 0.233643 | 0.221792 | 17 | 0.211362 | **0.213855** |
| 6 | 0.232582 | 0.221162 | 18 | 0.209952 | 0.213991 |
| 7 | 0.231245 | 0.220309 | 19 | 0.208780 | 0.214053 |
| 8 | 0.229631 | 0.219373 | 20 | 0.207790 | 0.214159 |
| 9 | 0.227725 | 0.218365 | 21 | 0.206947 | 0.214303 |
| 10 | 0.225578 | 0.217314 | 22 | 0.206213 | 0.214451 |
| 11 | 0.223280 | 0.216312 | 23 | 0.205598 | 0.214595 |
| 12 | 0.220943 | 0.215500 | 24 | 0.205045 | 0.214711 |

The validation optimum is epoch 17 (0.213855); the shipped binary is the
epoch-24 model (0.214711), i.e. it overfits slightly after the optimum. No
best-checkpoint restore is implemented, so the final weights are exported.

Final metrics of the shipped net:

| Metric | Value |
| --- | --- |
| Validation MSE, float | 0.214711 |
| Validation MSE, quantized | 0.214706 |
| Train MSE, quantized | 0.204747 |
| Baseline: constant score 0.4962 | 0.223436 |
| Baseline: constant 0.5 | 0.223451 |
| Validation sign accuracy (decisive positions only) | 59.36% |
| Accumulator checks / mismatches | 223,296 / 0 |
| int16 weight clipping events | 0 |

The accumulator self-check replays all 55,824 plies of all 876 games and
compares, for both perspectives, the delta-updated accumulator against a full
refresh, plus a remove/add round trip: 55,824 × 2 × 2 = 223,296 comparisons,
0 mismatches.

### Sample evaluations (centipawns, side to move)

| Position | Eval |
| --- | ---: |
| Start position | +48 |
| After 1.e4 (Black to move) | +59 |
| White queen up, `4k3/8/8/8/8/8/8/3QK3 w - - 0 1` | +12 |
| Black queen up, `3qk3/8/8/8/8/8/8/4K3 w - - 0 1` | -14 |
| Kiwa start after 1.d4 d5 2.c4 (Black to move) | +180 |

The queen-up synthetic positions are not training data; they only probe the
learned evaluation. They show that the net learned a small opening/tempo bias
and almost no material signal — a known failure mode of this tiny dataset and
network.

### Baselines

On the same validation split, a two-parameter logistic model
`sigmoid(A + B * material)` with `P=1, N=B=3, R=5, Q=9` from the side to move,
fit on the training positions, reaches **validation MSE 0.204351**
(A = 0.0676, B = 0.2085 per pawn). The NNUE's 0.214706 is worse than that
hand-made two-parameter model, despite having 25,697 parameters. This is the
clearest quantitative statement of how weak the trained net is.

## C++ inference and benchmark

`native/nnue_bench.exe` loads the binary, parses `"<fen>|<expected_cp>"` lines,
and requires an **exact** match (no tolerance). The expected values in
`data/nnue/selftest.txt` are produced by the JS quantized evaluator. The bench
also checks that incrementally updated accumulators reproduce full-refresh
evaluations, and times both paths on a loop.

Build (the `PATH` export is needed on the development machine so the compiler
finds its own DLLs):

```
export PATH="/c/msys64/ucrt64/bin:$PATH"
/c/msys64/ucrt64/bin/g++.exe -O3 -std=c++17 -static -o native/nnue_bench.exe native/nnue.cpp native/nnue_bench.cpp
```

Run:

```
./native/nnue_bench.exe data/nnue/frnn1.bin data/nnue/selftest.txt
```

Result of the latest run:

- **192/192 selftest positions PASS** (exact fixed-point match).
- Incremental vs full refresh: **192 checks, 0 mismatches**.
- Timing, scalar `-O3` build, one core (single pass per path):

| Path | positions/sec | ns/eval |
| --- | ---: | ---: |
| Full refresh (reset + evaluate) | 193,859 | 5,158 |
| Incremental (move delta + evaluate) | 431,594 | 2,317 |

Run-to-run variation on the same machine is large: observed results range from
roughly 70k to 194k positions/sec for full refresh and 148k to 467k for
incremental, depending on CPU frequency and machine load. Earlier documentation
cited medians of three runs (109k full / 248k incremental); those are within the
observed range but not a stable benchmark. The incremental path is roughly
1.8–2.3× faster because it touches only the changed squares instead of
rescanning the board. Its timing includes one full refresh per 192-position
pass (amortized over the pass). There is no SIMD; these are plain scalar loops.

## Honest assessment

- **The dataset is tiny**: 876 games, 35 draws, game-result-only labels. The
  effective signal is weak and noisy; most positions are materially balanced,
  and the final result is a poor per-position label.
- The trained net reaches validation MSE 0.2147 versus 0.2234 for a constant
  prediction — a small improvement — but is **worse than the 2-parameter
  material baseline (0.2044)**. It learns a tempo/opening bias (about +50 cp
  at the start, up to +180 cp in a normal opening line) and is almost
  material-blind (queen-up probes are ±15 cp). It is not a useful chess
  evaluator yet.
- The training pipeline itself is sound: features, legal move replay, split,
  quantization, C++/JS parity and the dual accumulator are all verified. The
  weak result is a modeling/data limitation, not an implementation shortcut.
- **This evaluator is not integrated into the engine.** It is an experimental
  prototype. With this dataset it is **likely weaker than the existing
  handcrafted evaluation**, and the engine does not use it. Integrating it
  would require a much larger, higher-quality dataset (and likely a larger
  network and better training schedule) before it could compete.
- **No retraining on larger data was completed.** `tools/nnue/dataset.js` was
  added so a bigger CC0 corpus can be assembled reproducibly, but it was not
  run to produce a training set, `train.js` was not changed to consume it, and
  no new network is shipped. The shipped `frnn1.bin` is still the 876-game
  model described above, and the handcrafted evaluation remains the default
  and the only evaluator used in play.
- Possible next steps (not done here): run `dataset.js` on enough months to
  produce a materially larger corpus, teach `train.js` to read
  `games.txt`, WDL/depth-aware labels, best-checkpoint selection, larger
  H1/H2, king buckets, SIMD, and training with a small opening-book filter.
  None of these are claimed as implemented.

## Reproducing

```
# shipped net (876 in-repo games)
node tools/nnue/train.js --epochs 24 --batch 64 --lr 0.0002 --l2 0 \
  --w1mult 5 --w2mult 0.3 --w3mult 0.3

# optional larger corpus; NOT consumed by train.js yet
node tools/nnue/dataset.js --months 2013-01,2013-06 --max-dump-games 6000

export PATH="/c/msys64/ucrt64/bin:$PATH"
/c/msys64/ucrt64/bin/g++.exe -O3 -std=c++17 -static \
  -o native/nnue_bench.exe native/nnue.cpp native/nnue_bench.cpp
./native/nnue_bench.exe data/nnue/frnn1.bin data/nnue/selftest.txt
```

Training is deterministic for a fixed seed (12345) and writes
`data/nnue/frnn1.bin`, `train.log`, `metrics.json` and `selftest.txt`.
