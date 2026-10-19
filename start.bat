@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo 未找到 Node.js，请先安装 Node.js 22 或更高版本: https://nodejs.org & pause & exit /b 1)
node src\main.js %*
pause
