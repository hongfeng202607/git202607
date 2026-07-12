#!/bin/bash
# ================================================
#  慧报空间 - Linux 启动脚本
#  用法：
#    首次部署：chmod +x start.sh && ./start.sh
#    后台运行：./start.sh &
#    停止：按 Ctrl+C
# ================================================

set -e
cd "$(dirname "$0")"
BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m'

echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}  慧报空间 - Linux 启动${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""

# ---------- 检查 Node.js ----------
if ! command -v node &> /dev/null; then
    echo -e "${RED}[ERROR] 未找到 node，请先安装 Node.js 22${NC}"
    echo "  安装命令："
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -"
    echo "  sudo apt install -y nodejs"
    exit 1
fi
echo -e "  Node.js: $(node -v)"

# ---------- 检查数据库连接 ----------
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-work_report_db}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-123456}"

echo -e "  数据库：${DB_NAME}@${DB_HOST}:${DB_PORT}"

# ---------- 检查 node_modules ----------
if [ ! -d "backend/node_modules" ]; then
    echo -e "${YELLOW}[INFO] 后端依赖未安装，正在安装...${NC}"
    cd backend && npm install --production && cd ..
    echo -e "${GREEN}[OK] 后端依赖安装完成${NC}"
fi

if [ ! -d "frontend/node_modules" ]; then
    echo -e "${YELLOW}[INFO] 前端依赖未安装，正在安装...${NC}"
    cd frontend && npm install && cd ..
    echo -e "${GREEN}[OK] 前端依赖安装完成${NC}"
fi

# ---------- 检查前端构建 ----------
if [ ! -d "frontend/dist" ]; then
    echo -e "${YELLOW}[INFO] 前端未构建，正在构建...${NC}"
    cd frontend && npx vite build && cd ..
    echo -e "${GREEN}[OK] 前端构建完成${NC}"
fi

# ---------- 检查 JWT 密钥 ----------
if [ ! -f "backend/jwt-secret.txt" ]; then
    echo -e "${YELLOW}[INFO] 生成 JWT 密钥...${NC}"
    openssl rand -hex 32 > backend/jwt-secret.txt
    chmod 600 backend/jwt-secret.txt
    echo -e "${GREEN}[OK] JWT 密钥已生成${NC}"
fi

echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "  访问地址：${CYAN}http://localhost:8902${NC}"
echo -e "  管理员：  ${GREEN}admin / admin123${NC}"
echo -e "${BOLD}============================================${NC}"
echo -e "${GRAY}按 Ctrl+C 停止${NC}"
echo ""

# ---------- 启动后端 ----------
cd backend
export DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD
node app.js
