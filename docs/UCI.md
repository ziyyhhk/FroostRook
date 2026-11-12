# FroostRook 1.0.3 Beta — UCI reference

FroostRook speaks standard UCI. The release binary is `FroostRook.exe` (Windows
x64, portable build). The Node front-end in the `full` package exposes the same
options and adds the `predict` extension described below.

## Handshake

```
uci
```

replies:

```
id name FroostRook 1.0.3 Beta
id author ziyyhhk
id string core C++ native
...
uciok
```

`isready` replies `readyok`. Send `ucinewgame` between games: it clears the
transposition table, resets the position, and ages the opening-book memory. The
learned book memory is intentionally kept across games within a session; it is
not cleared by `ucinewgame`.

## Options

| Option | Type | Default | Range | Meaning |
| --- | --- | --- | --- | --- |
| `Threads` | spin | 1 | 1–8 | Worker threads. Lazy SMP: every thread searches the same root with a slightly perturbed move order on its own board copy, all sharing one transposition table. `bestmove` always comes from thread 0, whose tree benefits from the helper stores. |
| `Hash` | spin | 64 | 1–512 | Transposition table size in MB, shared by all search threads (Lazy SMP). 16 bytes per entry. |
| `MultiPV` | spin | 1 | 1–8 | Number of root lines reported. MultiPV searches run single-threaded so the lines form one ordered list. |
| `OwnBook` | check | true | | Use the embedded opening book for time-controlled games. |
| `Book Depth` | spin | 24 | 0–60 | Maximum ply (from the start position) at which a book move is played. |
| `Book Variety` | spin | 100 | 0–100 | 0 always plays the most popular book move; 100 spreads choices according to the repertoire weights. |
| `Book Style` | combo | Balanced | Balanced, Mainline, Aggressive, Positional, Solid, Gambit, Surprise | Opening repertoire personality. |
| `Opening Diversity` | spin | 50 | 0–100 | Extra spread among near-equal book moves. |
| `Random Seed` | spin | 0 | 0–2147483647 | Seed for reproducible book choices. 0 = nondeterministic. |
| `Move Overhead` | spin | 30 | 0–1000 | Milliseconds subtracted from the clock budget to absorb GUI/OS latency. |
| `Clear Book Memory` | button | | | Forget the session's learned book results. |
| `Clear Hash` | button | | | Clear the transposition table. |

## Search commands

```
position startpos moves e2e4 e7e5
position startpos moves e2e4 ponder e7e5
position fen <6 FEN fields> moves ...
go movetime 1000
go depth 12
go nodes 100000
go wtime 60000 btime 60000 winc 1000 binc 1000 movestogo 40
go infinite
go ponder wtime 60000 btime 60000
go ponder
stop
ponderhit
```

`bestmove 0000` means there is no legal move in the position (checkmate or
stalemate). Scores are `cp <centipawns>` from the side-to-move perspective, or
`mate <moves>` where a positive value means the side to move mates.

While searching, the engine emits `info depth <d> score ... nodes ... nps ...
time ... pv <moves>`. With `MultiPV > 1` each line additionally carries
`multipv <k>`; line 1 is the move returned in `bestmove`. `stop` ends the search
and reports the best completed iteration. In time-controlled games the engine
reserves a small move-overhead margin and stops before the clock runs out.

## Pondering

`position ... ponder <move>` tells the engine which move the opponent is
expected to play; the engine sets up the resulting position as its search
target. `go ponder` starts a ponder search on it (no book move is taken; a
real search runs). `ponderhit` reports that the predicted move was played:
the search is not restarted — it converts to a normal `go` on the same
position with the usual clock budget (same allocation formula as a regular
`go`), and finishes with `bestmove` as usual. `stop` abandons the ponder
search when the prediction was wrong. A ponder search that outlives the
opponent's move replies on its own 20-second cap; `stop` can always
interrupt it.

`MultiPV` and the opening book are mutually exclusive: analysis requests never
take a book move, even in the opening.

## Extra commands (not standard UCI)

These are useful in a terminal and are used by the test suite:

| Command | Effect |
| --- | --- |
| `d` | Print the current board. |
| `eval` | Print `info string eval <cp> cp` for the static evaluation. |
| `bookmemory` | Print learned-book counts (`info string book memory ...`). |
| `perft <d>` | Print `perft <d> <nodes> <ms>` for the current position. |
| `bench` | Depth-12 search from the start position; prints nodes, wall and CPU NPS, and extras-cache counters. |
| `predict [depth N] [movetime MS]` | Node front-end only: ranked human-move predictions. |

The release binary also accepts one-shot command-line modes:

```
FroostRook.exe perft 5
FroostRook.exe bench
```

## Example session

```
uci
setoption name Hash value 128
setoption name Threads value 2
isready
ucinewgame
position startpos moves e2e4 e7e5 g1f3
go movetime 500
```

## Analysis from the command line

`analyze.js` (in the full package) drives this UCI interface with a persistent
engine process and a consistent before/after evaluation. See
[ANALYSIS.md](ANALYSIS.md) for move classification, JSON output, and limits.
