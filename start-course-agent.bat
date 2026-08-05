@echo off
setlocal
if not exist "%~dp0runtime\node\node.exe" (
  echo Course Agent runtime is missing. Please extract the complete release package.
  exit /b 2
)
if not exist "%~dp0app\dist\src\launcher.js" (
  echo Course Agent application is missing. Please extract the complete release package.
  exit /b 2
)
"%~dp0runtime\node\node.exe" "%~dp0app\dist\src\launcher.js"
exit /b %errorlevel%
