# ===================== 数据权限管理（仅管理员） =====================
from flask import Blueprint, request, jsonify, g

from .db import get_db_connection, op_log, is_data_permission_enabled
from .auth import login_required, require_permission

data_permission_bp = Blueprint('data_permission', __name__)


# ===================== 获取开关状态 =====================
@data_permission_bp.route('/api/data_perm/status', methods=['GET'])
@login_required
def get_data_perm_status():
    enabled = is_data_permission_enabled()
    return jsonify({"status": "success", "enabled": enabled})


# ===================== 切换开关（需要 settings.data_perm 权限） =====================
@data_permission_bp.route('/api/data_perm/toggle', methods=['POST'])
@login_required
@require_permission("settings.data_perm")
def toggle_data_perm():
    data = request.json or {}
    enabled = data.get("enabled", False)

    with get_db_connection() as conn:
        conn.execute(
            "INSERT INTO sys_config (key, value) VALUES (%s, %s) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            ("data_permission_enabled", "1" if enabled else "0")
        )
        conn.commit()
    op_log(f"数据权限开关已{'开启' if enabled else '关闭'}")
    return jsonify({"status": "success", "enabled": enabled})


# ===================== 获取授权矩阵（需要 settings.data_perm 权限） =====================
@data_permission_bp.route('/api/data_perm/grants', methods=['GET'])
@login_required
@require_permission("settings.data_perm")
def get_data_perm_grants():
    """返回所有非super用户列表、其他创建人列表，以及每个用户的授权记录"""
    with get_db_connection() as conn:
        # 获取所有用户（排除 super_admin）
        users = conn.execute(
            "SELECT id, username FROM users WHERE (is_super IS NULL OR is_super=0) AND username != 'admin' ORDER BY id"
        ).fetchall()
        user_list = [dict(u) for u in users]

        # 获取所有授权记录（包括 username 类型的）
        all_grants = conn.execute(
            "SELECT user_id, granted_user_id, granted_username FROM user_data_permissions"
        ).fetchall()

        # 获取"其他"创建人：知识表中存在但不在用户列表中的 submitter（排除 admin/sadmin）
        existing_usernames = set(u["username"] for u in user_list)
        extra_submitters = conn.execute(
            "SELECT DISTINCT submitter FROM operation_records "
            "WHERE submitter IS NOT NULL AND submitter != '' "
            "AND submitter != 'admin' AND submitter NOT IN ('sadmin') "
            "ORDER BY submitter"
        ).fetchall()
        other_list = [row["submitter"] for row in extra_submitters if row["submitter"] not in existing_usernames]

    # 构建授权矩阵 {user_id: {user_ids: [...], usernames: [...]}}
    grant_map = {}
    for g in all_grants:
        uid = g["user_id"]
        if uid not in grant_map:
            grant_map[uid] = {"user_ids": [], "usernames": []}
        if g["granted_user_id"] is not None:
            grant_map[uid]["user_ids"].append(g["granted_user_id"])
        if g["granted_username"] is not None:
            grant_map[uid]["usernames"].append(g["granted_username"])

    # 给每个用户附上 granted 列表
    for u in user_list:
        gm = grant_map.get(u["id"], {"user_ids": [], "usernames": []})
        u["granted"] = gm["user_ids"]
        u["granted_usernames"] = gm["usernames"]

    return jsonify({"status": "success", "users": user_list, "other_submitters": other_list})


# ===================== 保存授权（需要 settings.data_perm 权限） =====================
@data_permission_bp.route('/api/data_perm/grant', methods=['POST'])
@login_required
@require_permission("settings.data_perm")
def save_data_perm_grant():
    data = request.json
    user_id = data.get("user_id")
    granted_ids = data.get("granted_ids", [])
    granted_usernames = data.get("granted_usernames", [])

    if not user_id:
        return jsonify({"status": "error", "msg": "参数不全"})

    if not isinstance(granted_ids, list):
        granted_ids = []
    if not isinstance(granted_usernames, list):
        granted_usernames = []

    with get_db_connection() as conn:
        # 先删除该用户的所有旧授权
        conn.execute("DELETE FROM user_data_permissions WHERE user_id=%s", (user_id,))
        # 重新插入 user_id 类型的授权
        for gid in granted_ids:
            conn.execute(
                "INSERT INTO user_data_permissions (user_id, granted_user_id) VALUES (%s, %s)",
                (user_id, gid)
            )
        # 重新插入 username 类型的授权（其他创建人）
        for uname in granted_usernames:
            conn.execute(
                "INSERT INTO user_data_permissions (user_id, granted_username) VALUES (%s, %s)",
                (user_id, uname)
            )
        conn.commit()

    # 记录日志
    with get_db_connection() as conn:
        user = conn.execute("SELECT username FROM users WHERE id=%s", (user_id,)).fetchone()
        uname = user["username"] if user else str(user_id)
    op_log(f"更新数据权限授权：用户 {uname}，授权查看 {len(granted_ids)} 个创建人的知识")
    return jsonify({"status": "success"})
