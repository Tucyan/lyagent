@echo off
setlocal
chcp 65001 >nul
if not exist "%~dp0runtime\node\node.exe" (
  echo 未找到程序运行环境。请使用 WinRAR 将发布包完整解压到全新目录，再运行本文件。
  pause
  exit /b 2
)
if not exist "%~dp0runtime\python\python.exe" (
  echo 未找到文档转换运行环境。请使用 WinRAR 将发布包完整解压到全新目录，再运行本文件。
  pause
  exit /b 2
)
if not exist "%~dp0runtime\python\Lib\site-packages\docling_serve" (
  echo 未找到文档转换服务。请重新取得发布包与匹配的哈希清单，解压到全新目录后重试。
  pause
  exit /b 2
)
if not exist "%~dp0app\dist\src\launcher.js" (
  echo 未找到应用程序。请从完整解压后的目录运行本文件，不要在压缩包内直接运行。
  pause
  exit /b 2
)
"%~dp0runtime\node\node.exe" "%~dp0app\dist\src\launcher.js"
set "COURSE_AGENT_EXIT=%errorlevel%"
if not "%COURSE_AGENT_EXIT%"=="0" (
  echo 启动未完成。请保留上方提示；已有业务数据请勿删除，不要反复双击启动。
  pause
)
exit /b %COURSE_AGENT_EXIT%
