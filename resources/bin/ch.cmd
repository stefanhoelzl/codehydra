@echo off
rem CodeHydra CLI (see ch for details). The interpreter path is baked in at
rem install time so the CLI works outside a CodeHydra terminal; a CodeHydra
rem terminal's own _CH_IDE_NODE takes precedence when set.
setlocal
set "NODE=%_CH_IDE_NODE%"
if "%NODE%"=="" set "NODE={{ ideNode }}"

if not exist "%NODE%" (
  echo Error: CodeHydra's node interpreter was not found at %NODE%. 1>&2
  echo Start CodeHydra once to repair the CLI. 1>&2
  exit /b 3
)

"%NODE%" "%~dp0ch.cjs" %*
exit /b %errorlevel%
