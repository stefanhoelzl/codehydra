@echo off
if "%_CH_CODE_SERVER_DIR%"=="" (
  echo Error: _CH_CODE_SERVER_DIR not set. >&2
  exit /b 1
)
"%_CH_CODE_SERVER_DIR%\lib\node.exe" "%~dp0ch-claude.cjs" %*
