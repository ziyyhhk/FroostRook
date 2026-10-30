@echo off
rem Kiwa UCI engine launcher. Point any chess GUI at this file.
rem GUI sends UCI commands on stdin; we answer on stdout.
cd /d "%~dp0"
node uci.js
