# ===================== 智行知识库 V07.5.12 — 入口 =====================
import os
import re
import uuid
from flask import Flask, request, jsonify, send_from_directory

# ===================== PostgreSQL 工具路径 =====================
# 可通过环境变量 KB_PG_BIN 或 PATH 查找。默认路径兼容当前开发环境。
PG_BIN = os.environ.get('KB_PG_BIN', r'D:\PostgreSQL\bin')
PG_DUMP = os.path.join(PG_BIN, 'pg_dump.exe')
PSQL = os.path.join(PG_BIN, 'psql.exe')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def create_app():
    app = Flask(__name__, static_folder="uploads", static_url_path="/upload")
    app.config['SECRET_KEY'] = 'super-secret-key-' + str(uuid.uuid4())
    app.config['UPLOAD_FOLDER'] = os.path.join(BASE_DIR, "uploads")
    app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

    # 注册蓝图
    from blueprints.auth import auth_bp
    from blueprints.knowledge import knowledge_bp
    from blueprints.ai import ai_bp
    from blueprints.attachment import attachment_bp
    from blueprints.category import category_bp
    from blueprints.role import role_bp
    from blueprints.data_permission import data_permission_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(knowledge_bp)
    app.register_blueprint(ai_bp)
    app.register_blueprint(attachment_bp)
    app.register_blueprint(category_bp)
    app.register_blueprint(role_bp)
    app.register_blueprint(data_permission_bp)

    # ===================== 静态文件 =====================
    STATIC_DIR = os.path.join(BASE_DIR, "static")

    @app.route('/static/<path:filename>')
    def serve_static(filename):
        resp = send_from_directory(STATIC_DIR, filename)
        resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        resp.headers['Pragma'] = 'no-cache'
        resp.headers['Expires'] = '0'
        return resp

    # ===================== 页面路由 =====================
    @app.route('/')
    def index():
        with open(os.path.join(BASE_DIR, "index.html"), encoding="utf-8") as f:
            return f.read()

    @app.route('/tools')
    def tools_page():
        with open(os.path.join(BASE_DIR, "tools.html"), encoding="utf-8") as f:
            return f.read()

    # ===================== 管理工具 API =====================

    def _check_token(require_permission=None):
        """手动校验 token，可选校验权限码"""
        from blueprints.db import get_db_connection
        from datetime import datetime
        token = request.headers.get("token")
        if not token:
            return None, None
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn = get_db_connection()
        try:
            user_row = conn.execute(
                "SELECT * FROM user_tokens WHERE token=%s AND expire_time > %s",
                (token, now_str)
            ).fetchone()
            if not user_row:
                return None, None
            u = conn.execute(
                "SELECT * FROM users WHERE username=%s AND status=1",
                (user_row["username"],)
            ).fetchone()
            if not u:
                return None, None
            # 权限校验（可选）
            if require_permission:
                from blueprints.auth import get_user_permissions
                perms = get_user_permissions(u["username"])
                if require_permission not in perms and not (u.get("is_super", 0) == 1 or u["username"] == "admin"):
                    return None, None
            return u["username"], user_row["username"]
        finally:
            conn.close()

    @app.route('/api/import_records', methods=['POST'])
    def api_import_records():
        """批量导入知识记录"""
        username, _ = _check_token("knowledge.add")
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401

        from blueprints.db import get_db_connection, op_log, sync_all_categories
        from datetime import datetime

        data = request.json
        records = data.get("records", [])
        if not records:
            return jsonify({"status": "error", "msg": "无数据"})

        success = 0
        errors = []
        with get_db_connection() as conn:
            now = datetime.now().strftime("%Y年%m月%d日 %H时%M分%S秒")
            for i, row in enumerate(records):
                try:
                    conn.execute('''
                        INSERT INTO operation_records
                        (category, submitter, question, solution, remark, record_time, proposer, recycle_status)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ''', (
                        str(row.get("category", "其他")),
                        str(row.get("submitter", username)),
                        str(row.get("question", "")),
                        str(row.get("solution", "")),
                        str(row.get("remark", "")),
                        str(row.get("record_time", now)),
                        str(row.get("proposer", "")),
                        "正常"
                    ))
                    success += 1
                except Exception as e:
                    errors.append({"row": i, "error": str(e)})
            conn.commit()
        sync_all_categories()
        op_log(f"批量导入 {success} 条知识记录")
        return jsonify({"status": "success", "success": success, "errors": errors})

    @app.route('/api/clear_all', methods=['POST'])
    def api_clear_all():
        """清空所有正常状态的知识记录（永久删除）"""
        username, _ = _check_token()
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401

        from blueprints.db import get_db_connection, op_log

        try:
            with get_db_connection() as conn:
                # 删附件文件
                attaches = conn.execute("""
                    SELECT a.save_name FROM attachments a
                    JOIN operation_records r ON r.id = a.knowledge_id
                    WHERE r.recycle_status='正常'
                """).fetchall()
                for att in attaches:
                    fpath = os.path.join(app.config['UPLOAD_FOLDER'], att['save_name'])
                    if os.path.exists(fpath):
                        os.remove(fpath)
                # 删附件记录
                conn.execute("""
                    DELETE FROM attachments WHERE knowledge_id IN (
                        SELECT id FROM operation_records WHERE recycle_status='正常'
                    )
                """)
                # 删记录
                conn.execute("DELETE FROM operation_records WHERE recycle_status='正常'")
                conn.commit()
                # 重置自增 ID 从 1 开始
                conn.execute("ALTER SEQUENCE operation_records_id_seq RESTART WITH 1")
                conn.commit()
            op_log("清空所有知识记录")
            return jsonify({"status": "success", "msg": "已清空所有知识记录"})
        except Exception as e:
            return jsonify({"status": "error", "msg": str(e)})

    # ===================== 数据库备份/恢复 API =====================

    @app.route('/api/backup/manual', methods=['POST'])
    def api_backup_manual():
        """手动执行一次数据库备份"""
        username, _ = _check_token()
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401
        from blueprints.db import get_db_connection, op_log, DB_CONFIG
        from datetime import datetime
        import subprocess

        backup_dir = os.path.join(BASE_DIR, "Backup")
        os.makedirs(backup_dir, exist_ok=True)

        time_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = os.path.join(backup_dir, f"手动备份_{time_str}.sql")

        try:
            env = os.environ.copy()
            env["PGPASSWORD"] = DB_CONFIG["password"]
            # 列表传参，避免 shell 注入风险
            cmd = [PG_DUMP, "-U", DB_CONFIG["user"],
                   "-h", DB_CONFIG["host"], "-p", str(DB_CONFIG["port"]),
                   "-d", DB_CONFIG["dbname"],
                   "-f", backup_file,
                   "--no-owner", "--encoding=utf-8"]
            result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=120)
            if result.returncode == 0 and os.path.exists(backup_file):
                size = os.path.getsize(backup_file)
                op_log(f"手动备份成功：{os.path.basename(backup_file)}（{size/1024:.0f}KB）")
                return jsonify({
                    "status": "success",
                    "msg": f"备份成功",
                    "file": f"手动备份_{time_str}.sql",
                    "size": size
                })
            else:
                return jsonify({"status": "error", "msg": f"备份失败: {result.stderr[:200]}"})
        except subprocess.TimeoutExpired:
            return jsonify({"status": "error", "msg": "备份超时（120秒）"})
        except Exception as e:
            return jsonify({"status": "error", "msg": f"备份异常: {str(e)}"})

    @app.route('/api/backup/list', methods=['GET'])
    def api_backup_list():
        """列出可用的备份文件"""
        username, _ = _check_token()
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401

        backup_dir = os.path.join(BASE_DIR, "Backup")
        if not os.path.exists(backup_dir):
            return jsonify({"status": "success", "files": []})

        files = []
        for f in sorted(os.listdir(backup_dir), reverse=True):
            if f.endswith('.sql'):
                fpath = os.path.join(backup_dir, f)
                files.append({
                    "name": f,
                    "size": os.path.getsize(fpath),
                    "mtime": os.path.getmtime(fpath)
                })
        return jsonify({"status": "success", "files": files})

    @app.route('/api/backup/restore', methods=['POST'])
    def api_backup_restore():
        """从备份文件恢复数据库"""
        username, _ = _check_token()
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401

        from blueprints.db import DB_CONFIG
        import subprocess

        data = request.json
        filename = data.get("filename", "")
        if not filename:
            return jsonify({"status": "error", "msg": "请指定备份文件"})
        import re
        if not re.match(r'^[\w\-]+\.sql$', filename):
            return jsonify({"status": "error", "msg": "非法文件名"})

        sql_file = os.path.join(BASE_DIR, "Backup", filename)
        if not os.path.exists(sql_file):
            return jsonify({"status": "error", "msg": f"备份文件不存在: {filename}"})

        env = os.environ.copy()
        env["PGPASSWORD"] = DB_CONFIG["password"]

        try:
            # Step 1: 清空现有数据
            drop_sql = "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
            result = subprocess.run(
                [PSQL, "-U", DB_CONFIG["user"], "-h", DB_CONFIG["host"],
                 "-d", DB_CONFIG["dbname"], "-c", drop_sql],
                env=env, capture_output=True, text=True, timeout=30
            )
            if result.returncode != 0:
                return jsonify({"status": "error", "msg": f"清空数据失败: {result.stderr[:200]}"})

            # Step 2: 恢复
            result = subprocess.run(
                [PSQL, "-U", DB_CONFIG["user"], "-h", DB_CONFIG["host"],
                 "-d", DB_CONFIG["dbname"], "-f", sql_file],
                env=env, capture_output=True, text=True, timeout=120
            )
            if result.returncode == 0:
                from blueprints.db import op_log
                op_log(f"从备份恢复数据：{filename}")
                # 恢复后需要重新初始化 RBAC 等
                from blueprints.db import init_rbac, init_admin, init_database_data
                with get_db_connection() as conn:
                    init_rbac(conn)
                    init_admin(conn)
                    init_database_data(conn)
                return jsonify({"status": "success", "msg": f"从 {filename} 恢复成功"})
            else:
                return jsonify({"status": "error", "msg": f"恢复失败: {result.stderr[:200]}"})
        except subprocess.TimeoutExpired:
            return jsonify({"status": "error", "msg": "恢复超时"})
        except Exception as e:
            return jsonify({"status": "error", "msg": f"恢复异常: {str(e)}"})

    @app.route('/api/backup/init_tables', methods=['POST'])
    def api_backup_init_tables():
        """空库初始化：建表 + RBAC + 管理员 + 默认数据（误删库后重建用）"""
        username, _ = _check_token("user.manage")
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401
        from blueprints.db import get_db_connection, DB_CONFIG, DBConnection, init_rbac, init_admin, init_database_data
        try:
            # 先测试连接
            conn = DBConnection()
            conn.close()
            # 重复初始化（建表已有 IF NOT EXISTS，安全）
            with get_db_connection() as conn2:
                init_rbac(conn2)
                init_admin(conn2)
                init_database_data(conn2)
            return jsonify({"status": "success", "msg": "表结构已初始化，可以开始恢复数据"})
        except Exception as e:
            return jsonify({"status": "error", "msg": f"建表失败: {str(e)}"})

    @app.route('/api/backup/delete', methods=['POST'])
    def api_backup_delete():
        """删除指定的备份文件"""
        username, _ = _check_token()
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401
        data = request.json
        filename = data.get("filename", "")
        if not filename:
            return jsonify({"status": "error", "msg": "请指定文件名"})
        import re
        if not re.match(r'^[\w\-]+\.sql$', filename):
            return jsonify({"status": "error", "msg": "非法文件名"})
        fpath = os.path.join(BASE_DIR, "Backup", filename)
        if not os.path.exists(fpath):
            return jsonify({"status": "error", "msg": "文件不存在"})
        try:
            os.remove(fpath)
            return jsonify({"status": "success", "msg": "已删除"})
        except Exception as e:
            return jsonify({"status": "error", "msg": f"删除失败: {str(e)}"})

    @app.route('/api/id_sequence', methods=['GET'])
    def api_id_sequence_get():
        """查询当前 ID 流水号状态"""
        username, _ = _check_token()
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401
        from blueprints.db import DBConnection
        try:
            conn = DBConnection()
            max_id = conn.execute("SELECT COALESCE(MAX(id), 0) AS max_id FROM operation_records").fetchone()["max_id"]
            next_val = conn.execute("SELECT nextval('operation_records_id_seq') AS next_val").fetchone()["next_val"]
            conn.execute("SELECT setval('operation_records_id_seq', %s)", (next_val - 1,))
            conn.commit()
            conn.close()
            return jsonify({"status": "success", "max_id": max_id, "next_id": next_val})
        except Exception as e:
            return jsonify({"status": "error", "msg": str(e)})

    @app.route('/api/id_sequence', methods=['POST'])
    def api_id_sequence_set():
        """重置 ID 流水号起始值"""
        username, _ = _check_token()
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401
        from blueprints.db import DBConnection
        data = request.json
        start_with = data.get("start_with")
        if start_with is None or not isinstance(start_with, int) or start_with < 0:
            return jsonify({"status": "error", "msg": "起始值必须为非负整数"})
        try:
            conn = DBConnection()
            max_id = conn.execute("SELECT COALESCE(MAX(id), 0) AS max_id FROM operation_records").fetchone()["max_id"]
            if start_with <= max_id:
                conn.close()
                return jsonify({"status": "error", "msg": f"起始值({start_with})不能小于等于当前最大ID({max_id})，可能有数据残留"})
            conn.execute(f"ALTER SEQUENCE operation_records_id_seq RESTART WITH {start_with}")
            conn.commit()
            conn.close()
            from blueprints.db import op_log
            op_log(f"重置ID流水号起始值为 {start_with}")
            return jsonify({"status": "success", "msg": f"ID流水号已重置，下条新ID将从 {start_with} 开始"})
        except Exception as e:
            return jsonify({"status": "error", "msg": str(e)})

    # ===================== 操作日志 API =====================

    @app.route('/api/logs', methods=['GET'])
    def api_get_logs():
        """读取操作日志，支持分页和关键词搜索"""
        username, _ = _check_token()
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401

        from blueprints.db import LOG_FILE

        page = request.args.get("page", 1, type=int)
        page_size = request.args.get("page_size", 50, type=int)
        keyword = request.args.get("keyword", "").strip()
        level = request.args.get("level", "").strip()  # INFO / WARNING / ERROR

        if page < 1:
            page = 1
        if page_size < 1 or page_size > 200:
            page_size = 50

        log_path = LOG_FILE
        if not os.path.exists(log_path):
            return jsonify({"status": "success", "total": 0, "page": page, "page_size": page_size, "logs": []})

        try:
            # 读取日志文件
            lines = []
            with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.rstrip("\n")
                    if not line:
                        continue
                    # 关键词过滤
                    if keyword and keyword not in line:
                        continue
                    # 级别过滤
                    if level and f"| {level} |" not in line:
                        continue
                    lines.append(line)

            # 最新的在前面，限制最多展示 5000 条
            lines.reverse()
            total = len(lines)
            if total > 5000:
                lines = lines[:5000]
                total = 5000
            start = (page - 1) * page_size
            end = start + page_size
            page_lines = lines[start:end]

            # 解析每行日志
            logs = []
            for line in page_lines:
                entry = _parse_log_line(line)
                logs.append(entry)

            return jsonify({
                "status": "success",
                "total": total,
                "page": page,
                "page_size": page_size,
                "logs": logs
            })
        except Exception as e:
            return jsonify({"status": "error", "msg": f"读取日志失败: {str(e)}"})

    @app.route('/api/logs/clear', methods=['POST'])
    def api_clear_logs():
        """清空操作日志文件"""
        username, _ = _check_token()
        if not username:
            return jsonify({"status": "error", "msg": "请先登录"}), 401

        from blueprints.db import op_log
        from blueprints.db import LOG_FILE

        try:
            if os.path.exists(LOG_FILE):
                with open(LOG_FILE, "w", encoding="utf-8") as f:
                    f.write("")
                op_log("日志已清空")
            return jsonify({"status": "success", "msg": "日志已清空"})
        except Exception as e:
            return jsonify({"status": "error", "msg": f"清空日志失败: {str(e)}"})

    def _parse_log_line(line):
        """解析单行日志为结构化对象"""
        entry = {"time": "", "level": "", "user": "", "content": ""}
        # 格式1: 时间 | 级别 | 【操作日志】时间 [用户] 内容
        # 格式2: 时间 | 级别 | 【操作日志】时间 内容（旧格式，无用户名）
        # 格式3: 时间 | 级别 | 普通日志内容（无【操作日志】前缀）
        # 格式4: 非标准行（traceback续行等）
        parts = line.split(" | ", 2)
        if len(parts) >= 3:
            entry["time"] = parts[0].strip().split(",")[0]  # 去掉毫秒
            entry["level"] = parts[1].strip()
            body = parts[2].strip()
            # 尝试提取用户名（格式1：有 [用户] 标记）
            m = re.search(r'【操作日志】[^\[]*\[([^\]]*)\]\s*(.*)', body)
            if m:
                entry["user"] = m.group(1)
                entry["content"] = m.group(2)
            else:
                # 格式2或3：去掉【操作日志】时间前缀，保留核心内容
                m2 = re.match(r'【操作日志】\d{4}[-\d]+\s+\d{2}[:\d]+\s*(.*)', body)
                if m2:
                    entry["content"] = m2.group(1)
                else:
                    entry["content"] = body
        else:
            # 格式4：非标准行（Python traceback 续行等），标记为 TRACE
            entry["level"] = "TRACE"
            entry["content"] = line
        return entry

    return app


app = create_app()

if __name__ == '__main__':
    from blueprints.db import get_db_connection, init_rbac, init_admin, init_database_data, auto_import_excel, cleanup_orphan_uploads, logger
    with get_db_connection() as conn:
        init_rbac(conn)           # 初始化 RBAC 角色和权限
        init_admin(conn)          # 初始化管理员
        init_database_data(conn)  # 初始化默认数据
        auto_import_excel(conn)   # 自动导入Excel
    cleanup_orphan_uploads()      # 清理无主附件（>24小时未绑定）
    logger.info("服务启动成功")
    app.run(host="0.0.0.0", port=8901, debug=False, use_reloader=False)
