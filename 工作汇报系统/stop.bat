@echo off
title Stop Work Report System
echo Killing all node processes...
taskkill /F /IM node.exe >nul 2>&1
echo Done. All services stopped.
pause
