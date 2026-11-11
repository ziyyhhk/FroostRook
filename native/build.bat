@echo off
REM Builds FroostRook.exe with the MSYS2 UCRT64 GCC toolchain.
REM Run from anywhere; the script puts the compiler DLLs on PATH itself.
REM
REM   build.bat           portable generic x86-64 build (the release build)
REM   build.bat native    optimized build for THIS cpu only (not redistributable)
REM
REM The portable build uses -march=x86-64 -mtune=generic and runs on any
REM x86-64 Windows machine. -march=native emits instructions tuned for the
REM build machine and must never be shipped as the generic asset.
setlocal
set PATH=C:\msys64\ucrt64\bin;%PATH%
cd /d "%~dp0"

windres app.rc -O coff -o app.o
if errorlevel 1 (
  echo Resource compilation failed.
  exit /b 1
)
if /i "%~1"=="native" (
  g++ -O3 -march=native -std=c++17 -static -o FroostRook.exe kiwa.cpp app.o
  if errorlevel 1 (
    echo Build failed.
    exit /b 1
  )
  echo Built CPU-specific %~dp0FroostRook.exe
  goto done
)
g++ -O3 -march=x86-64 -mtune=generic -std=c++17 -static -o FroostRook.exe kiwa.cpp app.o
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)
echo Built portable x86-64 %~dp0FroostRook.exe
:done
REM Legacy alias for scripts written before the rename; same binary.
copy /y FroostRook.exe kiwa-native.exe >nul
