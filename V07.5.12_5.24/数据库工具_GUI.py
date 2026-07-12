# ===================== 智行知识库 V07.5.12 — 数据库管理台 =====================
# 支持 SQLite / PostgreSQL 双模式，通过 db_config.ini 切换
# =========================================================================
import sqlite3
import configparser
import pandas as pd
import os
import sys
from datetime import datetime
import tkinter as tk
from tkinter import filedialog, messagebox

# ==================== 数据库配置 ====================
CONFIG_FILE = "db_config.ini"
APP_NAME = "智行知识库V07.5.12数据库管理台"
LOGO_PATH = "logo.ico"

# 尝试加载 psycopg2（PostgreSQL 驱动），失败则降级为仅 SQLite
try:
    import psycopg2
    HAS_PSYCOPG2 = True
except ImportError:
    HAS_PSYCOPG2 = False


def load_config():
    """读取 db_config.ini，返回配置字典；若文件不存在则创建默认配置"""
    if not os.path.exists(CONFIG_FILE):
        _create_default_config()

    config = configparser.ConfigParser()
    config.read(CONFIG_FILE, encoding='utf-8')

    db_type = config.get('database', 'type', fallback='sqlite').strip().lower()

    if db_type == 'postgresql':
        return {
            'type': 'postgresql',
            'host': config.get('database', 'host', fallback='localhost'),
            'port': config.get('database', 'port', fallback='5432'),
            'user': config.get('database', 'user', fallback='postgres'),
            'password': config.get('database', 'password', fallback='123456'),
            'dbname': config.get('database', 'dbname', fallback='knowledge_base'),
        }
    else:
        return {
            'type': 'sqlite',
            'path': config.get('database', 'sqlite_path', fallback='KnowledgeBase.db'),
        }


def _create_default_config():
    """生成默认 db_config.ini"""
    content = """\
; =============================================
; 智行知识库 — 数据库连接配置
; =============================================
; type 可选值：
;   sqlite      — 使用本地 SQLite 文件
;   postgresql  — 使用 PostgreSQL 数据库（默认）
; =============================================

[database]
type = postgresql

; ---------- SQLite 设置（type=sqlite 时生效）----------
sqlite_path = KnowledgeBase.db

; ---------- PostgreSQL 设置（type=postgresql 时生效）----------
host = localhost
port = 5432
user = postgres
password = 123456
dbname = knowledge_base
"""
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        f.write(content)


# ==================== 数据库连接包装 ====================
class DBHelper:
    """统一数据库操作，抹平 sqlite3 与 psycopg2 的差异"""

    def __init__(self, cfg):
        self.cfg = cfg
        if cfg['type'] == 'postgresql':
            if not HAS_PSYCOPG2:
                raise RuntimeError(
                    "PostgreSQL 模式需要 psycopg2 库，请先安装：\n"
                    "pip install psycopg2-binary"
                )
            self.conn = psycopg2.connect(
                host=cfg['host'],
                port=cfg['port'],
                user=cfg['user'],
                password=cfg['password'],
                dbname=cfg['dbname'],
            )
            self.placeholder = '%s'
        else:
            self.conn = sqlite3.connect(cfg['path'])
            self.placeholder = '?'

    def execute(self, sql, params=None):
        """执行 INSERT/UPDATE/DELETE，返回 cursor"""
        sql = sql.replace('?', self.placeholder)
        cur = self.conn.cursor()
        cur.execute(sql, params or ())
        return cur

    def read_sql(self, sql, params=None):
        """执行 SELECT，返回 pandas DataFrame"""
        sql = sql.replace('?', self.placeholder)
        return pd.read_sql(sql, self.conn, params=params)

    def commit(self):
        self.conn.commit()

    def close(self):
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


def get_db():
    """便捷获取 DBHelper 实例"""
    cfg = load_config()
    return DBHelper(cfg)


def get_db_mode_text():
    """返回当前数据库模式的友好文本"""
    cfg = load_config()
    if cfg['type'] == 'postgresql':
        return f"PostgreSQL [{cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['dbname']}]"
    else:
        return f"SQLite [{os.path.basename(cfg['path'])}]"


# ==================== 功能函数 ====================

def export_excel():
    """导出知识记录到 Excel"""
    try:
        with get_db() as db:
            df = db.read_sql('''
                SELECT id AS ID, category AS 分类, submitter AS 创建人,
                       question AS 标题, solution AS 核心内容, remark AS 补充说明,
                       proposer AS 提出人, record_time AS 记录时间
                FROM operation_records WHERE recycle_status='正常'
            ''')
        if df.empty:
            messagebox.showinfo("提示", "无数据可导出")
            return
        filename = f"知识记录_导出_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        df.to_excel(filename, index=False, engine="openpyxl")
        messagebox.showinfo("成功", f"导出完成：\n{filename}")
    except Exception as e:
        messagebox.showerror("错误", f"导出失败：{str(e)}")


def import_excel():
    """从 Excel 导入知识记录"""
    path = filedialog.askopenfilename(
        title="选择Excel", filetypes=[("Excel文件", "*.xlsx;*.xls")]
    )
    if not path:
        return
    try:
        df = pd.read_excel(path, engine="openpyxl").fillna("")
        if df.empty:
            messagebox.showwarning("警告", "Excel无数据")
            return

        with get_db() as db:
            success = 0
            for _, row in df.iterrows():
                try:
                    db.execute('''
                        INSERT INTO operation_records
                        (category, submitter, question, solution, remark, proposer, record_time, recycle_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (
                        row.get("分类", "其他"),
                        row.get("创建人", ""),
                        row.get("标题", ""),
                        row.get("核心内容", ""),
                        row.get("补充说明", ""),
                        row.get("提出人", ""),
                        row.get("记录时间", datetime.now().strftime("%Y年%m月%d日 %H时%M分%S")),
                        "正常"
                    ))
                    success += 1
                except Exception:
                    continue
            db.commit()
        messagebox.showinfo("完成", f"导入成功：{success} 条")
    except Exception as e:
        messagebox.showerror("错误", f"导入失败：{str(e)}")


def clear_table():
    """清空知识记录表"""
    if not messagebox.askyesno(
        "⚠️ 危险操作",
        "确定要清空所有【知识记录】吗？\n此操作不可恢复！"
    ):
        return
    try:
        with get_db() as db:
            db.execute("DELETE FROM operation_records")
            db.commit()
        messagebox.showinfo("✅ 已清空", "所有知识记录已清空")
    except Exception as e:
        messagebox.showerror("错误", f"清空失败：{str(e)}")


# ==================== GUI 主界面 ====================

def main():
    root = tk.Tk()
    db_mode = get_db_mode_text()
    root.title(f"{APP_NAME}  —  {db_mode}")
    root.geometry("540x340")
    root.resizable(False, False)

    # 加载图标
    if os.path.exists(LOGO_PATH):
        try:
            icon = tk.PhotoImage(file=LOGO_PATH)
            root.iconphoto(True, icon)
        except Exception:
            pass

    # 标题
    tk.Label(root, text=APP_NAME, font=("微软雅黑", 16, "bold")).pack(pady=18)

    # 数据库模式提示
    tk.Label(
        root, text=f"当前数据库：{db_mode}",
        font=("微软雅黑", 9), fg="#888888"
    ).pack()

    # 按钮区域
    frame = tk.Frame(root)
    frame.pack(pady=12)

    btn_style = {"width": 26, "height": 2, "font": ("微软雅黑", 10)}

    tk.Button(
        frame, text="导出数据到 Excel", **btn_style, command=export_excel
    ).grid(row=0, column=0, padx=6, pady=6)
    tk.Button(
        frame, text="从 Excel 导入数据", **btn_style, command=import_excel
    ).grid(row=0, column=1, padx=6, pady=6)
    tk.Button(
        frame, text="清空【知识记录】数据", **btn_style,
        bg="#ff4444", fg="white", command=clear_table
    ).grid(row=1, column=0, padx=6, pady=6)
    tk.Button(
        frame, text="退出程序", **btn_style, command=root.quit
    ).grid(row=1, column=1, padx=6, pady=6)

    # 底部提示
    tk.Label(
        root, text="提示：编辑 db_config.ini 可切换 SQLite / PostgreSQL",
        font=("微软雅黑", 8), fg="#aaaaaa"
    ).pack(side="bottom", pady=6)

    root.mainloop()


if __name__ == "__main__":
    main()
