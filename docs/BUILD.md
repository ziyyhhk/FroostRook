# Building FroostRook 1 Beta

## Native engine (Windows x64)

The release binary is built with GCC (MSYS2 UCRT64) and is statically linked, so
it has no runtime DLL dependencies.

```
cd native
windres app.rc -O coff -o app.o
g++ -O3 -std=c++17 -static -o FroostRook.exe kiwa.cpp app.o
```

`app.rc` embeds the approved icon (`assets/engine-icon.ico`) and the Windows
version resource.

This is the portable build used for release: it targets generic x86-64 and does
not require a specific CPU generation. `native/build.bat` does the same with the
UCRT64 toolchain on `PATH` and also leaves a legacy `kiwa-native.exe` copy for
old scripts.

For local play you can build a faster machine-specific binary:

```
g++ -O3 -march=native -std=c++17 -static -o FroostRook.exe kiwa.cpp app.o
```

`-march=native` enables AVX2 and other instructions available on the build
machine. Such a binary may crash on older CPUs, so it is not published as the
portable release asset.

To compile on Linux, use the same command without `-static` (or with
`-static-libstdc++ -static-libgcc`); the source uses only the C++17 standard
library, threads, and Windows timing calls guarded by `_WIN32`.

## Node front-end

The JavaScript front-end has no npm dependencies. Node.js 18 or newer is
recommended.

```
node uci.js          # UCI session
node play.js         # terminal game
node analyze.js --pgn game.pgn --depth 12
```

`native.js` finds the native core in this order:

1. `FROOSTROOK_NATIVE` (path override)
2. `KIWA_NATIVE` (legacy override)
3. `native/FroostRook.exe`
4. `FroostRook.exe` in the repository root
5. `native/kiwa-native.exe` (legacy name)

If no native binary exists, `uci.js` falls back to the pure-JavaScript search.
The fallback is correct but much slower and does not support MultiPV.

The standalone `FroostRook.exe` does not need Node; the front-end is only for
the extra personalities, prediction and PGN analysis tooling.

## Tests

```
node test/perft.js
node test/perft-native.js
node test/rules.js
node test/uci-smoke.js
node test/stop-test.js
node test/book-check.js
node test/book-fallback.js 2 6
node test/openings-native.js 20 6
node test/analyze-test.js
```

or `npm run test:all` for the same set. The engine must be built first for the
native tests; `test/perft-native.js` exits non-zero if the executable is missing
rather than silently skipping. The rules test reports `SKIP` when the front-end
has no native binary, so CI always builds one.

`test/wac-native.js 300 <ms>` runs the 300 WAC positions at a time budget;
`test/elo.js` runs anchored or head-to-head matches (see `--help` in the file
header). Both are measurement tools, not part of the default suite.

## NNUE experiment (optional, not used by the engine)

The FRNN1 prototype has its own inference program and is not linked into
`FroostRook.exe`:

```
cd native
g++ -O3 -std=c++17 -static -o nnue_bench.exe nnue.cpp nnue_bench.cpp
cd ..
./native/nnue_bench.exe data/nnue/frnn1.bin data/nnue/selftest.txt
```

It prints the 192-position parity check, the incremental-accumulator check and
timing, and exits non-zero on failure. Training is documented in `NNUE.md`.
