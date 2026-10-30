@echo off
REM Builds kiwa-native.exe with the MSYS2 UCRT64 GCC toolchain.
REM Run from anywhere; the script puts the compiler DLLs on PATH itself.
setlocal
set PATH=C:\msys64\ucrt64\bin;%PATH%
cd /d "%~dp0"

g++ -O3 -march=native -std=c++17 -static -o kiwa-native.exe kiwa.cpp
if errorlevel 1 (
  echo Build failed.
  exit /b 1
)
echo Built %~dp0kiwa-native.exe
