# Changelog

All notable changes to FroostRook are documented here. The release tag for this
entry is `v1.0.3-beta`. Dates are ISO 8601 (UTC).

## 1.0.3-beta ("FroostRook 1.0.3 Beta")

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
