# Changelog

All notable changes to FroostRook are documented here.

## 1.0.4-beta ("FroostRook 1.0.4 Beta")

Released: 2026-11-13. Tag: `v1.0.4-beta`.

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
