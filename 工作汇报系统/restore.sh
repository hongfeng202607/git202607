#!/bin/bash
# ================================================
#  慧报空间 - 数据库恢复脚本 (Linux)
#  用法：
#    ./restore.sh                              # 列出可用备份，选择恢复
#    ./restore.sh backup/文件名.sql              # 直接指定备份文件恢复
#    ./restore.sh backup/文件名.sql.gz           # 自动解压后恢复
# ================================================

set -e
cd "$(dirname "$0")"

# ===================== 配置区 =====================
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-work_report_db}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-123456}"

# 备份目录
BACKUP_DIR="$(dirname "$0")/backup"
# =================================================

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  慧报空间 - 数据库恢复${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""

# 检查 psql 是否可用
if ! command -v psql &> /dev/null; then
    echo -e "${RED}[错误] 未找到 psql${NC}"
    echo "  请安装 PostgreSQL 客户端："
    echo "  sudo apt install postgresql-client"
    exit 1
fi

# 确定要恢复的文件
RESTORE_FILE=""

if [ -n "$1" ]; then
    # 命令行指定了文件
    RESTORE_FILE="$1"
    if [ ! -f "$RESTORE_FILE" ]; then
        echo -e "${RED}[错误] 文件不存在：${RESTORE_FILE}${NC}"
        exit 1
    fi
else
    # 没指定文件，列出可用备份让用户选择
    echo -e "  可用备份文件："
    echo ""

    FILES=()
    I=0
    while IFS= read -r f; do
        FILES+=("$f")
        I=$((I + 1))
        SIZE=$(ls -lh "$f" | awk '{print $5}')
        DATE=$(date -r "$f" "+%Y-%m-%d %H:%M:%S")
        echo -e "  ${GREEN}[${I}]${NC} $(basename "$f")  ${YELLOW}${SIZE}${NC}  ${DATE}"
    done < <(find "$BACKUP_DIR" -maxdepth 1 \( -name "*.sql" -o -name "*.sql.gz" \) -type f 2>/dev/null | sort -r)

    if [ ${#FILES[@]} -eq 0 ]; then
        echo -e "  ${YELLOW}（没有找到备份文件）${NC}"
        echo ""
        echo -e "  备份目录：${BACKUP_DIR}"
        exit 1
    fi

    echo ""
    read -p "  请输入编号选择要恢复的备份： " SELECTED

    if ! [[ "$SELECTED" =~ ^[0-9]+$ ]] || [ "$SELECTED" -lt 1 ] || [ "$SELECTED" -gt ${#FILES[@]} ]; then
        echo -e "${RED}[错误] 无效的选择${NC}"
        exit 1
    fi

    RESTORE_FILE="${FILES[$((SELECTED - 1))]}"
fi

# 处理 .gz 压缩文件
ORIGINAL_FILE="$RESTORE_FILE"
if [[ "$RESTORE_FILE" == *.gz ]]; then
    echo -e "  检测到 .gz 压缩文件，正在解压..."
    gunzip -k -f "$RESTORE_FILE" 2>/dev/null || true
    RESTORE_FILE="${RESTORE_FILE%.gz}"
    if [ ! -f "$RESTORE_FILE" ]; then
        echo -e "${RED}[错误] 解压失败${NC}"
        exit 1
    fi
    echo -e "  ${GREEN}解压完成：$(basename "$RESTORE_FILE")${NC}"
fi

echo ""
echo -e "  恢复文件：${YELLOW}$(basename "$RESTORE_FILE")${NC}"
echo -e "  目标数据库：${DB_NAME}@${DB_HOST}:${DB_PORT}"
echo ""

# 确认
echo -e "${RED}⚠️  警告：此操作将覆盖当前数据库的所有数据！${NC}"
echo -e "${RED}  恢复前建议先备份当前数据库。${NC}"
echo ""
read -p "  确认恢复？输入 YES 继续： " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
    echo -e "${YELLOW}[取消] 操作已取消${NC}"
    exit 0
fi

echo ""
echo -e "  正在恢复，请稍候..."

# 执行恢复
export PGPASSWORD="${DB_PASSWORD}"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -f "$RESTORE_FILE" 2>/tmp/huibao_restore_err.$$

if [ $? -eq 0 ]; then
    echo -e "${GREEN}[成功] 数据恢复完成！${NC}"
    echo ""
    echo -e "  验证命令："
    echo -e "  ${YELLOW}PGPASSWORD='密码' psql -h $DB_HOST -U $DB_USER -d $DB_NAME -c '\dt'${NC}"
else
    echo -e "${RED}[失败] 恢复出错！${NC}"
    echo ""
    cat /tmp/huibao_restore_err.$$
    echo ""
    echo -e "${YELLOW}可能的原因：${NC}"
    echo "  1. 备份文件不完整或已损坏"
    echo "  2. 数据库连接配置不正确"
    echo "  3. 备份文件格式与当前 PostgreSQL 版本不兼容"
    rm -f /tmp/huibao_restore_err.$$
    exit 1
fi

rm -f /tmp/huibao_restore_err.$$

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${GREEN}  恢复完成！${NC}"
echo -e "  来源：$(basename "$RESTORE_FILE")"
echo -e "  数据库：${DB_NAME}"
echo -e "${CYAN}============================================${NC}"
echo ""
