@echo off
REM Builds FroostRook.exe with the MSYS2 UCRT64 GCC toolchain.
REM Run from anywhere; the script puts the compiler DLLs on PATH itself.
setlocal
set PATH=C:\msys64\ucrt64\bin;%PATH%
cd /d "%~dp0"

g++ -O3 -march=native -std=c++17 -static -o FroostRook.exe kiwa.cpp
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)
REM Legacy alias for scripts written before the rename; same binary.
copy /y FroostRook.exe kiwa-native.exe >nul
echo Built %~dp0FroostRook.exe
