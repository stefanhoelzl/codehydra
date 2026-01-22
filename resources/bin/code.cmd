@echo off
setlocal
if "%CODEHYDRA_CODE_SERVER_DIR%"=="" (
  echo Error: CODEHYDRA_CODE_SERVER_DIR not set. >&2
  echo Make sure you're in a CodeHydra workspace terminal. >&2
  exit /b 1
)
"%CODEHYDRA_CODE_SERVER_DIR%\lib\node.exe" "%CODEHYDRA_CODE_SERVER_DIR%\lib\vscode\out\server-cli.js" "code-server" "" "" "code.cmd" %*
endlocal
