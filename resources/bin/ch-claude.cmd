@echo off
if "%_CH_IDE_NODE%"=="" (
  echo Error: _CH_IDE_NODE not set. >&2
  exit /b 1
)
"%_CH_IDE_NODE%" "%~dp0ch-claude.cjs" %*
