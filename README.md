# KiwaChess 2.2.0

<img src="assets/kiwa.png" alt="KiwaChess" width="220" align="right">

[![build](https://github.com/ziyyhhk/kiwa-engine/actions/workflows/build.yml/badge.svg)](https://github.com/ziyyhhk/kiwa-engine/actions/workflows/build.yml)

KiwaChess is a chess engine built from scratch: a C++17 search core (0x88
board, alpha-beta with a transposition table, hand-made evaluation) behind a
standard UCI interface. Version 2.2.0 embeds a 5,580-position opening book,
exposes real engine settings — Threads, Hash, OwnBook, Book Depth, Book Variety,
Move Overhead — and implements the rules that decide a game: checkmate,
stalemate, castling through check, en passant, underpromotion, threefold
repetition, the fifty-move rule and insufficient material. A JavaScript
front-end and a human-move predictor ship alongside it.

Prebuilt Windows binaries are on the
[Releases page](https://github.com/ziyyhhk/kiwa-engine/releases); every push also
builds one in GitHub Actions.

It is a real engine, not a wrapper around Stockfish. It is also not Stockfish —
more on that at the bottom.

## Quick start

Download `KiwaChess.exe` from [Releases](https://github.com/ziyyhhk/kiwa-engine/releases)
and import it directly into any UCI GUI (Cute Chess, Arena, BanksiaGUI, Lucas
Chess, Chessbase). It is portable, needs no Node, and carries the opening book
inside the binary.

The Node front-end additionally provides `predict` and terminal play. It needs
Node 18 or newer. Place the release binary at `native/kiwa-native.exe` (the name
`native.js` looks for), or compile it yourself:

```bash
native\build.bat       # MSYS2 UCRT64 GCC; local build is tuned for this CPU
node uci.js            # UCI engine + prediction
node play.js           # terminal, you are White
node play.js black     # terminal, you are Black
```

On Windows, `kiwa.bat` does the same as `node uci.js` for GUIs that want a
double-clickable executable. All commands must run from this folder (the
front-end locates `book.js` and `native/` relative to its own path).

In terminal play mode, type moves in UCI notation (`e2e4`, `e7e8q` for
promotion). Commands: `hint`, `predict`, `moves`, `undo`, `new`, `depth N`,
`quit`. After each reply Kiwa prints its top three guesses for your next move.

## What changed in 2.2.0

| Change | Evidence |
|---|---|
| Real engine settings in both cores | `Threads` (1–8), `Hash` (1–512 MB), `OwnBook`, `Book Depth` (0–60 plies), `Book Variety` (0–100), `Move Overhead`, `Clear Hash`; the UCI smoke test asserts every option is advertised |
| Opening book embedded in the native exe | 5,580 positions / 8,193 replies, generated from 3,865 lichess named lines plus 10 curated gambit/trap lines. A GUI importing only `KiwaChess.exe` now gets book moves |
| Genuine opening variety | 12 startpos games at Book Variety 100 produced 9 distinct first moves (`c4`, `f3`, `b4`, `Nf3`, `e4`, `f4`, `Nc3`, `a3`, `h4`); Book Variety 0 always returns the main move `e4` |
| No book blunders into mate | generation filters any move that allows mate in one; two named-line blunders were removed |
| Real `Threads` search | N independent searches with private TT slices; `stop` was verified at 1, 2 and 4 threads. Default stays 1 because this 2-core CPU gets slower with helpers (see Benchmarks) |
| Rules completed | insufficient material and root draw scoring (threefold, fifty-move, dead material); perft suite extended with explicit en passant, castling and underpromotion positions: 39 checks pass |
| Name and release | engine id `KiwaChess 2.2.0`; GitHub release `KiwaChess 2.2.0` with `KiwaChess.exe` |

The search and evaluation are otherwise the same engine as 2.0.1. The last
measured Elo is therefore still the 24-game result below; 2.2.0 has not been
re-rated.

## Engine settings

| Option | Default | Range | Applies to |
|---|---|---|---|
| `Threads` | 1 | 1–8 | Native core. Each helper runs an independent search with its own slice of the hash table |
| `Hash` | 64 MB | 1–512 | Native core; the JavaScript fallback keeps a fixed table |
| `OwnBook` | true | true/false | Both. Disable to force a search from move one |
| `Book Depth` | 24 plies | 0–60 | Both. Set 0 to disable the book as well |
| `Book Variety` | 100 | 0–100 | Both. 0 = most popular continuation only; 100 = every named reply, weighted |
| `Move Overhead` | 30 ms | 0–1000 | Native clock management: latency never spent |
| `Clear Hash` | — | button | Both |

The native engine advertises these itself, so a GUI shows a populated Engine
Settings panel without the Node wrapper. With `Threads` above 1, the advertised
`Hash` is split into equal private slices; there is no shared-table Lazy SMP.

## Rules coverage

Move generation and result handling are exercised by `test/rules.js` and by the
perft suites.

- **Moves**: castling rights, castling out of/through/into check, en passant
  (including the discovered-check cases covered by perft), promotion and
  underpromotion.
- **Results**: checkmate and stalemate; threefold repetition; fifty-move rule;
  insufficient material (K vs K, K+minor vs K, and any position with only
  bishops that all stand on one colour). A drawn root position is scored 0 and
  still returns a legal move; checkmate and stalemate take precedence.
- **Verification**: 39 perft checks — the six standard positions plus explicit
  en passant (750,449 nodes at depth 4), castling-rights (314,346) and
  underpromotion (16,036 at depth 5) positions, with counts cross-checked
  against Stockfish.

This is not a full FIDE arbiter. Dead positions caused by blocked pawn
structures are not proven automatically, and the automatic 75-move/fivefold
rules are subsumed by the engine's earlier 50-move/threefold draw scoring. It
does not use endgame tablebases.

## Opening book

`book.js` is generated by `test/gen-book.js` from the
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
database (CC0) plus `book-data/traps.tsv`: 3,875 named lines, 5,580 positions,
8,193 replies.

- Keyed by board, side to move and castling rights, so transpositions share an
  entry and are recognised regardless of move order.
- Weights are the square root of how many named lines play a move, so main lines
  dominate but rare gambits still appear. Replies are drawn randomly by weight,
  and `Book Variety` controls how far down the frequency list the book may go.
- The curated traps include the Blackburne Shilling, Stafford, Fried Liver,
  Halloween, Légal, Englund, Latvian, Elephant and Scandinavian gambits. Some
  are objectively dubious — they are practical tricks, and at Book Variety 100
  Kiwa will sometimes try them. Set `Book Variety` low or `OwnBook` false for
  serious play.
- The native exe carries the same book compiled to `native/book_data.h` by
  `test/gen-native-book.js`; the Node front-end reads `book.js`. The search
  never consults the book, so WAC and perft are unaffected.
- The book is consulted for the first 24 plies by default, only in games that
  started from the initial position, and never for explicit depth/node-limited
  analysis searches.

Validate every stored move and rebuild after editing `book-data/*.tsv`:

```bash
node test/gen-book.js
node test/book-check.js
node test/gen-native-book.js
```

## Play it against something

**Any UCI GUI — Cute Chess, Arena, BanksiaGUI, Lucas Chess, Chessbase:**
add an engine and point it at `KiwaChess.exe` (release download). For the Node
front-end use `kiwa.bat` or `node uci.js` with this folder as the working
directory.

There are three valid engine files:

- `KiwaChess.exe` — portable release build, complete UCI engine with the
  embedded book. No Node required. This is the file attached to the GitHub
  release.
- `native/kiwa-native.exe` — the same binary under the name the Node bridge
  expects. Full UCI engine; the embedded book also works when imported
  directly.
- `kiwa.bat` / `node uci.js` — the Node front-end. It adds `predict`, uses
  `book.js`, and forwards settings to the native core.

**Lichess — officially supported, but as a bot account.** Lichess has no
"upload an engine" button and the web analysis board cannot load a local
engine. What works is their bot API. A ready setup lives in `../lichess-bot/`
(dependencies installed in its own `.venv`; `config.yml` already points at
Kiwa):

1. Create a normal Lichess account, e.g. `KiwaChess`.
2. Go to <https://lichess.org/account/oauth/token>, create a token and tick
   **Play games with the bot API (`bot:play`)**. Copy it.
3. Paste the token into `../lichess-bot/config.yml` (or set the
   `LICHESS_BOT_TOKEN` environment variable instead of storing it in the file).
4. Run `../lichess-bot/upgrade-to-bot.bat` **once**. This converts the account
   to a bot account through Lichess and is irreversible.
5. Run `../lichess-bot/start-kiwa-bot.bat` and leave the window open. KiwaChess
   appears at `lichess.org/@/YourBotName`, accepts challenges, and after about
   five idle minutes starts challenging other bots itself.
6. Upload `assets/kiwa.png` as the profile picture on the Lichess account page —
   that is where an engine's avatar lives, since UCI has no such field.

Notes: bots cannot play rated games against humans (only unrated), bot-vs-bot
play is capped at 100 games/day, and the bot is offline whenever this computer
is asleep or the window is closed. `ponder: false` is deliberate — Kiwa starts
searching only when it receives `go`; it does not ponder on the opponent's clock.

**chess.com — no.** There is no API for third-party engines, and joining games
with a script violates their terms. Do not try to bridge the board; accounts get
closed.

**Chessify / Chess Compass — no custom engines.** They are cloud analysis
platforms running their own Stockfish builds. There is no import path for a
local UCI engine.

## Measured strength (fast TC)

`test/elo.js` plays the native exe against Stockfish 19 with
`UCI_LimitStrength` / `UCI_Elo`, both at 100 ms/move, alternating colours on
paired openings. 24 games (16 at anchor 2100, 8 at 2000) scored 13/24 (54.2%), a
joint maximum-likelihood estimate of **2096 Elo ± 72** (1σ sampling) on
Stockfish's limited-strength scale. At the 2100 anchor itself: 8/16 = 50%,
performance 2100. All 24 games were decisive.

Read that as "roughly a 2100 engine at 100 ms/move against this calibration",
not an official rating. The ±72 covers sampling noise only: Stockfish's
`UCI_Elo` scale is itself approximate, 100 ms/move is far faster than CCRL's
40/15, and human Lichess ratings are a different pool. The native core solves
237–242/300 WAC positions at 300 ms/move and 257/300 at 1 s/move, so it should
gain some strength at longer time controls; that has not been measured. The rating
match predates 2.2.0; book, settings and draw handling changed, the search did
not.

## Benchmarks

All numbers from this machine: Node 24 front-end, native core built with GCC
16.2 `-O3 -march=native` unless stated.

| Test | Result |
|---|---|
| Perft suite, native (6 standard + 3 special positions) | 39/39 checks pass, including startpos d5 = 4,865,609 |
| Perft suite, JavaScript fallback | same counts, all pass |
| Search speed, native | depth 12 in 0.34–0.49 s, 652,503 nodes, 1.3–2.0 M nodes/s (CPU-clock variance) |
| Search speed, JavaScript fallback | depth 12 in 1.28 s, 660,775 nodes, ~0.52 M nodes/s |
| WAC tactical suite, native, 1 s/move | 257/300 (85.7%) on 2026-10-31 |
| WAC tactical suite, native, 300 ms/move | 237/300 (79.0%) and 242/300 (80.7%) in two runs on 2026-10-31 |
| WAC tactical suite, JavaScript, 300 ms/move | 233/300 (77.7%) |
| Threads, fixed depth 14 on a 2-core/4-thread i3-5005U | 1 thread 1.79 s; 2 threads 3.1–3.5 s; 4 threads 3.2 s; 8 threads 8.2 s. Extra threads duplicate work and split the hash; default is 1 |
| UCI `stop` | answered at 1, 2 and 4 threads during a 1.2 s infinite search; bestmove arrived roughly 0.1–0.3 s after `stop` |
| Native vs JS head-to-head | native 8/10 at 100 ms/move (+8 =0 −2, alternating colours; small sample) |
| Anchored Elo, native vs Stockfish 19 (`UCI_Elo`), 100 ms/move | 24 games: 13/24 (0 draws), joint estimate 2096 ± 72 (1σ sampling); 8/16 at anchor 2100 |
| Opening book validation | 5,580 positions, 8,193 moves, 0 illegal, 0 named openings missing |
| Opening variety smoke test | 9 distinct first moves in 12 games at Book Variety 100; `e2e4` at Book Variety 0 |
| UCI smoke test (native path) | handshake, all 7 options, 2-thread search, book variety, mate-in-one pass |
| Rules suite | checkmate, stalemate, en passant, castling through check, underpromotion, threefold, fifty-move, insufficient material; native draw scores 0 |
| vs random mover, 50 ms/move (JS 1.x) | 6/6 wins |
| vs greedy material bot, 100 ms/move (JS 1.x) | 6/6 wins |

WAC (Win at Chess) is 300 tactical positions with a known best move. 237–242/300
at 300 ms and 257/300 at 1 s is club-level tactics; it is **not** an Elo rating,
and short runs move by a few positions with CPU clock noise.

```bash
node test/perft.js
node test/perft-native.js
node test/rules.js
node test/bench.js
node test/wac.js 300 300
node test/wac-native.js 300 300
node test/match-native.js 100 10
node test/elo.js --anchor 2100 --ms 100 --pairs 8 --stockfish /path/to/stockfish
node test/uci-smoke.js
node test/book-check.js
node test/stop-test.js
native/kiwa-native.exe bench          # depth-12 speed probe
native/kiwa-native.exe perft 5        # bare perft, no Node
```

## Human-move prediction

`predict` ranks every legal move by a blend of depth-5 search score and priors
for what humans actually play — opening frequencies, captures, checks, castling,
development. Scores become probabilities through a softmax.

Measured on two real games, every ply a target (both sides human):

| Game | Top-1 | Top-3 |
|---|---|---|
| Morphy, Opera Game (1858), 33 plies | 21/33 (63.6%) | 26/33 (78.8%) |
| Anderssen–Kieseritzky, Immortal Game (1851), 45 plies | 24/45 (53.3%) | 31/45 (68.9%) |
| Combined, 78 human moves | 45/78 (57.7%) | 57/78 (73.1%) |

That is the honest number: it is a human-move model, not mind-reading. It misses
sacrifices and unusual plans, which is most of why the Immortal Game scores lower
than the Opera Game.

```bash
node test/predict.js 5 30 1    # depth 5, temperature 30, prior scale 1
```

## What changed in 2.0.1 and earlier

<details>
<summary>2.0.1</summary>

| Change | Evidence |
|---|---|
| Real UCI options | `Hash`, `Clear Hash`, `Move Overhead`; some GUIs reject an engine that advertises no options at all |
| Dynamically sized TT | default 64 MB; `Hash` accepts 1–512 MB |
| Time management honours overhead | `Move Overhead` (default 30 ms) subtracted from usable clock |
| Perft unchanged | 26/26 checks passed with the resized TT |

</details>

<details>
<summary>2.0 and 1.x</summary>

- **2.0**: C++17 port of the JavaScript engine, ~3–4× faster; real UCI `stop`
  on a worker thread; book through move 20; Node ↔ native bridge with automatic
  fallback; same perft and mate decisions in both cores.
- **1.3**: pawn-structure hash and extras cache, log-based LMR table, clock-aware
  time management.
- **1.2**: renamed to Kiwa, first named opening book (3,865 lines), aspiration
  windows.

Futility pruning and late-move pruning were tried in 1.3 and **rejected**: they
saved nodes but cost tactical accuracy on WAC (223–219 vs 233/300).

</details>

## How it works

The search and evaluation live in `native/kiwa.cpp`; `engine.js` is the same
engine in JavaScript and is used as a fallback, by `play.js`, and by the test
helpers that need to parse SAN. `native.js` keeps one native process alive and
speaks UCI to it; the Node front-end never touches the native internals.

- **Board**: 0x88 array, Zobrist hashing, incremental material/PST scores.
- **Evaluation**: pawn-structure hash (doubled, isolated, passed), an extras
  cache for the remaining terms, tapered midgame/endgame piece-square tables,
  bishop pair, rooks on open/semi-open files and on the seventh, king pawn
  shield, tempo.
- **Search**: iterative deepening with aspiration windows, principal variation
  search, transposition table, null-move pruning, log-table late move
  reductions, check extensions, quiescence search with delta pruning, killer
  moves, countermoves, history heuristic with aging, reverse futility pruning,
  mate-distance-safe scoring.
- **Threads**: the coordinator starts N independent searches, each with its own
  board, search stacks and TT slice; helpers jitter their root ordering. The
  best result is chosen by mate status, then depth/score/nodes. No shared TT.
- **Time management**: clock budget, stability exit, iteration-skip estimate,
  and a hard cap at 1.5× the soft budget so `bestmove` beats the flag.
- **Book**: embedded in the native exe and mirrored in `book.js` for the Node
  path. Weighted, FEN-keyed, outside the search.
- **Prediction**: depth-5 search of every legal move, blended with human priors.

Files:

```
native/kiwa.cpp          C++17 board, movegen, eval, search, UCI loop
native/book_data.h       generated embedded book (do not edit)
native/kiwa-native.exe   local build (rebuild with native/build.bat)
native/build.bat         one-command GCC build (MSYS2 UCRT64)
native.js                Node ↔ native UCI bridge, with automatic fallback
engine.js                the same engine in JavaScript (fallback, play.js, tests)
uci.js                   UCI front-end: book, prediction, native or JS search
play.js                  terminal play mode (JavaScript engine)
book.js                  generated opening book — do not edit by hand
book-data/               lichess chess-openings TSVs (a–e) + traps.tsv
kiwa.bat                 Windows launcher for GUIs
assets/kiwa.png          the avatar used in this README / on Lichess
test/perft.js            JS move generation verification
test/perft-native.js     native move generation verification (spawns the exe)
test/rules.js            checkmate/stalemate/draw/EP/castling/promotion tests
test/stop-test.js         stop and quit behaviour at 1/2/4 threads
test/bench.js            speed, mate tests, baseline matches
test/wac.js              tactical benchmark, JS engine
test/wac-native.js       tactical benchmark, native engine
test/match-native.js     native vs JS at equal time, alternating colours
test/elo.js              anchored Elo match vs Stockfish UCI_LimitStrength
test/predict.js          human-move prediction accuracy
test/gen-book.js         builds book.js from book-data/
test/gen-native-book.js  builds native/book_data.h from book.js
test/book-check.js       validates every book entry against the engine
test/uci-smoke.js        speaks UCI to a real process (options, book, search)
wacnew.epd               Win at Chess suite (from the Arasan repo)
```

## What this is not, and what it would take

Stockfish is roughly 3700 Elo: NNUE evaluation over billions of trained
positions, SIMD-optimised C++, years of tuning. AlphaZero needed thousands of
TPUs and millions of self-play games. KiwaChess is a handcrafted engine — a C++
port of a JavaScript engine — with a named-opening database, not a neural
network.

Honest gaps:

- **Speed**: ~2 M nodes/s here vs tens of millions for Stockfish.
- **Evaluation**: handcrafted terms vs a trained neural network.
- **Tuning**: no SPSA or large-scale self-play tuning; changes are measured on
  WAC and short matches, which have real noise.
- **Testing**: one 24-game anchored match against strength-limited Stockfish;
  no CCRL/gauntlet rating and no games against full-strength engines.
- **Book**: opening theory only, 24 plies by default. It includes deliberately
  tricky gambits, not "every line ever played", and it does not know endgame
  tablebases.
- **Rules**: standard game-ending rules are implemented; exotic dead positions
  that require a proof are not.
- **Prediction**: tuned on two 19th-century games; a modern-game set would be a
  better test.

The C++ port is done. The realistic path from here, in order of payoff: replace
the handcrafted evaluation with an NNUE trained on public data, add a shared-TT
multithreaded search and Syzygy, tune parameters with SPSA/self-play, then run
gauntlets on CCRL to get an actual rating. The top single-author engines sit
roughly 100 Elo behind Stockfish after years of that work.

## Known limitations

- `Threads` above 1 does not speed up this 2-core/hyperthreaded CPU at fixed
  depth; helpers duplicate work and split the hash. On a machine with more
  physical cores it can help. Default is 1.
- The native core answers `stop` properly at every thread count. The JavaScript
  fallback is synchronous: no `stop`, and `go infinite` is capped at 20 seconds
  there.
- There is no pondering and no Syzygy/tablebase support.
- The prebuilt `native/kiwa-native.exe` from `build.bat` is compiled with
  `-march=native`. The release `KiwaChess.exe` is generic x86-64; rebuild with
  `native\build.bat` if you move a local build to a different CPU.
- `Hash` and `Threads` affect the native core only. The JavaScript fallback
  keeps a fixed-size table and searches single-threaded.
- The book is only consulted in games that started from the initial position,
  for `Book Depth` plies (default 24), and never for explicit depth- or
  node-limited analysis searches.
- The embedded book is generated at build time. After editing `book-data/`, run
  both generators and rebuild the exe or the native book will be stale.

## Test suite source

WAC positions: [jdart1/arasan-chess `tests/wacnew.epd`](https://github.com/jdart1/arasan-chess/blob/master/tests/wacnew.epd).
Opening data: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0).
Spellings, traps and any errors in `book-data/traps.tsv` are this project's.
