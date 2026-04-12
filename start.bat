@echo off
echo ====================================
echo AI 群聊 · 大模型辩论场 - 启动脚本
echo ====================================
echo.

echo [1/3] 正在检查后端依赖...
cd backend
if not exist "node_modules" (
    echo 正在安装后端依赖...
    call npm install
)
echo.

echo [2/3] 正在检查前端依赖...
cd ..\frontend
if not exist "node_modules" (
    echo 正在安装前端依赖...
    call npm install
)
echo.

echo [3/3] 正在启动项目...
echo.
echo ====================================
echo 后端将在 http://localhost:3001 运行
echo 前端将在 http://localhost:3000 运行
echo 请打开浏览器访问 http://localhost:3000
echo ====================================
echo.

echo 正在启动后端服务器...
start "AI群聊后端" cmd /k "cd ..\backend && npm run dev"

timeout /t 3 /nobreak > nul

echo 正在启动前端开发服务器...
start "AI群聊前端" cmd /k "cd ..\frontend && npm run dev"

echo.
echo 项目已启动！
echo 后端控制台已打开
echo 前端控制台已打开
echo.
pause
