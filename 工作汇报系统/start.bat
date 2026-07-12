@echo off
title Work Report System - Dev

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

node "%~dp0dev.js"
echo.
echo [INFO] Server stopped. Exit code: %ERRORLEVEL%
pause
