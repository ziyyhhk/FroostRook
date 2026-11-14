# Human-move prediction: data, priors, and the accuracy harness (Goal C groundwork)

> **2026-11-14 addendum (FroostRook 1.0.5 Beta).** The corpus was re-fetched
> at `max=300` per account and the pipeline re-run: **2,213 games / 147,558
> plies** (train 1,659 games / 109,304 plies; eval 554 games / 38,254 plies —
> the same deterministic FNV-1a split, so every old eval game id is still in
> eval, and the absolute split sizes changed). The retrained prior table has
> **50,693 positions / 52,760 rows** (from 19,977 / 20,737); eval-plies with a
> table hit went 9.6% → 11.0% (4,211). Held-out EVAL for the table+backoff
> predictor: top-1 **22.76%** (from 22.35% on the new split / 23.24% on the
> old split), top-3 **45.28%**, top-5 **56.01%**, log-loss **2.97**. The
> walls in sections 1–4 below describe the 2026-10-31 run (876 games / 231
> eval); its numbers are not directly comparable with the 1.0.5 measurements
> because the eval set itself grew 2.4x. The blend re-fit (`fit-predict.js`)
> wrote `{searchWeight:1.6, priorWeight:40, temperature:200}` (the old fit
> grid's temperature ceiling was raised; see `test/fit-predict.js`). Engine
> search is unchanged, so the engine-d4 and uniform baselines are re-run
> unchanged against the larger eval split.

This is the measurement half of the human-move work. It contains **no prediction model** —
it contains licensed data, a derived prior table, and a harness that can score any
predictor on a held-out split. `engine.js`, `uci.js`, `book.js` and `native/kiwa.cpp`
were **not** touched by this work.

```
test/fetch-human-games.js     download + parse CC0 Lichess games  -> test/data/human-games.json
test/train-priors.js          derive a position prior table        -> test/data/human-priors.json
test/predict-accuracy.js      score ANY predictor on the eval split
test/human-games/*.pgn        raw exports kept on disk (764 KB)
test/data/                    datasets + meta headers (~2.6 MB)
```

Run everything offline (no network) with:

```
node test/fetch-human-games.js --parse-only   # reads test/human-games/*.pgn
node test/train-priors.js
node test/predict-accuracy.js
```

---

## 1. Where the data comes from (and its licence)

| | |
|---|---|
| Source | `https://lichess.org/api/games/user/{username}` (public game export, no auth, no credentials) |
| Licence | **CC0 1.0** — https://database.lichess.org/: *"Database exports are released under the Creative Commons CC0 license. Use them for research, commercial purpose, publication, anything you like ... without asking for permission."* |
| Fetched | see `test/data/human-games.meta.json` → `fetchDate` (one HTTP request per account, 8 total, 5 s apart, `User-Agent: KiwaChess-training/1.0`) |
| Games kept | 876 complete games, 55,824 plies (avg 63.7 plies/game) |
| Dropped | 84 `From Position` + 1 `King of the Hill` (not Standard), 11 duplicate GameIds, 23 games with an empty move list (all `Termination "Abandoned"` before move 1 — no human moves to learn from). Nothing was silently truncated: a game that fails to parse is dropped whole. |

Accounts (rating band is what was **observed in the exported games**, not claimed titles):

| account | observed Elo band | role in the dataset |
|---|---|---|
| german11 | 1111–1376 | typical club/bullet amateur |
| aalex2025 | 1254–1470 | low amateur |
| Ayaan-07 | 1004–1603 | wide amateur band |
| challenger555 | 1593–1667 | mid club |
| Yansoon | 1542–1617 | mid club |
| khaire_Mourad | 1640–1730 | club |
| Bondar_Evgeniy | 1780–1884 | strong club |
| penguingm1 | 2186–2481 | titled master, modern sharp openings |

Honest limits of this pool: it is **Lichess blitz/bullet**, mostly amateurs, decided under
clock pressure; it includes whatever those eight players and their opponents played in a
recent window, so it is one slice of "human" and not a representative sample of classical
play. Opponent names are not tracked as sources of extra games — dedupe is by `GameId`.

Games started from a custom FEN are dropped because "ply 12" would not mean the same thing
there, and ply-indexed features (opening book, development) would be wrong.

## 2. Split (documented and reproducible)

`test/data/human-games.meta.json` → `split`:

```
FNV-1a hash32("kiwa-human-games-v1 " + gameId) mod 1000 < 250  ->  eval, else train
```

Split **by game**, never by ply, so two plies of the same game can never straddle the sets.
The full list of eval `GameId`s is written into the meta file (231 eval games / 15,666 plies;
645 train games / 40,158 plies). Regenerating the split is deterministic.

## 3. The prior table (`test/data/human-priors.json`)

Built from the **train split only**. Key = first three FEN fields (board, side, castling),
same scheme as `book.js`, so transpositions share an entry; en passant is excluded and every
stored move is re-verified legal with ep cleared, so a reader can never be handed an illegal
move. Rows are `[uci, count, featureCounts, bookBalancedWeight]`, restricted to ply ≤ 40.

Measured on the train split: 19,977 distinct positions, 20,737 move rows (only 74 positions
have a top move seen ≥ 5 times — the table is *sparse*, and a backoff is mandatory).

Feature marginals (`humanRate` = how often the move a human actually played has the feature,
`legalRate` = how often a random legal move in the same positions has it; `oddsRatio` is the
ratio a logistic model can consume directly):

| feature | human | legal | odds ratio |
|---|---|---|---|
| capture | 24.6% | 5.3% | 4.66 |
| castling | 3.8% | 0.64% | 5.90 |
| inBook (move is in Kiwa's opening book) | 11.9% | 3.2% | 3.76 |
| centralPawn | 14.8% | 5.1% | 2.92 |
| check | 4.5% | 2.0% | 2.29 |
| develop (minor leaves the back rank) | 19.8% | 11.7% | 1.69 |
| kingZone (lands in the 5×5 around the enemy king) | 40.7% | 35.5% | 1.15 |
| queenTrade | 2.4% | 2.0% | 1.20 |
| quiet | 71.6% | 94.1% | 0.76 |
| hanging (leaves the piece capturable by an equal/cheaper unit) | 15.7% | 22.5% | **0.70** |
| queenMove | 11.9% | 17.5% | 0.68 |
| recapture (captures on the square the opponent just landed on) | 9.8% | n/a (needs the previous ply) | — |

Eval-set coverage of this table (eval never used for fitting): **17.4%** of eval plies ≤ 40
land on a key present in the table, **14.1%** on the exact move. Coverage is concentrated in
the opening; a middlegame position from a 1600-bullet game is usually unique.

Naive baseline ("play the most frequent stored move", only where the table has an entry):
**746/1515 = 49.2%** top-1. That is an upper bound for what the table alone can do and it is
*conditional on coverage* — the harness reports the unconditional number instead.

## 4. The harness (`test/predict-accuracy.js`)

```
node test/predict-accuracy.js                                  # all three built-ins, full eval
node test/predict-accuracy.js --predictor ./my-model.js        # your model
node test/predict-accuracy.js --limit 1200                     # documented deterministic subset
node test/predict-accuracy.js --list --limit 50                # dump exactly which positions
```

Predictor contract (deliberately *not* `engine.predict`; nothing here imports or changes it):

```js
module.exports = {
  name: 'my-model',
  init(ctx) {},                          // optional, once
  predict(fen, legal, ctx) { ... },      // engine is sitting ON `fen` when called
};
// return  [uci,...]  or  [{move,prob},...]  or  {moves:[...], source:'table'|'backoff'}
// ctx = { key, ply, plyIndex, side:'white'|'black', gameId, game, legal, source }
```

Reported per predictor: top-1/3/5 with **Wilson 95% intervals**, coverage (and where each
prediction came from), mean log-loss against the uniform-over-legal floor, median rank of
the human move, 10-bin **ECE** of the top-1 probability vs the realised hit rate, and the
same rows split by ply band (1–16 / 17–64 / 65+) and by colour. It prints a warning that the
held-out set is small; with ~15.7k plies a top-1 difference has to clear roughly ±0.8 points
(Wilson) to be worth calling a difference at all, and per-band subsets are much noisier.

Subset rule when `--limit` is used (printed by the harness): sort all eval samples by
`hash32("kiwa-subset-v1|<gameId>|<ply>")` ascending and take the first N. Same input, same
positions, every run.

### Baselines (measured, not assumed)

Command: `node test/predict-accuracy.js --predictor builtin:uniform --predictor builtin:train-prior --predictor builtin:engine-d4`
Full eval split, **15,666 held-out plies from 231 games**, wall time 247 s (the depth-4
searches were 197 s of it; `engine.setInfoHandler(() => {})`, `engine.search({depth:4})`, and
`engine.predict()` was never called or modified). No subset was needed. Wilson 95% intervals:

| predictor | top-1 | top-3 | top-5 | mean log-loss (uniform floor 3.1938) | ECE |
|---|---|---|---|---|---|
| uniform over legal moves (sanity floor) | **8.45%** [8.02–8.89] | 18.69% [18.09–19.31] | 25.83% [25.15–26.52] | 3.1938 | 0.0193 |
| **engine move at depth 4** | **35.90%** [35.15–36.65] | 44.19% [43.42–44.97] | 48.58% [47.80–49.37] | 3.0678 | 0.0749 |
| **train-prior** (table + naive-Bayes backoff) | **23.24%** [22.59–23.91] | 45.59% [44.81–46.37] | 56.43% [55.66–57.21] | 2.9243 | 0.1578 |

Per ply band (top-1 / top-3 / top-5):

| band | n | engine-d4 | train-prior |
|---|---|---|---|
| opening, ply 1–16 | 3,587 | 25.82% [24.41–27.27] / 31.17 / 33.40 | **28.91%** [27.45–30.42] / **55.31** / **67.80** |
| middlegame, ply 17–64 | 8,856 | **37.64%** [36.63–38.65] / 44.75 / 48.60 | 20.14% [19.32–20.99] / 39.75 / 49.74 |
| endgame, ply 65+ | 3,223 | **42.35%** [40.66–44.07] / 57.15 / 65.44 | 25.44% [23.97–26.97] / 50.82 / 62.18 |

By colour, top-1: engine 35.06% White / 36.75% Black; prior 23.60% White / 22.88% Black.
Where the prior table actually had the position (1,515 of 15,666 eval plies; 9.7% overall,
42.2% of the opening band), its own most-frequent-stored-move pick hit **49.2%**.

Three things this measurement says out loud:

1. **In the opening, memorised human theory beats depth-4 search**, and the gap clears the
   interval: 28.91% [27.45–30.42] vs 25.82% [24.41–27.27] top-1, and the prior's top-5 is
   67.8% against the engine's 33.4% (n = 3,587). Outside the opening the engine wins
   comfortably. Neither predictor is good alone, which is the argument for the blend.
2. **Calibration is currently fiction.** Uniform is "well calibrated" (ECE 0.019) because it
   makes no claim. The prior's ECE of 0.158 is over-confidence: in the 0.3–0.4 bin it
   predicts 35% and hits 20.7%. The engine baseline's 0.075 is meaningless in the other
   direction — its probabilities are a hand-set geometric shape, not a model, which is why
   its opening log-loss (3.589) is *worse* than uniform (3.368). Today's `predict()`
   `temperature: 30` has never been measured against anything; ECE is the number to drive down.
3. **Coverage is the binding constraint on the table approach**: 17.4% of eval plies ≤ 40
   (9.7% of all eval plies) hit a stored key. A feature-based / fitted model that can still
   speak in unseen positions is required, not just a bigger lookup.

## 5. Integrating into `engine.js predict()` later

Current state of `engine.js`: `openingBonus()` is a hand-written switch over ~12 board
patterns with hard-coded square constants, and `movePrior()` adds flat +5 capture / +8
castling / +6 check; the blend is `score + prior * priorScale` with a fixed `temperature = 30`.

Concrete, measured steps:

1. **Replace `openingBonus()` with the table.** `human-priors.json` is keyed exactly like
   `book.js`, so a look-up is a string join on the FEN. Restrict to ply ≤ 40 (the table's
   range) and fall back to the current behaviour past it.
2. **Turn features into weights.** The `oddsRatio` column already gives a sane starting
   point for `movePrior()`'s constants; the right next step is a logistic fit on the train
   split (`train-priors.js` writes everything a fit needs: per-move feature counts and the
   legal-move marginals). Fit on train, then measure — do not tune on eval.
3. **Keep the book signal.** `inBook` (OR 3.8) is the strongest cheap non-table feature and
   the engine already has the book loaded.
4. **Calibrate the temperature.** Log-loss and ECE from this harness are the acceptance test;
   today's fixed `temperature: 30` has never been measured against a real distribution.
5. **Report the number.** `test/predict.js` (two 19th-century games) can stay as a smoke
   test, but accuracy claims must come from `predict-accuracy.js` output on this eval split,
   with the interval, or from a larger eval set.

Until 1–5 are done and re-measured, the honest statement is: the engine's own top-1 human
accuracy on ~15.7k held-out modern plies is the number printed above, and nothing about the
existing hand-written opening bonus has been shown to beat it.
