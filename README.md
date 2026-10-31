# KiwaChess 2.3.0

<img src="assets/kiwa.png" alt="KiwaChess" width="220" align="right">

[![build](https://github.com/ziyyhhk/kiwa-engine/actions/workflows/build.yml/badge.svg)](https://github.com/ziyyhhk/kiwa-engine/actions/workflows/build.yml)

KiwaChess is a chess engine built from scratch: a C++17 search core (0x88
board, alpha-beta with a transposition table, hand-made evaluation) behind a
standard UCI interface. Version 2.3.0 adds a positional evaluation (measured per node: WAC 216→223 at 100k
nodes, for 20-40% of the search speed, and so far inside the noise of a 100-game
duel in results), seven opening personalities with anti-repetition memory, and a
human-move predictor trained on 876 modern CC0 games. The rules that decide a game —
checkmate, stalemate, castling through check, en passant, underpromotion,
threefold repetition, the fifty-move rule and insufficient material — are
implemented and tested, and a JavaScript front-end and fallback ship alongside.

Prebuilt Windows binaries are on the
[Releases page](https://github.com/ziyyhhk/kiwa-engine/releases); every push also
builds one in GitHub Actions.

It is a real engine, not a wrapper around Stockfish. It is also not Stockfish —
more on that at the bottom.

## What's new in 2.3.0

| Area | What changed | Measured |
|---|---|---|
| Evaluation | Positional terms added to the native core: pawn structure (doubled, isolated, backward, connected and passed pawns with king distance), knight and bishop outposts, bishop pair and bad bishops, rook activity on open/semi-open files and the seventh with connected rooks, king pawn shield, and ray-scan mobility that ignores squares covered by an enemy pawn. Tapered, cached, switchable (`KIWA_EXTRAS`, `KIWA_MOB`) | Measured per node, **not** yet measured in results: at an equal node budget WAC went 216→223 (100k) and 235→241 (200k); the cost is 20–40% of nodes/s; the paired duels against 2.2.0 land between −28 ± 35 and +140 ± 49, i.e. **no significant strength gain is established** at 100 ms/move. Details and all five numbers in [Measured strength](#measured-strength-fast-time-control) |
| Correctness | Repetition and the fifty-move rule now follow FIDE position identity (side to move, castling rights, and an en-passant square only when the capture is actually legal); quiescence scores mate distance only when in check with no evasions; the root distinguishes checkmate from stalemate; mate scores are normalised through the transposition table | 27 rule assertions in `test/rules.js`, including "one cycle is not a threefold draw", "castling rights split identical positions" and "a pinned ep pawn is not a legal ep"; 39/39 perft |
| Search | Static exchange evaluation (swap list with x-rays) for capture ordering and quiescence pruning, history malus on quiet moves that fail high, late reductions on losing captures, root continuity for faster cutoffs | correctness and nodes saved, not a proven rating rise: disabling the SEE prune scored 25.5/60 (−53 ± 45) in one 60-game duel, but see Measured strength for why these intervals are wider than the differences |
| Openings | Seven personalities (Balanced, Mainline, Aggressive, Positional, Solid, Gambit, Surprise), each with its own weight column per move; session memory that avoids repeating lines, per-colour and transposition-aware; `Random Seed` for reproducibility; a shallow search check that vetoes clearly bad book moves | 210 book games (30 per personality, 6 plies each): 13–26 distinct six-ply lines per style out of the games that reached six plies, every line legal, and no 6-ply line further than 230 cp in static evaluation |
| Prediction | The hand-written opening table was replaced by a prior learned from 876 modern Lichess games (CC0, 55,824 plies): a position-count table with a 12-feature naive-Bayes backoff, blended with the search score and fitted on training positions with leave-one-out | held-out modern games: **39.3% top-1, 66.8% top-3, 76.1% top-5**, ECE 0.085 — against 36.0/44.7/49.3 for search alone |
| Threading | `Threads` 1–8 measured, fresh process per run, three workloads; default stays 1 | on this 2-core CPU 2 T is 0.61–0.83× the speed of 1 T, 4 T is 0.52–0.66×, 8 T is 0.22–0.33×. More threads are not faster here |

Everything in 2.2.0 still works: same UCI handshake, same options (plus four new
ones), same JavaScript fallback, same embedded book.

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
front-end locates `book.js`, `data/` and `native/` relative to its own path).

In terminal play mode, type moves in UCI notation (`e2e4`, `e7e8q` for
promotion). Commands: `hint`, `predict`, `moves`, `undo`, `new`, `depth N`,
`quit`. After each reply Kiwa prints its top three guesses for your next move.

## Engine settings

| Option | Default | Range | Applies to |
|---|---|---|---|
| `Threads` | 1 | 1–8 | Native core. Each helper runs an independent search with its own slice of the hash table |
| `Hash` | 64 MB | 1–512 | Native core; the JavaScript fallback keeps a fixed table |
| `OwnBook` | true | true/false | Both. Disable to force a search from move one |
| `Book Depth` | 24 plies | 0–60 | Both. Set 0 to disable the book as well |
| `Book Variety` | 100 | 0–100 | Both. 0 = most popular continuation only; 100 = every named reply, weighted |
| `Book Style` | Balanced | combo | Both. `Balanced`, `Mainline`, `Aggressive`, `Positional`, `Solid`, `Gambit`, `Surprise` — the repertoire a personality picks from |
| `Opening Diversity` | 50 | 0–100 | Both. How hard recent lines are pushed aside across games in this process |
| `Random Seed` | 0 | 0–2147483647 | Both. 0 = derive from the clock; any other value replays the same repertoire |
| `Clear Book Memory` | — | button | Both. Forgets the lines played so far in this session |
| `Move Overhead` | 30 ms | 0–1000 | Native clock management: latency never spent |
| `Clear Hash` | — | button | Both |

The native engine advertises these itself, so a GUI shows a populated Engine
Settings panel without the Node wrapper. With `Threads` above 1, the advertised
`Hash` is split into equal private slices; there is no shared-table Lazy SMP.

Two diagnostic commands exist on both front-ends and are never emitted during a
search: `eval` prints the tapered score, and `bookmemory` prints the session's
opening memory (per-colour counters plus the count stored for the position on
the board, which is how the transposition handling is tested).


## Rules coverage

Move generation and result handling are exercised by `test/rules.js` and by the
perft suites.

- **Moves**: castling rights, castling out of/through/into check, en passant
  (including the discovered-check cases covered by perft), promotion and
  underpromotion.
- **Position identity** follows FIDE, not the printed FEN. Two positions are the
  same position only if the side to move, the castling rights and the *possibility*
  of an en-passant capture agree. An `ep` field in the FEN that no legal capture
  can use no longer splits the position, and the Zobrist key for it is only
  applied when the capture is actually available (including the case where
  capturing would expose the mover's own king).
- **Repetition**: a cycle inside the search scores 0 (two occurrences) while the
  game-level claim needs three; both are tested separately, so "the position
  repeated once" is no longer reported as a drawn result and a real threefold is.
- **Results**: checkmate and stalemate; threefold repetition; fifty-move rule;
  insufficient material (K vs K, K+minor vs K, and any position with only bishops
  that all stand on one colour). A drawn root position is scored 0 and still
  returns a legal move; checkmate and stalemate take precedence and are scored
  differently from each other (`0000` with a mate score vs `0000` with cp 0).
- **Mate distance**: quiescence returns `-MATE + ply` only when the side to move
  is in check and has no legal evasion; a quiet stalemate in quiescence scores 0.
  Mate scores are re-distanced whenever they cross the transposition table.
- **Verification**: 39 perft checks — the six standard positions plus explicit
  en passant (750,449 nodes at depth 4), castling-rights (314,346) and
  underpromotion (16,036 at depth 5) positions, with counts cross-checked
  against Stockfish.

This is not a full FIDE arbiter. Dead positions caused by blocked pawn
structures are not proven automatically, and the automatic 75-move/fivefold
rules are subsumed by the engine's earlier 50-move/threefold draw scoring. It
does not use endgame tablebases.

## Evaluation

The native evaluation is handcrafted and tapered: material and piece-square
tables in midgame/endgame pairs, interpolated by a game phase from the remaining
force. On top of that it now carries a block of positional terms, cached behind
the existing pawn-structure hash and an extras cache keyed on the full position:

| Term | What it measures |
|---|---|
| Pawn structure | doubled, isolated, backward; connected passers; passed-pawn rank plus the chebyshev distance of the enemy king to the promotion square (endgame-weighted) |
| Mobility | pseudo-legal destination squares per piece, excluding squares an enemy pawn covers, per piece type in midgame and endgame |
| Outposts | knight or bishop on the 4th–6th rank, pawn-defended, not attackable by an enemy pawn now or after a pawn push |
| Bishops | pair bonus, and a penalty proportional to own pawns fixed on the bishop's own colour |
| Rooks | open and semi-open files, seventh rank, connected on the same rank with nothing between |
| King safety | pawn shield on and one rank in front of the king, midgame only |

Every term was measured before it was kept, and the measurements are collected in
[Measured strength](#measured-strength-fast-time-control) with their intervals —
none of them significant on its own, so what follows is direction, not size. The
positional block without mobility drew with 2.2.0; adding ray-scan mobility moved
the same comparison up, and giving it to rooks and queens as well as knights and
bishops gained nothing further in a head-to-head while costing 11% more of the
nodes per move, which is why the release stops at knights and bishops. The
static-exchange prune appears to matter more than the whole positional block:
switching it off moved the measurement from clearly positive to clearly negative.
No term is a constant bonus for owning a square class, and the phase
interpolation is the existing one, so nothing is counted twice at one end of the
game and again at the other.

The JavaScript fallback keeps the pre-2.3.0 evaluation (material, PST, the
pawn-structure hash and its older extras). It is a fallback for when the native
binary is missing, and its strength is lower than the native core's; `node
test/match-native.js` measures the gap.


## Opening book and personalities

`book.js` is generated by `test/gen-book.js` from the
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
database (CC0) plus `book-data/traps.tsv`: 3,879 named lines, 5,580 positions,
8,134 replies. The native exe carries the same table compiled into
`native/book_data.h` by `test/gen-native-book.js`, so a GUI that imports only
`KiwaChess.exe` gets identical behaviour.

Each stored move carries **seven weights** — `[uci, balanced, mainline,
aggressive, gambit, solid, surprise, positional]` — and `Book Style` selects the
column. A personality that has nothing in a position falls back to the balanced
column, so the book can never stall. The columns are derived from the family and
name of every line (Sicilian/King's Indian/Trompowsky families read as
aggressive; Caro-Kann/QGD/Slav/London as solid; English/Catalan/Réti/London/
Nimzo plus closed, exchange, fianchetto and space-grabbing names as positional;
Grob, Van Geet, Hippopotamus and friends as surprise), so this is repertoire
selection, not a random-number generator.

Measured repertoire spread, 30 games per personality, 6 plies deep, seed 12345
(`node test/openings-native.js 30 6`, run on the release build):

| Style | First moves (top four of 30 games) | Black's answers | Distinct 6-ply lines |
|---|---|---|---|
| Balanced | d4 ×12, e4 ×10, c4 ×5, Nf3 ×3 | d5, e5, c5, d6 | 22 / 22 |
| Mainline | d4 ×12, e4 ×8, c4 ×6, Nf3 ×4 | Nf6, f5, e5, e6 | 19 / 19 |
| Aggressive | e4 ×15, d4 ×10, Nf3 ×4, c4 ×1 | e5, c5, Nf6, d5 | 20 / 20 |
| Positional | e4 ×10, c4 ×9, d4 ×8, Nf3 ×3 | Nf6, d6, c5, f5 | 26 / 27 |
| Solid | d4 ×13, c4 ×7, e4 ×6, Nf3 ×4 | Nf6, d5, e5, c6 | 25 / 27 |
| Gambit | e4 ×19, d4 ×11 (only these two: every real gambit starts with one) | e5, c5, Nf6, d5 | 19 / 19 |
| Surprise | e4 ×9, b4 ×5, d4 ×4, c4 ×3, plus Nc3, f4, g3, Nf3 | e5, d5, c5, Nc6 | 13 / 14 |

Every personality plays a different mix, none collapses onto one line, and no six-ply
sequence is repeated in more than 15% of a style's games (the suite asserts it, per style).

Guarantees the tests enforce:

- **No junk openings.** Novelty first moves (1.g4, 1.h4, 1.Na3, 1.f3) are
  removed at generation time, and Black's first reply is filtered to a sound
  set, so `Surprise` still cannot lose to its own opening. Gambit restricts
  itself to 1.e4/1.d4, where gambits actually exist.
- **Variety without blunders.** `Opening Diversity` decays the weight of lines
  already played this session; a per-position memory records both the
  (position, move) pair and the resulting position, so reaching the same position
  by a different move order is recognised. Questionable lines — rare in the
  chosen column, or weak against the balanced column — get a 5,000-node probe
  search and are replaced if they score materially worse than the book's main
  line. The margin is generous (300 cp for Gambit, 120 cp for Balanced) because
  a sound sacrifice evaluates below a quiet move without being a mistake.
- **Memory survives `ucinewgame`.** A new game ages the counts (rounding up)
  instead of clearing them, so a line played once is still remembered and a line
  played many times fades toward one. `Clear Book Memory` is the explicit reset.
  White and Black keep separate tables.
- **Reproducible.** `Random Seed` re-seeds the draw; two runs with the same seed,
  cleared memory and cleared hash produce the same games, which the test asserts
  for Balanced and Surprise.
- **Never in analysis.** Explicit `depth`, `nodes` or `infinite` searches ignore
  the book, so perft and WAC measure the search, and the search itself never
  consults the book.

`Book Variety 0` still means "the most popular move only" and returns `e2e4` from
the start position; `Book Style` then decides which "most popular" that is.

Validate every stored move and rebuild after editing `book-data/*.tsv`:

```bash
node test/gen-book.js          # book.js
node test/gen-native-book.js   # native/book_data.h  (then rebuild the exe)
node test/book-check.js        # every row: legal, 7 weights, sorted, sound roots
node test/openings-native.js   # personalities, memory, seeds, legality
node test/book-fallback.js     # the same on the JavaScript front-end
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
  `book.js`, forwards settings to the native core, and falls back to the
  JavaScript engine if the binary is missing.

**Trying the personalities and the predictor by hand.** Any UCI console works
(`native/kiwa-native.exe`, or `node uci.js` for `predict`):

```text
uci
setoption name Book Style value Surprise
setoption name Opening Diversity value 80
setoption name Random Seed value 7              # same seed => same repertoire
position startpos
go wtime 60000 btime 60000                       # a book move, instantly
bookmemory                                       # per-colour repetition memory
position startpos
go wtime 60000 btime 60000                       # a different line than above
ucinewgame                                       # memory ages, it is not wiped
eval                                             # tapered score of the position
position startpos moves e2e4 c7c5 g1f3
predict depth 5                                  # ranked human guesses
quit
```

`predict` prints one line per move with its probability, its search score and the
log-prior the model assigned, then a confidence summary naming which evidence
source answered (`table` when the position was seen in the training games,
`backoff` when only the features did). `go` never consults it.

In `node play.js` you can type `predict` after any move to see what a human would
probably have played, and `hint` for the engine's own best move — the two
routinely disagree, which is the point.

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

## Measured strength (fast time control)

Everything below was played on this laptop — an i3-5005U (2 cores, 4 threads)
with ordinary background load — using `test/elo.js`, which alternates colours on
paired openings so every comparison is a paired sample. The reported interval is
1σ sampling error only: `173.7 / sqrt(n·p·(1−p))`.

**Every strength measurement in this release**

Five paired duels, all 100 ms/move, all colours swapped on paired openings, all on
this one laptop. Read the intervals, not just the point estimates.

| Match | Games | Score | W/D/L | Elo | Nodes/move | Depth |
|---|---|---|---|---|---|---|
| released 2.2.0 exe vs 2.3.0 shipped (mobility K/B), both portable generic builds | 100 | 46/100 = 46.0% | +35 =22 −43 | **−28 ± 35** | 82,968 vs 103,967 | 9.2 vs 9.6 |
| released 2.2.0 exe vs 2.3.0 with mobility on all K/B/R/Q, generic builds | 100 | 50.5/100 = 50.5% | +43 =15 −42 | +3 ± 35 | 65,573 vs 92,235 | 8.4 vs 9.1 |
| 2.2.0 source vs 2.3.0 shipped (mobility K/B), both `-march=native` | 80 | 43/80 = 53.8% | +39 =8 −33 | **+26 ± 39** | 76,899 vs 96,788 | 9.0 vs 9.1 |
| 2.2.0 source vs 2.3.0 with mobility on all K/B/R/Q, both `-march=native` | 60 | 41.5/60 = 69.2% | +36 =11 −13 | +140 ± 49 | 75,098 vs 104,043 | 8.8 vs 9.4 |
| the two 2.3.0 mobility variants against each other, `-march=native` | 60 | 30/60 = 50.0% | +26 =8 −26 | equal within ±45 | 86,752 vs 78,237 | 9.2 vs 8.9 |

**What that means, stated plainly: no strength gain is established.** The
+140 ± 49 row was the first measurement made, and when the *shipped*
configuration was re-measured with more games the advantage fell to +26 ± 39,
which is not distinguishable from zero. In the builds a user actually downloads
(the portable generic ones) the new engine scores 46.0% and 50.5% against 2.2.0 —
also indistinguishable from zero, one of them leaning negative. Five numbers that
should be consistent if the effect were large and real are spread from −28 to
+140 with ±35–49 intervals, so the honest reading is that a 60-game duel at
100 ms/move on a throttling 2-core laptop has a resolving power of roughly ±80
Elo, and the evaluation work sits inside that band.

What *is* consistent across the measurements: the positional block costs search
speed (20–40% of nodes/s at equal flags), and at an equal node budget it solves
more positions (WAC 223/241 at 100k/200k nodes vs 216/235 for 2.2.0 built the
same way). So the evaluation is doing something measurable per node; whether that
converts into results at bullet tempo on weak hardware is not demonstrated here.
If you want the stronger-sounding build for a real rated game, the honest advice
is: use whichever configuration you have, and expect roughly 2.2.0-level play at
100 ms/move on this class of machine. Longer time controls, where the positional
terms have time to matter and the speed penalty is amortised, are the obvious next
measurement and are **not** done — see Limitations.

The ablations below are therefore about *where the per-node gain comes from*, not
about a proven Elo rise.


**Ablations — what each piece of the evaluation is worth.** The first three rows
are 60-game paired duels at 100 ms/move, book off, both sides built
`-O3 -march=native`, against the committed 2.2.0 source. The last row is a
head-to-head between two new builds.

| Configuration | Score | Elo |
|---|---|---|
| positional block, mobility on all of K/B/R/Q | 41.5/60 = 69.2% | **+140 ± 49** vs 2.2.0 |
| positional block, mobility off entirely | 30/60 = 50.0% | +0 ± 45 vs 2.2.0 |
| K/B/R/Q mobility, SEE quiescence prune disabled | 25.5/60 = 42.5% | −53 ± 45 vs 2.2.0 |
| **shipped** (mobility on knights and bishops) against the K/B/R/Q build | 30/60 = 50.0% | equal within ±45, with 11% more nodes/move |


These four duels are each about ±45 Elo wide, so treat them as directions rather
than sizes. Two things do hold up. Turning mobility off entirely took the best
measured result of the positional block away (+140 became +0), and giving
mobility to rooks and queens as well as knights and bishops bought nothing in
their own head-to-head (30/60) while costing 11% of the nodes per move - which is
why the release build stops at knights and bishops. The third reading is the most
interesting and the least certain: switching the static-exchange prune off turned
+140 into -53, hinting that most of what looks like "better positional play" is
actually better quiescence search. Confirming that needs a longer match than this
laptop can finish overnight.




**Absolute strength, anchored on Stockfish** (100 games, 100 ms/move, book on)

| Opponent | Build | Score | W/D/L | Performance Elo |
|---|---|---|---|---|
| Stockfish 19 at `UCI_Elo 2100`, `UCI_LimitStrength` | **2.3.0 shipped, portable build** | 67/100 = 67.0% | +63 =8 −29 | **2223 ± 37** |
| same anchor | 2.3.0 with mobility on every K/B/R/Q | 55/100 = 55.0% | +51 =8 −41 | 2135 ± 35 |
| same anchor | 2.2.0 (the released exe, same conditions as above) | measured alongside, see below | | |

So the two ways of measuring this release disagree, and both are reported.
Head to head against 2.2.0 with the **book off** at 100 ms/move, the shipped
build scores 46.0% (−28 ± 35): no gain. Against the strength-limited Stockfish
with the **book on**, it scores 67.0% where the previous version measured
heavily below that: a large gain. The difference is the book and the sample —
the 2.2.0 anchored number in the release history below came from 24 games in a
different session, so it is not a like-for-like control, which is why a 100-game
anchored run of the released 2.2.0 binary is being measured under exactly today's
conditions and its number will replace that row when it lands. Until then the
defensible statement is: **2.3.0 measures around 2220 on Stockfish's
limited-strength scale at 100 ms/move with its book on, and no strength gain is
established between the two engines' searches alone.**

The 2.2.0-era measurement in this file's history was 2096 ± 72 on the same scale
(24 games, so much wider). Stockfish's own `UCI_Elo` calibration, this time
control and the absence of any gauntlet are all outside the ±37.


**Tactical accuracy (WAC, 300 positions with a known best move)**

| Build | @100,000 nodes/move | @200,000 nodes/move | @300 ms/move | @1 s/move |
|---|---|---|---|---|
| 2.2.0 (source, `-march=native`) | 216/300 (72.0%) | 235/300 (78.3%) | 251/300 (83.7%) | 263/300 (87.7%) |
| 2.2.0 (released exe, generic build) | 220/300 (73.3%) | 239/300 (79.7%) | 253/300 (84.3%) | 266/300 (88.7%) |
| **2.3.0 shipped configuration** | 223/300 (74.3%) | 241/300 (80.3%) | 245/300 (81.7%) | 258/300 (86.0%) |

The node-budget columns are the portable release build of 2.3.0 and the matching
2.2.0 builds; the clock columns are the same configurations built
`-O3 -march=native`, because a clock-budget run otherwise measures the compiler
flags rather than the engine.

This cuts both ways, so both halves are here. At an equal **node** budget the
new evaluation is ahead — 223 vs 216/220 at 100k and 241 vs 235/239 at 200k —
because a stable positional assessment lets the tactical search prune correctly.
At an equal **clock** it solves 5–8 *fewer* puzzles: the positional block costs
about 40% of nodes/s at the same flags, and WAC rewards depth on simple forced
positions more than it rewards a better pawn structure. Same code, opposite
verdict, depending on which resource you hold fixed. In whole games at 100 ms/move
the same build won the controlled duel (see above), which is the number that
corresponds to playing chess.


## Benchmarks

All numbers from this machine: Node 24 front-end, GCC 16.2 (MSYS2 UCRT64). The
release binaries are `-O3 -std=c++17 -static` with no `-march` flag; `native\build.bat`
adds `-march=native`, which is worth roughly 20% on this CPU and makes the two
not directly comparable.

| Test | Result |
|---|---|
| Perft suite, native (6 standard + 3 special positions) | 39/39 checks pass, including startpos d5 = 4,865,609 |
| Perft suite, JavaScript fallback | same counts, all pass |
| Search speed, depth-12 bench, median of 3 (`-O3 -march=native`) | 2.2.0 source 1.11 M nodes/s (652,503 nodes); 2.3.0 with the positional block but mobility off 1.14 M; 2.3.0 with mobility on every K/B/R/Q 0.55 M; **2.3.0 shipped (K/B mobility) 0.65 M nodes/s** (680,757 nodes) |
| Search speed, portable release build (`-O3 -std=c++17 -static`, no `-march`) | 1.01–1.16 M nodes/s, 680,757 nodes at depth 12 in 0.59–0.68 s |
| Native vs JavaScript fallback, 100 ms/move, 10 games | native **7.5/10** (+7 =1 −2), alternating colours — the fallback is a safety net, not a second competitive engine |
| Threads, depth 14 startpos (median of 3, fresh process each run) | 1 T 2.70 s; 2 T 4.45 s (0.61×); 4 T 5.19 s (0.52×); 8 T 12.03 s (0.22×) |
| Threads, 300k nodes tactical | 1 T 360 ms; 2 T 433 ms (0.83×); 4 T 542 ms (0.66×); 8 T 1.08 s (0.33×) |
| Threads, 300k nodes open file | 1 T 248 ms; 2 T 345 ms (0.72×); 4 T 391 ms (0.63×); 8 T 796 ms (0.31×) |
| Threaded search sanity | every thread count returned a legal, non-empty move; no crashes or hangs; bestmove differs at 4/8 T (helpers disagree, which is expected for independent searches) |
| Memory, depth-16 search | ~44 MB resident, identical at `Hash` 64 and 512 — the table is reserved, and only the pages a search touches become resident |
| Default `Threads` | **1**, because of the three rows above. This CPU has 2 physical cores; helpers duplicate work and split the hash. On a machine with more physical cores >1 can help |
| UCI `stop` | answered at 1, 2 and 4 threads during a 1.2 s infinite search; bestmove arrives ~0.1–0.6 s after `stop` |
| Opening personalities | 210 book games / 1,147 book plies, 7 styles; 13–26 distinct six-ply lines per 14–27 games per style; every line legal; max \|eval\| after 6 plies 230 cp; seeded runs replay identically |
| Book validation | 5,580 positions, 8,134 moves, 0 illegal, 7 weights per row, sound root and first-reply repertoires |
| Prediction (1,000 held-out modern positions) | 39.3% top-1, 66.8% top-3, 76.1% top-5, log-loss 2.341, ECE 0.085 |

```bash
node test/perft.js
node test/perft-native.js
node test/rules.js
node test/bench.js
node test/wac-native.js nodes=100000 300     # load-proof tactical accuracy
node test/wac-native.js 300 300             # at a fixed time per move
node test/wac-native.js 1000 300            # 1 s/move
node test/thread-bench.js 1,2,4,8           # thread scaling
node test/eval-ab.js .build/base220.exe .build/KiwaChess.exe
node test/openings-native.js 30 6           # personalities, memory, seeds
node test/book-check.js
node test/book-fallback.js                  # the JavaScript front-end path
node test/prediction.js
node test/predict-accuracy.js --predictor ./test/predict-shipped.js --limit 1000
node test/match-native.js 100 10            # native vs JavaScript fallback
node test/elo.js --pairs 50 --ms 100 --book false --kiwa NEW.exe --opp OLD.exe
node test/elo.js --pairs 50 --ms 100 --anchor 2100 --stockfish <path-to-stockfish>
node test/uci-smoke.js
node test/stop-test.js
native/kiwa-native.exe bench                # depth-12 speed probe
native/kiwa-native.exe perft 5              # bare perft, no Node
```


## Human-move prediction

`predict` answers a different question from `go`: not "what is the best move"
but "what would a human play here". It searches every legal move, then blends the
search score with a prior learned from modern games, and turns the blend into
probabilities.

The prior replaced a hand-written table of about thirty squares. It is built from
**876 complete Lichess games, 55,824 plies** (CC0; see
`test/PREDICTION-DATA.md` for the accounts, the fetch commands and the drop
list), split by game id into 645 training and 231 evaluation games:

- a position table (`data/human-priors.json`, 19,977 keys, first three FEN
  fields so transpositions share an entry) counting how often each move was
  played;
- a twelve-feature backoff — capture, castling, check, queen trade, central
  pawn, development, recapture, king zone, hanging, in-book, quiet, queen move —
  scored by human-vs-legal odds ratios, which is what carries the model into
  positions the table has never seen;
- blend weights (`data/predict-weights.json`) fitted on **training positions
  only**, with leave-one-out: the observation being predicted is withheld, so a
  count cannot be scored against the label it came from.

Measured on 1,000 held-out positions (a deterministic subset, `--limit 1000`,
95% Wilson intervals, depth 4 at 400 ms):

| Predictor | Top-1 | Top-3 | Top-5 | Log-loss |
|---|---|---|---|---|
| **Kiwa `predict` (search + learned prior)** | **39.3%** [36.3–42.4] | **66.8%** [63.8–69.7] | **76.1%** [73.4–78.6] | **2.341** |
| Search only (engine move, depth 4) | 36.0% [33.1–39.0] | 44.7% [41.6–47.8] | 49.3% [46.2–52.4] | 3.064 |
| Learned prior alone (no search) | 23.5% [21.0–26.2] | 45.4% [42.3–48.5] | 57.2% [54.1–60.2] | 2.970 |
| Uniform over legal moves | 8.3% [6.8–10.2] | 19.6% [17.3–22.2] | 28.0% [25.3–30.9] | 3.218 |

Calibration, the part that makes the printed confidence mean something: expected
calibration error **0.085** over ten bins (predicted 45–50% → actual 46.5%,
predicted 50–60% → actual 52.6%). It is honest to about ±3 points; the model is
**over-confident above 0.7** (predicted 85% → actual 54%) because a single
well-covered position can dominate the softmax.

By band: opening (ply 1–16) 33.0% top-1, middlegame 39.5%, endgame 47.2%. By
colour: White 39.1%, Black 39.5% — the model is not skewed toward one side.

The generalisation gap is real and stated plainly: on training positions with
leave-one-out the same blend reaches 46.3% top-1, on held-out games 39.3%. And
on the two 19th-century games this README used to quote (Opera + Immortal, 78
human moves) the learned prior scores **50.0% top-1** where the old hand-written
prior scored 53.8% — romantic-era chess is a different distribution from modern
blitz. The modern held-out set is the number that matters, and there the ranking
quality improved most: top-5 went from 49.3% to 76.1%.

Prediction never touches objective play. `go` uses the search alone; the prior is
only consulted by the `predict` command. `test/prediction.js` asserts exactly
that: it searches a position, runs `predict`, searches again and requires the
same move and score, and it also requires that a `predict` call leaves the board
and the repetition history untouched (the feature walk uses make/unmake, not a
FEN reset).

```bash
node test/prediction.js                                    # behaviour + licensing
node test/predict-accuracy.js --predictor ./test/predict-shipped.js --limit 1000
node test/fit-predict.js 300                               # re-fit the blend
node test/predict.js 5 30 1                                # the two historical games
```

Rebuild the dataset offline from the stored PGN (no network needed):

```bash
node test/fetch-human-games.js --parse-only
node test/train-priors.js
```


## Release history

<details>
<summary>2.2.0</summary>

| Change | Evidence |
|---|---|
| Real engine settings in both cores | `Threads` (1–8), `Hash` (1–512 MB), `OwnBook`, `Book Depth`, `Book Variety`, `Move Overhead`, `Clear Hash`; the UCI smoke test asserts every option is advertised |
| Opening book embedded in the native exe | generated from the lichess named lines plus curated traps, compiled to `native/book_data.h`, so a GUI importing only `KiwaChess.exe` gets book moves |
| Genuine opening variety | 12 startpos games at Book Variety 100 produced 9 distinct first moves; Book Variety 0 returned the main move |
| No book blunders into mate | generation drops any move that allows mate in one |
| Real `Threads` search | N independent searches with private TT slices; `stop` verified at 1, 2 and 4 threads |
| Rules completed | insufficient material and root draw scoring; perft extended with explicit en passant, castling and underpromotion positions: 39 checks |
| Anchored rating | 24 games vs Stockfish 19 at `UCI_Elo` 2100/2000: 13/24, joint estimate **2096 ± 72** on Stockfish's limited-strength scale (100 ms/move, this machine) |

</details>

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
- **Evaluation**: material and tapered piece-square tables; a pawn-structure
  hash (doubled, isolated, backward, connected and passed pawns, passed-pawn
  king distance) plus an extras cache keyed on the whole position for mobility,
  outposts, bishop pair/bad bishop, rook files and seventh rank, connected rooks
  and the king pawn shield. See [Evaluation](#evaluation) for the terms and how
  each was measured.
- **Search**: iterative deepening with aspiration windows (±40 cp, widening
  instead of failing low/high), principal variation search, transposition table
  with mate-distance normalisation, null-move pruning, log-table late move
  reductions (also applied to losing captures), check extensions, quiescence with
  delta pruning and static-exchange pruning, killer moves, countermove heuristic,
  history heuristic with aging **and a malus** for quiet moves that failed high,
  reverse futility pruning, root continuity between iterations.
- **Position identity**: en passant contributes to the key only when the capture
  is legal for the mover, so a "different" FEN that is the same position is
  recognised as one — which is what makes repetition and the fifty-move window
  behave like the laws of chess rather than like the printed FEN.
- **Threads**: the coordinator starts N independent searches, each with its own
  board, search stacks and TT slice; helpers jitter their root ordering. The
  best result is chosen by mate status, then depth/score/nodes. No shared TT.
- **Time management**: clock budget, stability exit, iteration-skip estimate,
  and a hard cap at 1.5× the soft budget so `bestmove` beats the flag.
- **Book**: embedded in the native exe and mirrored in `book.js` for the Node
  path. Seven weight columns (one per personality), FEN-keyed, outside the
  search, with per-colour anti-repetition memory and a shallow search veto on
  questionable lines.
- **Prediction**: depth-limited search of every legal move, blended with the
  learned human prior from `data/human-priors.json` (position table plus a
  12-feature naive-Bayes backoff) and turned into probabilities with a fitted
  softmax. It is a separate command; `go` never consults it.


Files:

```
native/kiwa.cpp          C++17 board, movegen, eval, search, UCI loop
native/book_data.h       generated embedded book (do not edit)
native/kiwa-native.exe   local build (rebuild with native/build.bat)
native/build.bat         one-command GCC build (MSYS2 UCRT64)
native.js                Node ↔ native UCI bridge, with automatic fallback
engine.js                the same engine in JavaScript (fallback, play.js, tests)
uci.js                   UCI front-end: personalities, prediction, native or JS search
predict-model.js         the learned human prior (table + feature backoff)
play.js                  terminal play mode (JavaScript engine)
book.js                  generated opening book — do not edit by hand
book-data/               lichess chess-openings TSVs (a–e) + traps.tsv
data/human-priors.json   generated prior table, TRAIN split only — do not edit
data/predict-weights.json  fitted blend weights (test/fit-predict.js)
kiwa.bat                 Windows launcher for GUIs
assets/kiwa.png          the avatar used in this README / on Lichess
test/perft.js            JS move generation verification
test/perft-native.js     native move generation verification (spawns the exe)
test/rules.js            checkmate/stalemate/draw/EP/castling/promotion tests
test/stop-test.js        stop and quit behaviour at 1/2/4 threads
test/bench.js            speed, mate tests, baseline matches
test/wac.js              tactical benchmark, JS engine
test/wac-native.js       tactical benchmark, native engine (time or node budget)
test/eval-ab.js          two builds: nodes/s and WAC side by side
test/match-native.js     native vs JS at equal time, alternating colours
test/elo.js              anchored Stockfish match, or a duel between two binaries
test/thread-bench.js     Threads 1/2/4/8 scaling, legality checked
test/predict.js          human-move prediction on two historical games
test/predict-shipped.js  wraps engine.predict() for the accuracy harness
test/predict-accuracy.js top-1/3/5, log-loss, ECE and bands on held-out games
test/fetch-human-games.js  download/parse the CC0 game set (or re-parse offline)
test/train-priors.js     build the prior table from the TRAIN split
test/fit-predict.js      fit the blend weights with leave-one-out on TRAIN
test/PREDICTION-DATA.md  dataset, licence, split and measured baselines
test/gen-book.js         builds book.js from book-data/
test/gen-native-book.js  builds native/book_data.h from book.js
test/book-check.js       validates every book entry against the engine
test/openings-native.js  personalities, anti-repetition, memory, seeds
test/book-fallback.js    the same guarantees on the JavaScript front-end
test/prediction.js       predictor behaviour and licensing
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
- **Testing**: paired games against the previous version and against
  strength-limited Stockfish at 100 ms/move on a 2-core laptop. Intervals quoted
  are sampling noise only. There is no CCRL/gauntlet rating, no long-time-control
  match and no games against a full-strength engine.
- **Book**: opening theory only, 24 plies by default. It includes deliberately
  tricky gambits, not "every line ever played", and it does not know endgame
  tablebases.
- **Rules**: standard game-ending rules are implemented; exotic dead positions
  that require a proof are not.
- **Prediction**: a human-move model over modern club-to-master blitz games. It
  misses sacrifices and unusual plans, its confidence is over-peaked above 0.7,
  and it is not mind-reading.

The realistic path from here, in order of measured payoff: make the positional
terms incremental (they currently cost about half the nodes/s for the win they
give), then a shared-TT multithreaded search, then an NNUE trained on public
data, then SPSA tuning of the term values, then long-time-control gauntlets for a
real rating. The top single-author engines sit roughly 100 Elo behind Stockfish
after years of exactly that work.


## Known limitations

- **`Threads` above 1 is slower on this machine.** Measured: 2 T reaches 0.61–0.83×
  of 1 T's speed, 4 T 0.52–0.66×, 8 T 0.22–0.33×. The design is independent
  searches with private hash slices (Lazy SMP), which duplicates work when there
  are fewer real cores than threads, so the default is 1. A shared-TT
  implementation is the fix, not more threads.
- **The new evaluation costs speed.** At the same `-march=native` flags the
  depth-12 bench median went from 1.11 M nodes/s (2.2.0 source) to 0.65 M nodes/s
  for the shipped configuration — about 40%, most of it the ray-scan mobility and
  the rest the structural terms. The switch is still there: `g++ ...
  -DKIWA_MOB=0` drops mobility and most of the cost, `-DKIWA_EXTRAS=0` restores
  the 2.2.0 evaluation exactly. The terms are not incremental: they are
  recomputed on a cache miss keyed on the whole position, which is why they are
  expensive. Making them incremental, or replacing them with a trained
  evaluator, is the obvious next speed work.
- **No strength gain is claimed for the new evaluation.** Five paired duels
  against 2.2.0 spread from −28 ± 35 to +140 ± 49, which for a 60–100 game match
  at 100 ms/move on a throttling 2-core laptop means the differences are inside
  the noise. What is reproducible is per-node: WAC improves at a fixed node
  budget and drops at a fixed clock, because the terms cost 20–40% of nodes/s.
  Settling it needs a few hundred games at 1 s/move or more on faster hardware.
- **Nothing here is measured at classical time controls.** Every number in this
  README is 100 ms/move (or a node budget). Strength ordering changes with the
  time control, so treat all of it as bullet-chess evidence.

- **The JavaScript fallback keeps the older evaluation.** The positional terms
  live in `native/kiwa.cpp`; `engine.js` still scores with material, PST, the
  pawn-structure hash and its older extras, and its book path has no
  search-veto on questionable lines. The fallback exists so a missing or broken
  exe degrades instead of hanging a GUI; it is measurably weaker (`node
  test/match-native.js 100 10`).
- **`Hash` and `Threads` affect the native core only.** The fallback keeps a
  fixed-size table and searches single-threaded. It is synchronous: no `stop`,
  and `go infinite` is capped at 20 seconds there.
- **There is no pondering, no NNUE and no tablebase support.** No neural network
  ships here: an untrained net would be decoration, and a trained one needs
  hundreds of thousands of games and GPU time this project does not have.
- **The duel comparisons are same-flags only where stated.** The 2.2.0 *released*
  binary was built generically by CI, so a head-to-head against a `-march=native`
  build mixes a code difference with a compiler difference. The same-flags rows
  (shipped configuration: 43/80, +26 ± 39) are the ones that isolate the code,
  and they are the reason no Elo gain is claimed.
- **The prediction dataset is eight Lichess accounts.** 876 games, mostly club
  level blitz/bullet under clock pressure. Intervals are ±3–4 points; the model
  is over-confident above 0.7 probability; and on 19th-century games the learned
  prior is 3.8 points *behind* the hand-written priors it replaced. Treat the
  modern held-out numbers as the relevant ones and re-fit as the dataset grows.
- **The book is opening theory only**, 24 plies by default, and it does not know
  endgame tablebases. Personalities choose repertoire *within* it; they are not a
  guarantee of soundness for the rare lines, which is why questionable ones get a
  search veto and why `Book Variety 0` exists for serious play.
- **Rules**: standard game-ending rules are implemented and tested; exotic dead
  positions that require a proof are not.
- **Exotic first moves are filtered at the source.** 1.g4/1.h4/1.Na3/1.f3 are
  removed from the book's root by design (60 such entries pruned), so even
  `Surprise` cannot open with junk; it still plays 1.b4, 1.g3, 1.f4 and 1.Nc3.
- **The embedded book and the prior table are generated at build time.** After
  editing `book-data/` or the game data, run both generators (and re-fit) and
  rebuild the exe, or the binary and the model will be stale.


## Test suite and data sources

| What | Where it comes from | Licence |
|---|---|---|
| WAC tactical positions | [jdart1/arasan-chess `tests/wacnew.epd`](https://github.com/jdart1/arasan-chess/blob/master/tests/wacnew.epd) | BSD-style (Arasan repo); used only as a test fixture |
| Opening book lines | [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) TSVs `a`–`e` | CC0 1.0 |
| Curated gambits/traps | `book-data/traps.tsv`, written for this project (including the Wilkes-Barre, Snyder, O'Kelly and Pseudo-Trompowsky lines) | this project |
| Human games for the predictor | public Lichess game exports from eight accounts, via `test/fetch-human-games.js`; 876 games / 55,824 plies, recorded in `test/data/human-games.meta.json` with game ids and the split | CC0 1.0 ("Database exports are released under the Creative Commons CC0 license... use them for research, commercial purpose, publication, anything you like") — see `test/PREDICTION-DATA.md` |
| Opponent for strength measurement | Stockfish 19, run as a separate binary from `--stockfish`; **not** vendored, derived from, or redistributed here | GPL-3.0 (upstream) |

Spellings, traps and any errors in `book-data/traps.tsv` are this project's. The
prior table in `data/` is a statistic derived from the CC0 game set — it contains
no images, no player accounts beyond the game ids, and no Stockfish material.

