@echo off
cd /d "%~dp0"

dir /b *_GUI.py >nul 2>nul
if errorlevel 1 (
    echo ============================================
    echo  ERROR: Can't find *_GUI.py
    echo  Current: %cd%
    echo ============================================
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('dir /b *_GUI.py') do set SCRIPT=%%i
echo Source: %SCRIPT%

where python >nul 2>nul
if errorlevel 1 (
    echo ERROR: Python not found
    pause
    exit /b 1
)

echo [1/4] Creating venv build_env...
if exist "build_env\Scripts\python.exe" (
    echo    Already exists
) else (
    python -m venv build_env
    if errorlevel 1 (
        echo ERROR: venv creation failed
        pause
        exit /b 1
    )
    echo    Done
)

echo [2/4] Installing deps (pandas, openpyxl, pyinstaller)...
call build_env\Scripts\pip install pandas openpyxl pyinstaller psycopg2-binary -q
if errorlevel 1 (
    echo ERROR: pip install failed
    pause
    exit /b 1
)
echo    Done

echo [3/4] Building EXE (no console window)...
echo    WARNING messages are normal, please wait...

call build_env\Scripts\pyinstaller --onefile --noconsole --icon=logo.ico --name=DBManager --hidden-import=psycopg2 --exclude-module=torch --exclude-module=transformers --exclude-module=scikit-learn --exclude-module=onnxruntime --exclude-module=tensorflow --exclude-module=librosa --exclude-module=openai-whisper --exclude-module=modelscope --exclude-module=sentence-transformers "--exclude-module=funasr-onnx" "%SCRIPT%"
if errorlevel 1 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

echo [4/4] Copy + cleanup...
copy /Y "dist\DBManager.exe" "DBManager.exe" >nul
echo    Output: %~dp0DBManager.exe

rmdir /S /Q build >nul 2>nul
rmdir /S /Q dist >nul 2>nul
del /F /Q *.spec >nul 2>nul

echo.
echo ============================================
echo  DONE! File: DBManager.exe
echo ============================================
echo.
echo Tip: Delete 'build_env' folder to save space.
echo.
pause
