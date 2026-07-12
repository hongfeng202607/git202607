# ===================== 数据库层 (PostgreSQL) =====================
import os
import re
import glob
import time
import shutil
import hashlib
import subprocess
import pandas as pd
from datetime import datetime

import psycopg2
import psycopg2.extras

# ===================== 数据库连接配置 =====================
# 优先从环境变量读取（可通过 .env 或系统环境变量设置），兼容默认值
# KB_DB_HOST / KB_DB_PORT / KB_DB_USER / KB_DB_PASSWORD / KB_DB_NAME
DB_CONFIG = {
    'host': os.environ.get('KB_DB_HOST', 'localhost'),
    'port': int(os.environ.get('KB_DB_PORT', '5432')),
    'user': os.environ.get('KB_DB_USER', 'postgres'),
    'password': os.environ.get('KB_DB_PASSWORD', '123456'),
    'dbname': os.environ.get('KB_DB_NAME', 'knowledge_base')
}

# ===================== 路径配置 =====================
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_FILE = os.path.join(BASE_DIR, "KnowledgeBase.db")  # 旧SQLite备份
EXCEL_FILE = os.path.join(BASE_DIR, "运维记录.xlsx")
BACKUP_DIR = os.path.join(BASE_DIR, "Backup")
LOG_FILE = os.path.join(BASE_DIR, "server.log")
MAX_BACKUP_NUM = 10

# PostgreSQL 工具路径（和 app.py 保持一致，可环境变量覆盖）
_PG_BIN = os.environ.get('KB_PG_BIN', r'D:\PostgreSQL\bin')
_PG_DUMP = os.path.join(_PG_BIN, 'pg_dump.exe')

# ===================== 附件上传配置 =====================
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
ALLOWED_EXTENSIONS = {'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'doc', 'docx', 'xls', 'xlsx'}

# ===================== 日志 =====================
import logging
from logging.handlers import RotatingFileHandler

def init_logger():
    formatter = logging.Formatter('%(asctime)s | %(levelname)s | %(message)s')
    handler = RotatingFileHandler(LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=7, encoding='utf-8')
    handler.setFormatter(formatter)
    logger = logging.getLogger('app')
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    # 控制台输出（方便开发调试）
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(console)
    return logger

logger = init_logger()

def _get_current_username():
    """安全获取当前登录用户名，无请求上下文时返回 None"""
    try:
        from flask import g
        if hasattr(g, "user") and g.user:
            return g.user.get("username", "未知")
    except RuntimeError:
        pass
    return None

def op_log(content):
    user = _get_current_username() or "系统"
    logger.info(f"【操作日志】{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} [{user}] {content}")

# ===================== 文件格式验证 =====================
def hash_pwd(pwd):
    """使用 PBKDF2-HMAC-SHA256 + 随机盐 哈希密码"""
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac('sha256', pwd.encode('utf-8'), salt, 100000)
    return salt.hex() + ':' + key.hex()


def verify_pwd(pwd, stored):
    """校验密码：从存储的 salt:hash 中还原盐并验证"""
    try:
        salt_hex, hash_hex = stored.split(':')
        salt = bytes.fromhex(salt_hex)
        key = hashlib.pbkdf2_hmac('sha256', pwd.encode('utf-8'), salt, 100000)
        return key.hex() == hash_hex
    except (ValueError, IndexError):
        # 兼容旧版 SHA256 无盐哈希
        return hashlib.sha256(pwd.encode()).hexdigest() == stored

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


# ===================== 公共分词搜索工具 =====================
def tokenize_keywords(key, max_length=100):
    """
    分裂关键词：空格/标点分隔 → 短词拆2字滑动窗口 → 长词拆3字窗口 → 去重 → 限长度
    knowledge.py 和 ai.py 两处调用，统一实现避免重复。
    返回 keywords 列表。
    """
    if len(key) > max_length:
        key = key[:max_length]
    raw_words = re.split(r'[\\s,，。、；：！？\\t\\n\\r]+', key)
    keywords = []
    for w in raw_words:
        w = w.strip()
        if len(w) >= 2:
            keywords.append(w)
        # 任意长度>2的词拆2字滑动窗口（提高召回率）
        if len(w) > 2:
            for i in range(len(w) - 1):
                kw = w[i:i+2]
                if kw not in keywords and len(kw) >= 2:
                    keywords.append(kw)
        # 长度>4且纯中文的词额外拆3字窗口
        if len(w) > 4 and not re.search(r'[a-zA-Z]', w):
            for i in range(len(w) - 2):
                kw = w[i:i+3]
                if kw not in keywords and len(kw) >= 3:
                    keywords.append(kw)
    if not keywords:
        keywords = [key[:max_length]]
    seen = set()
    return [x for x in keywords if not (x in seen or seen.add(x))]


def build_like_conditions(keywords, fields):
    """
    为 keywords 列表生成 LIKE 查询条件。
    fields: 要搜索的字段名列表
    返回 (conditions_str, params_list)
    """
    conditions = []
    params = []
    for w in keywords:
        esc = w.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        cond = "(" + " OR ".join(f"{f} LIKE %s ESCAPE '\\'" for f in fields) + ")"
        conditions.append(cond)
        params.extend([f"%{esc}%"] * len(fields))
    return " OR ".join(conditions), params


# ===================== 数据库连接封装 =====================
class DBConnection:
    """封装 psycopg2 连接，使 conn.execute() 语法兼容旧 sqlite3 调用方式"""
    def __init__(self):
        self.conn = psycopg2.connect(**DB_CONFIG)
        self._ensure_tables()

    def _ensure_tables(self):
        cur = self.conn.cursor()
        cur.execute('''
        CREATE TABLE IF NOT EXISTS operation_records (
            id SERIAL PRIMARY KEY,
            category TEXT NOT NULL,
            submitter TEXT,
            question TEXT NOT NULL,
            solution TEXT NOT NULL,
            remark TEXT,
            record_time TEXT NOT NULL,
            recycle_status TEXT DEFAULT '正常',
            attachments TEXT DEFAULT '',
            is_important INTEGER DEFAULT 0,
            proposer TEXT DEFAULT ''
        )''')
        # 兼容旧表：添加 proposer 先检查 proposer 列是否已存在，避免 ALTER 失败导致事务中止
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='operation_records' AND column_name='proposer'"
        )
        if not cur.fetchone():
            try:
                cur.execute("ALTER TABLE operation_records ADD COLUMN proposer TEXT DEFAULT ''")
            except Exception:
                self.conn.rollback()
                cur = self.conn.cursor()
        # 兼容旧表：已存在则跳过（PostgreSQL 下用 try 捕获避免并发锁冲突）
        # 注意：多个进程同时执行 ALTER TABLE 会互相锁死，这里直接跳过
        # 列已在之前版本中添加
        # ===================== RBAC 权限表 =====================
        cur.execute('''
        CREATE TABLE IF NOT EXISTS roles (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            is_system INTEGER DEFAULT 0
        )''')
        cur.execute('''
        CREATE TABLE IF NOT EXISTS permissions (
            id SERIAL PRIMARY KEY,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            group_name TEXT DEFAULT ''
        )''')
        cur.execute('''
        CREATE TABLE IF NOT EXISTS role_permissions (
            role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
            permission_code TEXT REFERENCES permissions(code) ON DELETE CASCADE,
            PRIMARY KEY (role_id, permission_code)
        )''')
        cur.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            role_id INTEGER REFERENCES roles(id),
            status INTEGER DEFAULT 1,
            create_time TEXT
        )''')
        # 兼容旧表：添加 role_id 列
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='users' AND column_name='role_id'"
        )
        if not cur.fetchone():
            try:
                cur.execute("ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id)")
            except Exception:
                self.conn.rollback()
                cur = self.conn.cursor()
        cur.execute('''
        CREATE TABLE IF NOT EXISTS user_tokens (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            token TEXT NOT NULL,
            expire_time TEXT NOT NULL
        )''')
        cur.execute('''
        CREATE TABLE IF NOT EXISTS category_config (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
        )''')
        # 尝试启用 pg_trgm 扩展，用于相似度搜索加速（非必需，失败不影响业务）
        try:
            cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
            # 为查重建立 trigram 索引（加速模糊匹配）
            cur.execute("CREATE INDEX IF NOT EXISTS idx_records_question_trgm ON operation_records USING gin (question gin_trgm_ops)")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_records_solution_trgm ON operation_records USING gin (solution gin_trgm_ops)")
        except Exception:
            self.conn.rollback()
            cur = self.conn.cursor()
        cur.execute('''
        CREATE TABLE IF NOT EXISTS search_history (
            id SERIAL PRIMARY KEY,
            keyword TEXT UNIQUE,
            count INTEGER DEFAULT 1,
            last_time TEXT NOT NULL
        )''')
        cur.execute('''
        CREATE TABLE IF NOT EXISTS attachments (
            id SERIAL PRIMARY KEY,
            knowledge_id INTEGER NOT NULL,
            origin_name TEXT NOT NULL,
            save_name TEXT NOT NULL,
            file_ext TEXT,
            create_time TEXT NOT NULL
        )''')
        cur.execute('''
        CREATE TABLE IF NOT EXISTS sys_config (
            key TEXT PRIMARY KEY,
            value TEXT
        )''')
        # ===================== 数据权限表 =====================
        cur.execute('''
        CREATE TABLE IF NOT EXISTS user_data_permissions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            granted_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            granted_username TEXT,
            UNIQUE (user_id, granted_user_id),
            UNIQUE (user_id, granted_username)
        )''')
        cur.execute("CREATE INDEX IF NOT EXISTS idx_udp_user ON user_data_permissions(user_id)")
        # 迁移：如果表已存在，添加 granted_username 列并放宽 granted_user_id 约束
        try:
            cur.execute("ALTER TABLE user_data_permissions ADD COLUMN IF NOT EXISTS granted_username TEXT")
            cur.execute("ALTER TABLE user_data_permissions ALTER COLUMN granted_user_id DROP NOT NULL")
        except Exception:
            self.conn.rollback()
            cur = self.conn.cursor()
        cur.execute("CREATE INDEX IF NOT EXISTS idx_records_recycle ON operation_records(recycle_status)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_records_category ON operation_records(category)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_records_time ON operation_records(record_time)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_records_submitter ON operation_records(submitter)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_attachments_knowledge ON attachments(knowledge_id)")
        self.conn.commit()
        cur.close()

    def execute(self, query, params=None):
        """返回 RealDictCursor，支持 .fetchall() .fetchone() 等"""
        cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(query, params)
        return cur

    def execute_with_returning(self, query, params=None):
        """执行 INSERT ... RETURNING 并返回新行的 id"""
        cur = self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(query, params)
        row = cur.fetchone()
        self.conn.commit()
        cur.close()
        return row["id"] if row else None

    def commit(self):
        self.conn.commit()

    def close(self):
        if self.conn and not self.conn.closed:
            self.conn.close()

    def rollback(self):
        self.conn.rollback()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is None:
            try:
                self.conn.commit()
            except:
                pass
        else:
            try:
                self.conn.rollback()
            except:
                pass
        self.close()


def get_db_connection():
    return DBConnection()


# ===================== RBAC 初始化 =====================
PERMISSIONS_DATA = [
    # (code, name, group_name)
    ("knowledge.view", "查看知识", "知识管理"),
    ("knowledge.add", "新增知识", "知识管理"),
    ("knowledge.edit", "编辑知识", "知识管理"),
    ("knowledge.delete", "删除知识（移入回收站）", "知识管理"),
    ("knowledge.permanent_del", "永久删除", "知识管理"),
    ("recycle.view", "查看回收站", "回收站"),
    ("recycle.restore", "恢复回收站记录", "回收站"),
    ("attachment.upload", "上传附件", "附件管理"),
    ("attachment.delete", "删除附件", "附件管理"),
    ("category.manage", "管理分类", "分类管理"),
    ("user.manage", "管理用户账号", "用户管理"),
    ("ai.manage", "管理AI接口配置", "AI功能"),
    ("ai.use", "使用AI功能", "AI功能"),
    ("settings.dedup", "管理查重设置", "系统设置"),
    ("settings.data_perm", "管理数据权限", "系统设置"),
]

ROLES_DATA = [
    # (name, description, is_system, permission_codes)
    ("admin", "超级管理员，拥有全部权限", 1, [p[0] for p in PERMISSIONS_DATA]),
    ("editor", "编辑员，可管理知识记录", 1, [
        "knowledge.view", "knowledge.add", "knowledge.edit",
        "recycle.view", "recycle.restore",
        "attachment.upload", "attachment.delete",
        "ai.use",
    ]),
    ("user", "普通用户，仅查看和使用AI", 1, [
        "knowledge.view",
        "ai.use",
    ]),
]

def init_rbac(conn=None):
    """初始化 RBAC：权限 + 系统角色 + 迁移旧用户"""
    own_conn = conn is None
    if own_conn:
        conn = get_db_connection()
    try:
        # 1. 插入权限
        for code, name, group_name in PERMISSIONS_DATA:
            conn.execute(
                "INSERT INTO permissions (code, name, group_name) VALUES (%s, %s, %s) ON CONFLICT (code) DO NOTHING",
                (code, name, group_name)
            )
        # 2. 系统角色初始化（按 is_system 位置匹配，改名后不会重复创建）
        sys_roles = conn.execute(
            "SELECT id, name FROM roles WHERE is_system=1 ORDER BY id"
        ).fetchall()

        for idx, (_, desc, _, perms) in enumerate(ROLES_DATA):
            if idx < len(sys_roles):
                # 已有系统角色（可能已改名）→ 复用其 id
                rid = sys_roles[idx]["id"]
                conn.execute("UPDATE roles SET description=%s, is_system=1 WHERE id=%s", (desc, rid))
            else:
                # 首次创建（通常只有第一轮初始化才会走到这里）
                name = ROLES_DATA[idx][0]
                conn.execute(
                    "INSERT INTO roles (name, description, is_system) VALUES (%s, %s, 1)",
                    (name, desc)
                )
                conn.commit()
                rid = conn.execute("SELECT LASTVAL()").fetchone()["lastval"]
            # 全量替换权限
            conn.execute("DELETE FROM role_permissions WHERE role_id=%s", (rid,))
            for pc in perms:
                conn.execute(
                    "INSERT INTO role_permissions (role_id, permission_code) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (rid, pc)
                )

        # 清理因改名产生的多余系统角色（例如：admin→管理员后重启又创建了新的 admin）
        if len(sys_roles) > len(ROLES_DATA):
            extra_ids = [r["id"] for r in sys_roles[len(ROLES_DATA):]]
            cleaned = 0
            for rid in extra_ids:
                user_cnt = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM users WHERE role_id=%s", (rid,)
                ).fetchone()["cnt"]
                if user_cnt > 0:
                    logger.warning(f"RBAC：跳过清理角色 ID={rid}，有 {user_cnt} 个用户正在使用")
                    continue
                conn.execute("DELETE FROM role_permissions WHERE role_id=%s", (rid,))
                conn.execute("DELETE FROM roles WHERE id=%s", (rid,))
                cleaned += 1
            if cleaned:
                logger.info(f"RBAC：已清理 {cleaned} 个重复系统角色")

        conn.commit()

        # 3. 迁移旧用户：role TEXT → role_id
        # 获取 role_name → role_id 映射
        role_map = {}
        for r in conn.execute("SELECT id, name FROM roles").fetchall():
            role_map[r["name"]] = r["id"]
        # 找到 role_id 为空的旧用户
        users_to_migrate = conn.execute(
            "SELECT id, role FROM users WHERE role_id IS NULL"
        ).fetchall()
        for u in users_to_migrate:
            target_id = role_map.get(u["role"])
            if target_id:
                conn.execute("UPDATE users SET role_id=%s WHERE id=%s", (target_id, u["id"]))
        if users_to_migrate:
            conn.commit()
            op_log(f"RBAC：已迁移 {len(users_to_migrate)} 个旧用户到新角色体系")
    finally:
        if own_conn:
            conn.close()

# ===================== 自动初始化管理员 =====================
def init_admin(conn=None):
    own_conn = conn is None
    if own_conn:
        conn = get_db_connection()
    try:
        admin = conn.execute("SELECT * FROM users WHERE username='admin'").fetchone()
        if not admin:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            # 查第一个系统角色（即 admin 角色，可能已被改名）的 id
            admin_role = conn.execute("SELECT id FROM roles WHERE is_system=1 ORDER BY id LIMIT 1").fetchone()
            role_id = admin_role["id"] if admin_role else None
            conn.execute(
                "INSERT INTO users (username,password,role,role_id,status,create_time) VALUES (%s,%s,%s,%s,%s,%s)",
                ("admin", hash_pwd("123456"), "admin", role_id, 1, now)
            )
            conn.commit()
    finally:
        if own_conn:
            conn.close()

# ===================== 自动备份 =====================
def clear_old_backups():
    if not os.path.exists(BACKUP_DIR):
        return
    backup_files = glob.glob(os.path.join(BACKUP_DIR, "自动备份_*.sql"))
    backup_files.sort(key=lambda x: os.path.getmtime(x))
    if len(backup_files) > MAX_BACKUP_NUM:
        need_del = backup_files[:len(backup_files) - MAX_BACKUP_NUM]
        for f in need_del:
            try:
                os.remove(f)
                op_log(f"自动清理过期备份：{os.path.basename(f)}")
            except:
                pass

def auto_backup_database():
    """使用 pg_dump 做 PostgreSQL 备份"""
    try:
        if not os.path.exists(BACKUP_DIR):
            os.makedirs(BACKUP_DIR)
        time_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = os.path.join(BACKUP_DIR, f"自动备份_{time_str}.sql")
        env = os.environ.copy()
        env["PGPASSWORD"] = DB_CONFIG["password"]
        result = subprocess.run(
            [_PG_DUMP, "-U", DB_CONFIG["user"],
             "-h", DB_CONFIG["host"], "-d", DB_CONFIG["dbname"],
             "-f", backup_file, "--no-owner"],
            env=env, capture_output=True, timeout=30
        )
        if result.returncode == 0 and os.path.exists(backup_file):
            clear_old_backups()
            op_log(f"数据库备份成功 → 自动备份_{time_str}.sql")
        else:
            op_log(f"数据库备份失败：pg_dump 返回错误码 {result.returncode}")
            err_msg = result.stderr.decode('utf-8', errors='replace')[:200]
            op_log(f"备份错误: {err_msg}")
    except Exception as e:
        op_log(f"数据库备份失败：{str(e)}")

def sync_all_categories():
    """从操作记录中同步分类到 category_config，不存在的自动添加"""
    try:
        with get_db_connection() as conn:
            rows = conn.execute('SELECT DISTINCT category FROM operation_records WHERE category != %s', ("",)).fetchall()
            for row in rows:
                cate = row["category"].strip()
                if cate:
                    conn.execute(
                        "INSERT INTO category_config (name) VALUES (%s) ON CONFLICT (name) DO NOTHING",
                        (cate,)
                    )
            # 至少保证"其他"存在
            conn.execute(
                "INSERT INTO category_config (name) VALUES (%s) ON CONFLICT (name) DO NOTHING",
                ("其他",)
            )
            conn.commit()
    except Exception as e:
        logger.error(f"同步分类失败: {e}")

# ===================== AI配置读取 =====================
def get_ai_config():
    """从数据库读取AI配置，返回dict"""
    with get_db_connection() as conn:
        rows = conn.execute("SELECT key, value FROM sys_config").fetchall()
    cfg = {r["key"]: r["value"] for r in rows}
    return {
        "url": cfg.get("ai_api_url", ""),
        "key": cfg.get("ai_api_key", ""),
        "model": cfg.get("ai_model", "")
    }

# ===================== 初始化数据 =====================
def init_database_data(conn=None):
    """初始化默认数据（从知识库记录中提取分类，同步到 category_config）"""
    own_conn = conn is None
    if own_conn:
        conn = get_db_connection()
    try:
        if conn.execute('SELECT COUNT(*) AS cnt FROM category_config').fetchone()["cnt"] == 0:
            sync_all_categories()
            if conn.execute('SELECT COUNT(*) AS cnt FROM category_config').fetchone()["cnt"] == 0:
                conn.execute("INSERT INTO category_config (name) VALUES (%s)", ("其他",))
        conn.commit()
    finally:
        if own_conn:
            conn.close()

# ===================== Excel自动导入 =====================
def auto_import_excel(conn=None):
    if not os.path.exists(EXCEL_FILE):
        return
    own_conn = conn is None
    if own_conn:
        conn = get_db_connection()
    try:
        if conn.execute('SELECT COUNT(*) AS cnt FROM operation_records').fetchone()["cnt"] > 0:
            return
    finally:
        if own_conn:
            conn.close()
    try:
        df = pd.read_excel(EXCEL_FILE, engine="openpyxl").fillna("")
    except:
        return
    if df.empty:
        return
    own_conn2 = conn is None
    if own_conn2:
        conn = get_db_connection()
    try:
        for _, row in df.iterrows():
            conn.execute('''
            INSERT INTO operation_records
            (category, submitter, question, solution, remark, record_time, recycle_status, proposer)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ''', (
                str(row.get("分类", "其他")).strip(),
                str(row.get("提交人", "")).strip(),
                str(row.get("问题描述", "")).strip(),
                str(row.get("处理方法", "")).strip(),
                str(row.get("备注", "")).strip(),
                pd.to_datetime(row.get("记录时间")).strftime("%Y年%m月%d日 %H时%M分%S秒") if pd.notna(row.get("记录时间")) else datetime.now().strftime("%Y年%m月%d日 %H时%M分%S秒"),
                "正常",
                str(row.get("提出人", "")).strip()
            ))
        conn.commit()
    finally:
        if own_conn2:
            conn.close()
    sync_all_categories()
    op_log("执行Excel自动导入完成")

# ===================== 增量分类同步 =====================
def ensure_category(cate):
    """新增/编辑知识时调用，只确保当前分类存在，避免全表扫描"""
    if cate and cate.strip():
        try:
            with get_db_connection() as conn:
                conn.execute(
                    "INSERT INTO category_config (name) VALUES (%s) ON CONFLICT (name) DO NOTHING",
                    (cate.strip(),)
                )
        except Exception:
            pass

# ===================== 无主附件清理 =====================
def cleanup_orphan_uploads(hours=24):
    """清理 uploads/ 中超过指定小时且未绑定到 attachments 表的无主附件"""
    if not os.path.exists(UPLOAD_FOLDER):
        return
    try:
        with get_db_connection() as conn:
            bound = set(r["save_name"] for r in conn.execute(
                "SELECT save_name FROM attachments"
            ).fetchall())
        cutoff = time.time() - hours * 3600
        cleaned = 0
        for fname in os.listdir(UPLOAD_FOLDER):
            fpath = os.path.join(UPLOAD_FOLDER, fname)
            if not os.path.isfile(fpath):
                continue
            # 跳过非 UUID 命名的文件（如 logo.png, backgr.png 等人工放入的）
            if not re.match(r'^[a-f0-9\-]+\.[a-z0-9]+$', fname, re.I):
                continue
            if fname in bound:
                continue
            if os.path.getmtime(fpath) < cutoff:
                os.remove(fpath)
                cleaned += 1
        if cleaned:
            op_log(f"清理了 {cleaned} 个无主附件（超过{hours}小时未绑定）")
    except Exception as e:
        logger.error(f"清理无主附件失败: {e}")

# ===================== 数据权限辅助函数 =====================
# ===================== 数据权限缓存 =====================
_data_perm_cache = {"value": None, "time": 0}
_data_perm_cache_ttl = 60  # 秒

def is_data_permission_enabled(conn=None):
    """从 sys_config 读取 data_permission_enabled，返回 bool。可传入已有连接避免嵌套。
    无传入连接时带 60 秒 LRU 缓存。"""
    if conn is None:
        now = time.time()
        if now - _data_perm_cache["time"] < _data_perm_cache_ttl:
            return _data_perm_cache["value"]
        conn = get_db_connection()
        try:
            row = conn.execute(
                "SELECT value FROM sys_config WHERE key='data_permission_enabled'"
            ).fetchone()
            result = row is not None and row["value"] == "1"
            _data_perm_cache["value"] = result
            _data_perm_cache["time"] = time.time()
            return result
        finally:
            conn.close()
    else:
        row = conn.execute(
            "SELECT value FROM sys_config WHERE key='data_permission_enabled'"
        ).fetchone()
        return row is not None and row["value"] == "1"


def get_visible_submitters(conn, user_id):
    """返回当前用户可查看的 submitter 用户名列表（含自己 + 被授权的用户 + 其他创建人）"""
    # 自己
    user = conn.execute("SELECT username FROM users WHERE id=%s", (user_id,)).fetchone()
    if not user:
        return []
    result = [user["username"]]
    # 被授权的用户（通过 user_id 关联）
    grants = conn.execute(
        "SELECT u.username FROM user_data_permissions udp "
        "JOIN users u ON u.id = udp.granted_user_id "
        "WHERE udp.user_id=%s AND udp.granted_user_id IS NOT NULL",
        (user_id,)
    ).fetchall()
    for g in grants:
        if g["username"] not in result:
            result.append(g["username"])
    # 被授权的"其他"创建人（通过 username 关联）
    extra = conn.execute(
        "SELECT granted_username FROM user_data_permissions "
        "WHERE user_id=%s AND granted_username IS NOT NULL",
        (user_id,)
    ).fetchall()
    for e in extra:
        if e["granted_username"] not in result:
            result.append(e["granted_username"])
    return result


def build_data_perm_where(conn, username, base_where, params):
    """
    如果数据权限开启，追加 submitter IN (...) 条件。
    admin 角色或 is_super=1 的用户豁免（始终看全部）。
    返回 (where_str, params_list)。
    """
    if not is_data_permission_enabled(conn):
        return base_where, params

    # 查当前用户的角色信息，admin/super 豁免
    user = conn.execute(
        "SELECT id, role, role_id, is_super FROM users WHERE username=%s",
        (username,)
    ).fetchone()
    if not user:
        return base_where + " AND 1=0", params

    # admin 角色（role_id 对应 roles.name='admin'）或 is_super=1 豁免
    if user.get("is_super") == 1 or user.get("username") == "admin":
        return base_where, params
    if user.get("role_id"):
        role = conn.execute("SELECT name FROM roles WHERE id=%s", (user["role_id"],)).fetchone()
        if role and role["name"] == "admin":
            return base_where, params

    # 普通用户：只看自己 + 被授权的创建人
    visible = get_visible_submitters(conn, user["id"])
    if visible:
        placeholders = ",".join(["%s"] * len(visible))
        return base_where + f" AND submitter IN ({placeholders})", params + list(visible)
    return base_where + " AND 1=0", params
