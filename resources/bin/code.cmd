@echo off
setlocal
if "%_CH_IDE_REMOTE_CLI%"=="" (
  echo Error: _CH_IDE_REMOTE_CLI not set. >&2
  echo Make sure you're in a CodeHydra workspace terminal. >&2
  exit /b 1
)
"%_CH_IDE_REMOTE_CLI%" %_CH_IDE_REMOTE_CLI_ARGS% %*
endlocal
