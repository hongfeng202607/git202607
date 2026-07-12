# ===================== 认证 + 用户管理 =====================
import secrets
import functools
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify, g

from .db import get_db_connection, hash_pwd, verify_pwd, op_log

auth_bp = Blueprint('auth', __name__)

# ===================== 权限校验工具 =====================
def _has_permission(role_id, code):
    """检查角色是否拥有指定权限码"""
    if role_id is None:
        return False
    with get_db_connection() as conn:
        row = conn.execute('''
            SELECT 1 FROM role_permissions
            WHERE role_id=%s AND permission_code=%s
        ''', (role_id, code)).fetchone()
    return row is not None

def get_user_permissions(username):
    """获取指定用户的所有权限码列表"""
    with get_db_connection() as conn:
        user = conn.execute(
            "SELECT role_id FROM users WHERE username=%s",
            (username,)
        ).fetchone()
        if not user or not user["role_id"]:
            return []
        rows = conn.execute(
            "SELECT permission_code FROM role_permissions WHERE role_id=%s",
            (user["role_id"],)
        ).fetchall()
    return [r["permission_code"] for r in rows]

def require_permission(code):
    """权限校验装饰器：调用前需先经 @login_required，super_admin 豁免"""
    def decorator(f):
        @functools.wraps(f)
        def wrapper(*args, **kwargs):
            if _is_sadmin():
                return f(*args, **kwargs)
            if not _has_permission(g.user["role_id"], code):
                return jsonify({"status": "error", "msg": "无权限执行此操作"}), 403
            return f(*args, **kwargs)
        return wrapper
    return decorator

# ===================== 登录校验装饰器 =====================
def login_required(f):
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        token = request.headers.get("token")
        if not token:
            return jsonify({"status": "error", "msg": "请先登录"}), 401

        with get_db_connection() as conn:
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            user = conn.execute("SELECT * FROM user_tokens WHERE token=%s AND expire_time > %s",
                                (token, now)).fetchone()

            if not user:
                return jsonify({"status": "error", "msg": "登录已过期"}), 401

            u = conn.execute("SELECT * FROM users WHERE username=%s", (user["username"],)).fetchone()
            if not u or u["status"] != 1:
                return jsonify({"status": "error", "msg": "账号已禁用"}), 401

            g.user = u
            return f(*args, **kwargs)
    return wrapper

# ===================== 管理员权限校验 =====================
def _is_sadmin():
    """判断当前登录用户是否为系统超级管理员（is_super=1 或 username='admin' 兼容旧版）"""
    return g.user.get("is_super", 0) == 1 or g.user.get("username") == "admin"

def super_admin_required(f):
    """仅系统超级管理员admin可访问"""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        if not _is_sadmin():
            return jsonify({"status": "error", "msg": "仅超级管理员可操作"}), 403
        return f(*args, **kwargs)
    return wrapper

# ===================== 登录 =====================
@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.json
    u = data.get("username", "").strip()
    p = data.get("password", "").strip()

    with get_db_connection() as conn:
        # 查询用户（密码使用 verify_pwd 兼容新旧哈希）
        user_row = conn.execute("SELECT * FROM users WHERE username=%s AND status=1",
                               (u,)).fetchone()
        if not user_row or not verify_pwd(p, user_row["password"]):
            return jsonify({"status": "error", "msg": "账号或密码错误"})
        user = user_row

        if not user:
            return jsonify({"status": "error", "msg": "账号或密码错误"})

        token = secrets.token_hex(32)
        expire = (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("INSERT INTO user_tokens (username, token, expire_time) VALUES (%s, %s, %s)",
                     (u, token, expire))

        # 查出角色名
        role_name = user["role"]
        # 如果 role_id 有值，优先用 roles 表里的角色名
        if user.get("role_id"):
            role_row = conn.execute("SELECT name FROM roles WHERE id=%s", (user["role_id"],)).fetchone()
            if role_row:
                role_name = role_row["name"]
        # 获取权限列表
        permissions = get_user_permissions(u)

    # 登录日志：临时设置 g.user 使 op_log 能正确记录用户名
    g.user = {"username": u}
    op_log(f"用户登录")
    g.user = None

    return jsonify({
        "status": "success",
        "token": token,
        "username": u,
        "role": role_name,
        "role_id": user.get("role_id"),
        "permissions": permissions,
        "is_super": user.get("is_super", 0)
    })

# ===================== 登出 =====================
@auth_bp.route('/logout', methods=['POST'])
@login_required
def logout():
    username = g.user.get("username", "未知") if hasattr(g, "user") and g.user else "未知"
    token = request.headers.get("token")
    with get_db_connection() as conn:
        conn.execute("DELETE FROM user_tokens WHERE token=%s", (token,))
    op_log("用户登出")
    return jsonify({"status": "success"})

# ===================== 重置自己密码 =====================
@auth_bp.route('/reset_pwd', methods=['POST'])
@login_required
def reset_pwd():
    data = request.json
    new_pwd = data.get("new_pwd", "").strip()
    if len(new_pwd) < 6:
        return jsonify({"status": "error", "msg": "密码至少6位"})
    with get_db_connection() as conn:
        conn.execute("UPDATE users SET password=%s WHERE username=%s",
                     (hash_pwd(new_pwd), g.user["username"]))
    return jsonify({"status": "success", "msg": "密码已修改"})

# ===================== 账号管理（需 user.manage 权限） =====================
@auth_bp.route('/user/list', methods=['GET'])
@login_required
@require_permission("user.manage")
def user_list():
    with get_db_connection() as conn:
        # 有 user.manage 权限的用户不在列表中看到自己
        where_extra = "AND (u.is_super IS NULL OR u.is_super = 0)"
        params = [g.user['username']]
        where_extra += " AND u.username != %s"
        if not _is_sadmin():
            where_extra += " AND COALESCE(r.name, u.role) != 'admin'"
        # JOIN roles 表查角色名
        sql = '''
            SELECT u.id, u.username, u.role, u.role_id, u.status, u.create_time,
                   COALESCE(r.name, u.role) AS role_name
            FROM users u
            LEFT JOIN roles r ON r.id = u.role_id
            WHERE 1=1 {}
            ORDER BY u.id
        '''.format(where_extra)
        users = conn.execute(sql, params).fetchall()
        result = []
        for u in users:
            d = dict(u)
            d.pop("role", None)  # 去掉旧 role 字段
            result.append(d)
    return jsonify(result)

@auth_bp.route('/user/add', methods=['POST'])
@login_required
@require_permission("user.manage")
def user_add():
    data = request.json
    username = data.get("username")
    password = data.get("password", "123456")
    role_id = data.get("role_id")
    role_name = data.get("role", "")
    if not username:
        return jsonify({"status": "error", "msg": "账号不能为空"})
    try:
        with get_db_connection() as conn:
            # 确定 role_id
            target_role_id = role_id
            if not target_role_id and role_name:
                r = conn.execute("SELECT id FROM roles WHERE name=%s", (role_name,)).fetchone()
                if r:
                    target_role_id = r["id"]
            if not target_role_id:
                r = conn.execute("SELECT id FROM roles WHERE name='user'").fetchone()
                target_role_id = r["id"] if r else None

            # ⚠️ 检查：非 sadmin 不能创建 admin 角色用户
            if target_role_id:
                target_role = conn.execute("SELECT name FROM roles WHERE id=%s", (target_role_id,)).fetchone()
                if target_role and target_role["name"] == "admin" and not _is_sadmin():
                    return jsonify({"status": "error", "msg": "仅超级管理员可创建管理员账号"}), 403

            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            conn.execute(
                "INSERT INTO users (username,password,role,role_id,status,create_time) VALUES (%s,%s,%s,%s,%s,%s)",
                (username, hash_pwd(password), role_name or "user", target_role_id, 1, now)
            )
        return jsonify({"status": "success"})
    except Exception:
        return jsonify({"status": "error", "msg": "账号已存在"})

@auth_bp.route('/user/reset', methods=['POST'])
@login_required
@require_permission("user.manage")
def user_reset():
    data = request.json
    username = data.get("username")
    with get_db_connection() as conn:
        # ⚠️ 非 sadmin 不能重置 super 用户的密码
        if not _is_sadmin():
            target = conn.execute("SELECT is_super FROM users WHERE username=%s", (username,)).fetchone()
            if target and target["is_super"]:
                return jsonify({"status": "error", "msg": "仅超级管理员可重置超级管理员的密码"}), 403
        conn.execute("UPDATE users SET password=%s WHERE username=%s", (hash_pwd("123456"), username))
    return jsonify({"status": "success"})

@auth_bp.route('/user/status', methods=['POST'])
@login_required
@require_permission("user.manage")
def user_status():
    data = request.json
    username = data.get("username")
    status = data.get("status")
    with get_db_connection() as conn:
        # ⚠️ 非 sadmin 不能禁/is_super 角色用户
        if not _is_sadmin():
            target = conn.execute("SELECT role, role_id, is_super FROM users WHERE username=%s", (username,)).fetchone()
            if target:
                if target.get("is_super"):
                    return jsonify({"status": "error", "msg": "仅超级管理员可操作超级管理员账号"}), 403
                role_name = target["role"]
                if target["role_id"]:
                    r = conn.execute("SELECT name FROM roles WHERE id=%s", (target["role_id"],)).fetchone()
                    if r:
                        role_name = r["name"]
                if role_name == "admin":
                    return jsonify({"status": "error", "msg": "仅超级管理员可操作管理员账号"}), 403
        conn.execute("UPDATE users SET status=%s WHERE username=%s", (status, username))
    return jsonify({"status": "success"})

@auth_bp.route('/user/delete', methods=['POST'])
@login_required
@require_permission("user.manage")
def user_delete():
    data = request.json
    username = data.get("username")
    # 检查是否本人
    if username == g.user["username"]:
        return jsonify({"status":"error","msg":"不能删除自己"})

    with get_db_connection() as conn:
        # ⚠️ 查询目标是否为 super admin
        target_user = conn.execute("SELECT is_super FROM users WHERE username=%s", (username,)).fetchone()
        if target_user and target_user["is_super"]:
            return jsonify({"status":"error","msg":"禁止删除超级管理员"})

        # ⚠️ 非 sadmin 不能删 admin 角色用户
        if not _is_sadmin():
            target = conn.execute("SELECT role, role_id FROM users WHERE username=%s", (username,)).fetchone()
            if target:
                role_name = target["role"]
                if target["role_id"]:
                    r = conn.execute("SELECT name FROM roles WHERE id=%s", (target["role_id"],)).fetchone()
                    if r:
                        role_name = r["name"]
                if role_name == "admin":
                    return jsonify({"status": "error", "msg": "仅超级管理员可删除管理员账号"}), 403

        conn.execute("DELETE FROM user_tokens WHERE username=%s", (username,))
        conn.execute("DELETE FROM users WHERE username=%s", (username,))
    return jsonify({"status":"success"})

# ===================== 修改用户角色 =====================
@auth_bp.route('/api/permissions/me', methods=['GET'])
@login_required
def my_permissions():
    """返回当前登录用户的权限列表"""
    perms = get_user_permissions(g.user["username"])
    return jsonify({"status": "success", "permissions": perms, "is_super": g.user.get("is_super", 0)})

@auth_bp.route('/user/role', methods=['POST'])
@login_required
@require_permission("user.manage")
def user_role():
    data = request.json
    username = data.get("username")
    role_id = data.get("role_id")
    if not username or not role_id:
        return jsonify({"status": "error", "msg": "参数不全"})

    with get_db_connection() as conn:
        # ⚠️ 非 sadmin 不能改 super/is_super 角色用户的角色
        if not _is_sadmin():
            target = conn.execute("SELECT role, role_id, is_super FROM users WHERE username=%s", (username,)).fetchone()
            if target:
                if target.get("is_super"):
                    return jsonify({"status": "error", "msg": "仅超级管理员可修改超级管理员的角色"}), 403
                role_name = target["role"]
                if target["role_id"]:
                    r = conn.execute("SELECT name FROM roles WHERE id=%s", (target["role_id"],)).fetchone()
                    if r:
                        role_name = r["name"]
                if role_name == "admin":
                    return jsonify({"status": "error", "msg": "仅超级管理员可修改管理员账号的角色"}), 403

        # 查出新角色名用于旧 role 字段兼容
        role_row = conn.execute("SELECT name FROM roles WHERE id=%s", (role_id,)).fetchone()
        if not role_row:
            return jsonify({"status": "error", "msg": "角色不存在"})
        conn.execute(
            "UPDATE users SET role=%s, role_id=%s WHERE username=%s",
            (role_row["name"], role_id, username)
        )
        # 踢下线（删除该用户所有 token，强制重新登录）
        conn.execute("DELETE FROM user_tokens WHERE username=%s", (username,))
        op_log(f"修改用户 {username} 角色为 {role_row['name']}（ID={role_id}）")
    return jsonify({"status": "success"})
