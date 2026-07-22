@echo off
rem CodeHydra background wrapper (see ch-bg for details). Runs the command
rem transparently so the "ch-bg" marker appears in the command string CodeHydra
rem sees, excluding this background shell from keeping the workspace busy.
call %*
exit /b %errorlevel%
