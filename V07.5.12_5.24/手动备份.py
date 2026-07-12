# ===================== PostgreSQL 手动备份脚本 =====================
# 用法：
#   双击运行，手动执行一次完整数据库备份
#   备份文件自动保存到 Backup 文件夹

import os
import sys
import subprocess
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = os.path.join(BASE_DIR, "Backup")

# PostgreSQL 工具路径（可设置 KB_PG_BIN 环境变量覆盖）
_PG_BIN = os.environ.get('KB_PG_BIN', r'F:\PostgreSQL\bin')
_PG_DUMP = os.path.join(_PG_BIN, 'pg_dump')

# ===================== 数据库配置 =====================
# 优先从环境变量读取（可通过 .env 或系统环境变量设置），兼容默认值
DB_CONFIG = {
    'host': os.environ.get('KB_DB_HOST', 'localhost'),
    'port': int(os.environ.get('KB_DB_PORT', '5432')),
    'user': os.environ.get('KB_DB_USER', 'postgres'),
    'password': os.environ.get('KB_DB_PASSWORD', '123456'),
    'dbname': os.environ.get('KB_DB_NAME', 'knowledge_base')
}

def manual_backup_database():
    env = os.environ.copy()
    env["PGPASSWORD"] = DB_CONFIG["password"]

    if not os.path.exists(BACKUP_DIR):
        os.makedirs(BACKUP_DIR)

    time_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = os.path.join(BACKUP_DIR, f"手动备份_{time_str}.sql")

    print("=" * 60)
    print("           智行知识库 - 手动备份工具")
    print("=" * 60)
    print()
    print(f"目标数据库：{DB_CONFIG['dbname']}")
    print(f"备份路径：{backup_file}")
    print()

    print("正在备份...")

    try:
        # 直接用 pg_dump 命令（列表传参，避免 shell 注入）
        cmd = [_PG_DUMP, "-U", DB_CONFIG["user"],
               "-h", DB_CONFIG["host"], "-p", str(DB_CONFIG["port"]),
               "-d", DB_CONFIG["dbname"],
               "-f", backup_file,
               "--no-owner", "--encoding=utf-8"]

        result = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace"
        )

        if result.returncode == 0 and os.path.exists(backup_file):
            size = os.path.getsize(backup_file)
            print(f"✅ 备份成功！")
            print(f"📁 文件：手动备份_{time_str}.sql")
            print(f"📊 大小：{size / 1024:.0f} KB")
        else:
            print(f"❌ 备份失败！")
            print(f"错误信息：{result.stderr[:1000]}")

    except Exception as e:
        print(f"❌ 异常：{str(e)}")

    print("\n" + "-" * 60)
    input("按 Enter 键退出...")

if __name__ == "__main__":
    manual_backup_database()