@echo off
if "%CODEHYDRA_CODE_SERVER_DIR%"=="" (
  echo Error: CODEHYDRA_CODE_SERVER_DIR not set. >&2
  exit /b 1
)
"%CODEHYDRA_CODE_SERVER_DIR%\lib\node.exe" "%~dp0ch-claude.cjs" %*
