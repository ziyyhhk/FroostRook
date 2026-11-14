# Changelog

All notable changes to FroostRook are documented here.

## 1.0.5-beta ("FroostRook 1.0.5 Beta")

Released: 2026-11-14. Tag: `v1.0.5-beta`.

Repertoire and predictor release on a byte-identical search core. The
strength of the playing engine is exactly what 1.0.4 Beta shipped: bench
**272,589** nodes at depth 12 and WAC **252/300** at fixed 100k nodes.
No Elo claim. Everything measured this cycle that did not improve is
listed; details and raw numbers in `docs/TESTING.md` section 15.

### Opening book expanded (shipped)

- Named theory and the 1.0.4 named-line reweight are preserved
  byte-for-byte (the book generator template was resynced to the shipped
  semantics after a rename drift had broken it; regeneration is now
  byte-identical when no stats are applied).
- **+129 moves in 106 previously uncatalogued positions** from the CC0
  elite-game statistics (moves with >= 60 occurrences per move in
  positions with >= 120 analysed games; expected score for the side to
  move >= 0.42). Applied as `--gap-fill-only` to
  `tools/nnue/merge-book.js`: named positions are never touched, so the
  Positional-depth failure mode of the rejected 1.1.0-era full merge
  cannot recur. The book grew from 5,580 to **5,686 positions**
  (8,134 → **8,263 moves**). The openings suite stays green (all 7
  personalities, 140 book games / 728 book plies) and
  `test/book-check.js` passes; `native/book_data.h` regenerated and the
  native engine rebuilt.

### Predictor retrained on an expanded corpus (shipped)

- Training corpus: **876 → 2,213 CC0 Lichess games** (147,558 plies;
  1,659 train / 554 eval; same FNV-1a split, same provenance, requests
  re-fetched with the same etiquette). Prior table: **50,693 positions /
  52,760 rows** (from ~19,977 positions).
- Held-out EVAL split: top-1 **22.35% → 22.76%**, top-3
  **44.71% → 45.28%**, top-5 **55.47% → 56.01%**, log-loss
  **2.99 → 2.97**; table coverage of eval plies 9.6% → 11.0% (4,211).
- Blend re-fit (`node test/fit-predict.js 800`, leave-one-out on train):
  `{"searchWeight":1.6,"priorWeight":40,"temperature":200}`. The fit
  grid's temperature ceiling was found to clip log-loss improvement, so
  the grid was extended to 150/200 (train log-loss 3.01 at T=110 against
  2.82 at T=200). Eval A/B on 1,200 hash-sampled plies shows the new
  vector is not worse than the 1.0.4 ship on any metric.
- `test/predict-accuracy.js` re-run for both models; the gap-fill book
  and the retrained prior compose without conflict.

### Strength/speed candidates measured and rejected (not shipped)

- Reverse futility extended to depth 3: **248/300** (vs 252/300).
- Quiet-move history pruning (`KIWA_HISTORY_PRUNE=1`): **250/300**. Kept
  behind a build switch; default OFF.
- K+Q/K+R mop-up endgame term (`KIWA_MOPUP=1`): **251/300** (flips WAC
  #41). Kept behind a build switch; default OFF.
- Qsearch TT-move ordering: bench 272,540 (no node win), **251/300**.
  Reverted.
- `-flto` build: produced an **incorrect binary** (perft 4,866,525 vs
  verified 4,865,609; bogus `mate -500` at depth 2). The release uses
  the 1.0.4 portable flags unchanged. `-funroll-loops` /
  `-fno-math-errno`: NPS within run-to-run noise; not adopted.

### Release identity

- UCI `id name FroostRook 1.0.5 Beta`; `app.rc` 1.0.5.0
  (FILEVERSION 1,0,5,0); `package.json` 1.0.5-beta; front-end, docs,
  workflow (release title), README, UCI smoke test and
  `test/elo.js` all updated to match. CI builds the portable generic
  x86-64 asset only.

## 1.0.4-beta re-cut ("FroostRook 1.0.4 Beta", same tag `v1.0.4-beta`)

Released: 2026-11-13 (overwriting the 2026-11-13 04:47 UTC `v1.0.4-beta` artifacts). Tag: `v1.0.4-beta` (moved).

The 1.0.4-beta release shipped with release-integrity defects. This re-cut
fixes them; the search defaults, dependencies and book are unchanged in
effect, and the fresh CI build at the moved tag is the release binary.

### Release integrity (the critical fix)

- **Windows executable metadata said 1.0.3.0.** `app.rc` was never bumped for
  the 1.0.4 tag, so the shipped `FroostRook.exe` properties showed 1.0.3.0.
  Now 1.0.4.0 (CI rebuilds with `windres app.rc`).
- **Stale native binary in the working tree answered `id name FroostRook
  1.0.3 Beta`.** The published CI asset was a genuine 1.0.4 build (verified
  by fresh download: `uci` → `id name FroostRook 1.0.4 Beta`), but the
  repository-local artifacts were the pre-1.0.4 binary, so any test run or
  manual zip made from the tree measured the wrong engine. The release
  assets are now rebuilt from the tag.
- **Front-end/docs identity drift.** `uci.js`, `play.js`, `docs/UCI.md`,
  `docs/BUILD.md`, `docs/TESTING.md` header, `assets/README.md`,
  `test/uci-smoke.js`, `test/elo.js`, `.github/workflows/build.yml`
  (release title) and `README.md` still announced FroostRook 1.0.3 Beta.
  All updated to FroostRook 1.0.4 Beta; CI release title is
  "FroostRook 1.0.4 Beta".

### Engine (all changes measured on this machine, `wac-native.js nodes=100000 300`)

- **Bench at depth 12: 272,589 nodes** (1.0.3 line: 660,264). Per the
  re-measurement the 1.0.4 search is the strongest fixed-node tactical
  configuration on record for this engine:
  | Build | Bench | WAC@100k |
  | --- | --- | --- |
  | 1.0.4 as tagged (S1 L1 H1) | 272,589 | 252/300 |
  | 1.0.4, `KIWA_LMR_HISTORY=0` | 302,304 | 251/300 |
  | 1.0.3 configuration | 660,264 | 250/300 |
  | MVV-LVA capture ordering (`KIWA_SEE_ORDER=0`) | 247,029 | 241/300 |

  Singular extensions and late-move pruning remain enabled by default.
- **`KIWA_LMR_HISTORY` is now an overridable build switch** (`-D`); it was
  a hardcoded `#define 1` in the 1.0.4 tag. Still defaults to 1 per the
  re-measurement (one WAC position and ~10% fewer nodes vs compiled out —
  within noise on WAC).
- **`KIWA_SEE_ORDER` added** (default 1): the capture-ordering SEE call can
  now be ablated for measurement. MVV-LVA loses 11 positions (241/300) and
  is kept off; questionable orderings are not shipped by default.
- **History push/pop and malus logic unchanged**; perft exact, rules green,
  book handling unchanged.

No Elo claim is made. Every match remains bullet-time; the fixed-node tactical
suite is the yardstick. See `docs/TESTING.md` section 14.

## 1.0.4-beta ("FroostRook 1.0.4 Beta") — original 2026-11-13 release [superseded by the same-day re-cut]

Released: 2026-11-13. Tag: `v1.0.4-beta`. Superseded by the re-cut above.

### Search

- Enabled **singular extensions** (`KIWA_SINGULAR=1`). Already present and measured as strength-neutral on WAC; now on by default.
- Enabled **late-move pruning** (`KIWA_LMP=1`). Conservative depth ≤ 4, improving-aware limits. Measured +1 WAC in earlier A/B.
- Enabled **history-aware LMR** (`KIWA_LMR_HISTORY`). Quiet moves with strong/weak history receive less/more reduction.
- UCI identity updated to `FroostRook 1.0.4 Beta`.
- Perft counts, rules, and book handling unchanged. Full source restore of `native/kiwa.cpp` is in progress after a large-file update issue; the functional changes above are the intended 1.0.4 content.

No Elo claim is made. These are the previously gated, measured-neutral-or-positive search features now turned on.

## 1.0.3-beta re-issued ("FroostRook 1.0.3 Beta")

Released: 2026-11-12. Tag: `v1.0.3-beta` (re-issued).

**Re-issue note.** The `v1.1.0-beta` tag was retired on 2026-11-12 at the
maintainer's request and its content was merged into this re-issue of
`v1.0.3-beta`. The re-issued engine contains everything listed in this entry
(UCI pondering, reliability work, release tooling) **plus** the named-only
opening-book reweight from ~73,242 qualifying CC0 Lichess games (1,269
named rows re-weighted; theory unchanged; the openings suite passes) and the
default-OFF experimental `NNUE` option (off the hot path; handcrafted
evaluator remains default). Strength is **not** improved: the search tree is
byte-identical to the 2026-11-11 line (bench 660,264 nodes), and every match
remains bullet-time; the retired 1.1.0-beta duel (+28 =13 −39, 43.1%) is
documented in `docs/TESTING.md` section 12.

This release ships a small number of **measured** changes and documents the
substantial experimental work that did not survive measurement. No Elo claim is
made.

### Engine

- **UCI pondering support (feature).** `position ... ponder <move>` sets up the
  predicted position, `go ponder` searches it, `ponderhit` converts the
  ongoing search to the normal clock budget without restarting it, and `stop`
  aborts it promptly when the prediction was wrong. Covered by
  `test/ponder-test.js`, also wired into `test/all` and CI.
- **UCI exit reliability (from 1.0.3-beta, re-verified).** Piped stdin closing
  mid-search no longer calls `std::terminate`.
- **movetime searches and ordinary clock-managed games** keep the exact
  1.0.3-beta budget behavior (a movetime search runs for its full movetime;
  the earlier candidate with a move-allocation soft-stop heuristic tested
  worse and was reverted). The clock budget was factored into one shared
  function (`clockBudget`) used by `go` and by the `ponderhit` conversion;
  hard/soft stop latches and the node budget are shared atomics so the
  running search picks up new limits without being restarted.
- Search hard/soft stop latches and the node budget are shared atomics, so
  `ponderhit` can re-arm them on the running search from the main thread.
- The 1.0.3-beta search/eval is otherwise unchanged (bench node count,
  WAC 250/300).

### Measurements and rejected experiments

- **Handcrafted evaluation: unchanged.** A Texel-tuning harness was built
  (`tunebench`, hidden diagnostic: coordinate descent on the evaluation
  parameters against a corpus of Stockfish-labelled positions). The tuned net
  lost by a wide margin in a colour-swapped duel (36.3%, −98 Elo, ±40 1σ over
  80 bullet games) and is **not shipped**.
- **Endgame opposition term** (distant opposition in pure pawn endings):
  measured against 1.0.3-beta at 41.3% (−61 Elo, ±39 1σ, n=80) and is **not
  shipped**.
- **Opening book expansion** from CC0 Lichess game statistics (121k games,
  204k positions; frequency-weighted named book + 119 added moves): reduced
  the Positional personality's median depth below the `test/openings` floor,
  and the expansion is **not shipped**; the 1.0.3-beta book is unchanged
  (5,580 positions / 8,134 moves).
- **NNUE prototype (experimental):** the training pipeline was substantially
  reworked (Stockfish-labelled 601k-position corpus, split train/validation/test
  by position hash; best-checkpoint export; new `--eval-file`,
  `--cpweight`, `label-positions.js`, `build-eval-dataset.js`,
  `build-opening-stats.js`, `merge-book.js` tooling in `tools/nnue/`).
  A 40-epoch run reaches validation MSE 0.016495 vs 0.016475 for a
  two-parameter material baseline, 63.1/63.3% decisive sign accuracy vs
  62.6% material — a wash, not an integration. The shipped FRNN1 remains the
  result-target 876-game net (best-checkpoint epoch 17, val MSE 0.213855,
  parity selftest 192/192). It is still experimental and still not integrated.
- **Strength evidence:** bullet duel vs 1.0.3-beta scored **+28 =13 −39,
  34.5/80 = 43.1%, −48 Elo (±39 1σ sampling, n=80; 95% CI ≈ −124 to +28,
  includes zero)** — the two binaries search an identical tree (bench 660,264
  for both; fixed-node probes gave identical bestmoves), so this is bullet-time
  noise on a heavily loaded machine, not a strength difference. Stockfish
  `UCI_Elo 2200` anchor remains ~2253 (unchanged engine core). Every match is
  60–100 ms/move bullet; no rating claim is made.
- **RubiChess could not be obtained** for testing (not downloadable from this
  environment; see docs/TESTING.md). Stockfish 17.1 serves as the external
  anchor.
- Syzygy tablebases are still not integrated (no local TB files to verify
  against; see docs/TESTING.md).

### Packaging

- UCI id `FroostRook 1.0.3 Beta`; package.json 1.0.3-beta; app.rc 1.0.3.0;
  portable generic x86-64 build is the default (`build.bat`, `build.bat native`
  for local CPU builds); CI builds portable only.
- Full test suite green (perft JS+native, rules, book, MultiPV, UCI smoke
  including ponder, openings, analyzer 62/62).


## 1.0.3-beta — original release (2026-11-11) [superseded by the 2026-11-12 re-issue]

Released: 2026-11-11. Tag: `v1.0.3-beta`.

### Search and speed

- Transposition table rebuilt: single 16-byte entries (full 64-bit key, packed
  payload), always-overwrite replacement with a depth-gated option
  (`-DKIWA_TT_DEPTH_PREF`), and a documented release/acquire publish protocol
  so multiple reader/writer threads cannot splice a payload.
- Multithreading fixed: Lazy SMP over one shared transposition table with a
  perturbed root order per helper. `Threads` now actually helps at depth 14
  (measured 2.1x wall time at 2 threads on the development laptop, 5.0x at
  4 threads) instead of duplicating the same old search and losing strength.
- **UCI exit reliability:** piped stdin closing while a search was in flight
  destroyed a joinable thread and called `std::terminate`; the shutdown now
  signals `abortFlag` and joins the search thread. Full UCI session verified
  (handshake, isready, go movetime/depth, Threads=2, quit, `d`, `eval`).
- Mate-distance pruning: positions already lost deeper than a mate in ply are
  cut immediately. Always on; affects only mate-distance lines.
- Aspiration/futility: quiet-move futility keeps the base margin and gains a
  wider margin at improving nodes. The previous "improving-based reverse
  futility" was measured to cost tactics and was reverted; reverse futility is
  back to its 1.0.2-beta rule (depth <= 2, margin 120 cp).
- Singular extensions, late-move pruning and razoring are implemented behind
  build switches (`KIWA_SINGULAR`, `KIWA_LMP`, `KIWA_RAZOR`, default 0) and
  are each gated by measurement; none ships enabled without evidence it gains
  strength.
- LMR history adjustment removed after A/B measurement (kept behind
  `KIWA_LMR_HISTORY`, default off). LMR never reduces below depth 0 now.
- Depth-12 bench visits ~660k nodes (vs 573,342 for 1.0.2-beta) with parity
  NPS on the same machine; the increase is discussed in docs/TESTING.md.
  WAC at a fixed 100k nodes: 250/300 (vs 248/300 for 1.0.2-beta).
- Bullet duel vs the 1.0.2-beta binary: 48.1% (+31 =15 −34, −13 ±39 1σ,
  n=80) — strength parity, not an Elo gain. Stockfish `UCI_Elo 2200`
  anchor (100 ms/move, book on, 20 paired openings): 57.5%, performance
  2253 (95% CI ≈ 2145–2361), consistent with this repository's earlier
  2180–2261 anchored band.

### NNUE prototype (not integrated)

- Trainer now exports the validation-optimal checkpoint instead of the final
  epoch (`bestCheckpointEpoch` recorded in metrics.json) and can read a
  larger `games.txt` corpus from `tools/nnue/dataset.js` via `--dataset`.
- The shipped FRNN1 net is retrained with these fixes; still not integrated
  and still worse than the material baseline on validation. See docs/NNUE.md.

### Packaging and identity

- UCI id is `FroostRook 1.0.3 Beta`; package.json 1.0.3-beta; app.rc
  1.0.3.0; executable icon unchanged (approved artwork).
- `native/build.bat` default is the portable generic x86-64 build; the
  previous `-march=native` behavior is kept behind `build.bat native`.
- CI builds the portable binary and packages it; release title is
  "FroostRook 1.0.3 Beta".
- The full source is in the repository; see docs/BUILD.md for build steps.

## 1.0.2-beta

See README.md "What changed in 1 Beta" and docs/TESTING.md (section 10).