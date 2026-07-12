@echo off

chcp 65001 >nul

title 工作汇报系统 - 生产模式



echo ============================================

echo  多人协作工作汇报系统 - 生产模式

echo ============================================

echo.



set ROOT=%~dp0

set BACKEND=%ROOT%backend

set FRONTEND=%ROOT%frontend



where node >nul 2>&1

if %ERRORLEVEL% neq 0 (

    echo [错误] 未检测到 Node.js，请先安装 Node.js

    pause

    exit /b 1

)



if not exist "%FRONTEND%\dist\index.html" (

    echo [提示] 前端尚未构建，正在构建...

    cd /d "%FRONTEND%"

    call npm run build

    if %ERRORLEVEL% neq 0 (

        echo [错误] 前端构建失败

        pause

        exit /b 1

    )

    echo [完成] 前端构建成功

)



echo.

echo 正在启动后端服务...

echo 访问地址: http://localhost:8902

echo 默认账号: admin / admin123

echo.

cd /d "%BACKEND%"

npm start

pause

