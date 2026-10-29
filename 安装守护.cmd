@echo off
rem dsh-keepalive: set up the external watchdog (scheduled tasks + helpers).
rem It prints a plan and asks before changing anything. All Chinese text is printed by node.
setlocal
set "KA_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if defined DSH_HOME set "KA_NODE=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%KA_NODE%" set "KA_NODE=node"
"%KA_NODE%" --no-warnings "%~dp0bin\dsh-keepalive.mjs" init --if-missing
"%KA_NODE%" --no-warnings "%~dp0bin\dsh-keepalive.mjs" doctor
"%KA_NODE%" --no-warnings "%~dp0bin\dsh-keepalive.mjs" install --elevate
pause
