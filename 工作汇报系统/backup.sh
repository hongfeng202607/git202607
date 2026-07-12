#!/bin/bash
# ================================================
#  慧报空间 - 数据库备份脚本 (Linux)
#  用法：
#    ./backup.sh                    # 使用默认配置备份
#    DB_PASSWORD='密码' ./backup.sh # 指定密码备份
#    crontab 定时备份：
#      0 3 * * * /opt/huibao/backup.sh
# ================================================

set -e
cd "$(dirname "$0")"

# ===================== 配置区 =====================
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-work_report_db}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-123456}"

# 备份文件保存目录
BACKUP_DIR="$(dirname "$0")/backup"
# 保留最近多少天的备份
KEEP_DAYS=30
# =================================================

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# 创建备份目录
mkdir -p "$BACKUP_DIR"

# 生成文件名：work_report_db_20260528_030000.sql
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILE_NAME="${DB_NAME}_${TIMESTAMP}.sql"
FILE_PATH="${BACKUP_DIR}/${FILE_NAME}"

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  慧报空间 - 数据库备份${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo -e "  数据库：${DB_NAME}@${DB_HOST}:${DB_PORT}"
echo -e "  保存到：${FILE_PATH}"
echo ""

# 检查 pg_dump 是否可用
if ! command -v pg_dump &> /dev/null; then
    echo -e "${RED}[错误] 未找到 pg_dump${NC}"
    echo "  请安装 PostgreSQL 客户端："
    echo "  sudo apt install postgresql-client"
    exit 1
fi

# 执行备份
export PGPASSWORD="${DB_PASSWORD}"
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges \
    -f "$FILE_PATH" 2>/tmp/huibao_backup_err.$$

if [ $? -eq 0 ]; then
    # 获取文件大小
    FILE_SIZE=$(ls -lh "$FILE_PATH" | awk '{print $5}')
    echo -e "${GREEN}[成功] 备份完成！${NC}"
    echo -e "  文件大小：${FILE_SIZE}"

    # 可选：gzip 压缩
    gzip -f "$FILE_PATH" 2>/dev/null
    if [ -f "${FILE_PATH}.gz" ]; then
        GZ_SIZE=$(ls -lh "${FILE_PATH}.gz" | awk '{print $5}')
        echo -e "  压缩后：${GZ_SIZE}（.gz）"
    fi
else
    echo -e "${RED}[失败] 备份出错！${NC}"
    echo ""
    cat /tmp/huibao_backup_err.$$
    echo ""
    echo -e "${YELLOW}可能的原因：${NC}"
    echo "  1. PostgreSQL 服务未运行：sudo systemctl status postgresql"
    echo "  2. 密码不正确"
    echo "  3. 数据库名称不正确"
    echo ""
    echo -e "测试连接：${YELLOW}PGPASSWORD='密码' psql -h $DB_HOST -U $DB_USER -d $DB_NAME -c 'SELECT 1'${NC}"
    rm -f /tmp/huibao_backup_err.$$ /tmp/huibao_backup_list.$$
    exit 1
fi

rm -f /tmp/huibao_backup_err.$$

# 清理旧备份
echo ""
echo -e "  清理 ${KEEP_DAYS} 天前的旧备份..."
DELETED=0
for f in "$BACKUP_DIR"/*.sql "$BACKUP_DIR"/*.sql.gz; do
    [ -f "$f" ] || continue
    if [ $(find "$f" -mtime "+${KEEP_DAYS}" 2>/dev/null) ]; then
        rm -f "$f"
        echo -e "    ${YELLOW}[删除]${NC} $(basename "$f")"
        DELETED=$((DELETED + 1))
    fi
done

# 更可靠的清理方式：用 find
OLD_FILES=$(find "$BACKUP_DIR" -maxdepth 1 \( -name "*.sql" -o -name "*.sql.gz" \) -type f -mtime "+${KEEP_DAYS}" 2>/dev/null)
if [ -n "$OLD_FILES" ]; then
    echo "$OLD_FILES" | while read f; do
        rm -f "$f"
        echo -e "    ${YELLOW}[删除]${NC} $(basename "$f")"
        DELETED=$((DELETED + 1))
    done
fi

echo -e "  ${GREEN}共清理 ${DELETED} 个旧备份${NC}"

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${GREEN}  备份完成！${NC}"
echo -e "  目录：${BACKUP_DIR}"
echo -e "  文件：${FILE_NAME}${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
