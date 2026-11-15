@echo off
setlocal
set "EXT_DIR=%~dp0"
set "EXT_DIR=%EXT_DIR:~0,-1%"

echo.
echo  Facebook Group Share
echo  ====================
echo  Extension folder:
echo  %EXT_DIR%
echo.
echo  First-time setup:
echo    1. Chrome opens to chrome://extensions
echo    2. Turn on Developer mode (top right)
echo    3. Click "Load unpacked"
echo    4. Paste / select the folder above
echo.
echo  Later: just click Reload on the extension card after code changes.
echo.

REM Copy path for Load unpacked
echo %EXT_DIR%| clip
echo  (Path copied to clipboard.)
echo.

start "" chrome "chrome://extensions"
explorer "%EXT_DIR%"

endlocal
