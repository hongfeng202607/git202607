# ===================== PostgreSQL 恢复脚本 =====================
# 用法：
#   双击运行，选备份文件恢复
#   或拖拽 .sql 备份文件到这个脚本上

import os
import sys
import subprocess

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = os.path.join(BASE_DIR, "Backup")

# PostgreSQL 工具路径（可设置 KB_PG_BIN 环境变量覆盖）
_PG_BIN = os.environ.get('KB_PG_BIN', r'F:\PostgreSQL\bin')
_PSQL = os.path.join(_PG_BIN, 'psql.exe')

DB_CONFIG = {
    'host': os.environ.get('KB_DB_HOST', 'localhost'),
    'port': int(os.environ.get('KB_DB_PORT', '5432')),
    'user': os.environ.get('KB_DB_USER', 'postgres'),
    'password': os.environ.get('KB_DB_PASSWORD', '123456'),
    'dbname': os.environ.get('KB_DB_NAME', 'knowledge_base')
}

def list_backups():
    if not os.path.exists(BACKUP_DIR):
        return []
    files = [f for f in os.listdir(BACKUP_DIR) if f.endswith('.sql')]
    files.sort(reverse=True)
    return files

def restore_database(sql_file):
    """用 psql 恢复数据库（先清空现有数据再恢复）"""
    env = os.environ.copy()
    env["PGPASSWORD"] = DB_CONFIG["password"]

    print(f"正在从以下文件恢复：")
    print(f"  {sql_file}")
    print()

    # Step 1: 先清空现有数据
    print("[1/2] 清空现有数据...")
    drop_sql = """
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    """
    try:
        result = subprocess.run(
            [_PSQL, "-U", DB_CONFIG["user"],
             "-h", DB_CONFIG["host"], "-d", DB_CONFIG["dbname"],
             "-c", drop_sql],
            env=env, capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            print(f"  警告: 清空数据时出错（可能数据库为空，不影响）")
    except Exception as e:
        print(f"  警告: {e}")

    # Step 2: 恢复
    print("[2/2] 正在恢复数据...")
    try:
        result = subprocess.run(
            [_PSQL, "-U", DB_CONFIG["user"],
             "-h", DB_CONFIG["host"], "-d", DB_CONFIG["dbname"],
             "-f", sql_file],
            env=env, capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0:
            print("[OK] 恢复成功！")
        else:
            print(f"[FAIL] 恢复失败 (exit code: {result.returncode})")
            if result.stderr:
                print(f"错误: {result.stderr[:500]}")
    except Exception as e:
        print(f"[FAIL] 恢复异常: {e}")

    input("\n按 Enter 键退出...")

if __name__ == "__main__":
    # 支持拖拽文件
    if len(sys.argv) > 1:
        sql_file = sys.argv[1]
        if os.path.exists(sql_file):
            restore_database(sql_file)
            sys.exit(0)

    # 交互模式
    backups = list_backups()
    if not backups:
        print("未找到任何备份文件 (.sql)")
        print(f"备份文件夹: {BACKUP_DIR}")
        input("\n按 Enter 键退出...")
        sys.exit(0)

    print("可用的备份文件：")
    print("-" * 60)
    for i, f in enumerate(backups[:20], 1):
        size = os.path.getsize(os.path.join(BACKUP_DIR, f))
        print(f"  [{i}] {f}  ({size/1024:.0f} KB)")
    print("-" * 60)
    print("  [0] 取消")

    try:
        choice = input("\n请输入编号选择要恢复的备份: ").strip()
        if choice == "0" or not choice:
            sys.exit(0)
        idx = int(choice) - 1
        if 0 <= idx < len(backups):
            sql_file = os.path.join(BACKUP_DIR, backups[idx])
            print()
            restore_database(sql_file)
        else:
            print("无效编号")
            input("按 Enter 退出...")
    except (ValueError, EOFError):
        print("已取消")
