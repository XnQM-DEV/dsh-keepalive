@echo off
rem dsh-keepalive: remove the scheduled tasks and helpers it created (asks first).
rem Config, logs and backups are kept. Run as administrator if a task was created with highest privileges.
setlocal
set "KA_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if defined DSH_HOME set "KA_NODE=%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%KA_NODE%" set "KA_NODE=node"
"%KA_NODE%" --no-warnings "%~dp0bin\dsh-keepalive.mjs" uninstall
pause
