# ===================== 角色管理（需 user.manage 权限） =====================
from datetime import datetime
from flask import Blueprint, request, jsonify, g

from .db import get_db_connection, op_log
from .auth import login_required, require_permission, get_user_permissions

role_bp = Blueprint('role', __name__)

# ===================== 获取全部权限列表 =====================
@role_bp.route('/api/permissions', methods=['GET'])
@login_required
def get_permissions():
    """返回所有权限，按 group_name 分组"""
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT code, name, group_name FROM permissions ORDER BY group_name, id"
        ).fetchall()
    # 按分组整理
    grouped = {}
    for r in rows:
        group = r["group_name"] or "其他"
        if group not in grouped:
            grouped[group] = []
        grouped[group].append({
            "code": r["code"],
            "name": r["name"]
        })
    return jsonify({
        "status": "success",
        "data": grouped
    })


# ===================== 获取角色列表 =====================
@role_bp.route('/api/roles', methods=['GET'])
@login_required
@require_permission("user.manage")
def get_roles():
    """返回所有角色（含权限列表）"""
    with get_db_connection() as conn:
        roles = conn.execute(
            "SELECT id, name, description, is_system FROM roles ORDER BY id"
        ).fetchall()
        result = []
        for role in roles:
            # 非 super 看不到 admin 角色
            if not g.user.get("is_super") and role["name"] == "admin":
                continue
            r = dict(role)
            # 查该角色的权限码
            perms = conn.execute(
                "SELECT permission_code FROM role_permissions WHERE role_id=%s",
                (role["id"],)
            ).fetchall()
            r["permissions"] = [p["permission_code"] for p in perms]
            # 用户数
            cnt = conn.execute(
                "SELECT COUNT(*) AS cnt FROM users WHERE role_id=%s",
                (role["id"],)
            ).fetchone()
            r["user_count"] = cnt["cnt"] if cnt else 0
            result.append(r)
    return jsonify({
        "status": "success",
        "data": result
    })


# ===================== 新增角色 =====================
@role_bp.route('/api/roles/add', methods=['POST'])
@login_required
@require_permission("user.manage")
def add_role():
    data = request.json
    name = data.get("name", "").strip()
    description = data.get("description", "").strip()
    permissions = data.get("permissions", [])

    if not name:
        return jsonify({"status": "error", "msg": "角色名称不能为空"})
    if not isinstance(permissions, list):
        return jsonify({"status": "error", "msg": "permissions 格式错误"})

    # ⚠️ 非 super 只能分配自己拥有的权限
    if not g.user.get("is_super"):
        user_perms = get_user_permissions(g.user["username"])
        invalid = [p for p in permissions if p not in user_perms]
        if invalid:
            return jsonify({"status": "error", "msg": f"无权分配以下权限：{', '.join(invalid)}"})
        permissions = [p for p in permissions if p in user_perms]

    conn = get_db_connection()
    try:
        # 检查重名
        exist = conn.execute("SELECT id FROM roles WHERE name=%s", (name,)).fetchone()
        if exist:
            return jsonify({"status": "error", "msg": "角色名称已存在"})

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cur = conn.execute(
            "INSERT INTO roles (name, description, is_system) VALUES (%s, %s, 0)",
            (name, description)
        )
        conn.commit()
        # 获取新角色 id
        new_id = conn.execute("SELECT id FROM roles WHERE name=%s", (name,)).fetchone()["id"]

        # 绑定权限
        for pc in permissions:
            conn.execute(
                "INSERT INTO role_permissions (role_id, permission_code) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (new_id, pc)
            )
        conn.commit()
        op_log(f"新增角色：{name}（ID={new_id}）")
        return jsonify({"status": "success", "id": new_id})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "msg": str(e)})
    finally:
        conn.close()


# ===================== 更新角色权限 =====================
@role_bp.route('/api/roles/update', methods=['POST'])
@login_required
@require_permission("user.manage")
def update_role():
    data = request.json
    role_id = data.get("id")
    name = data.get("name", "").strip()
    description = data.get("description", "").strip()
    permissions = data.get("permissions", [])

    if not role_id:
        return jsonify({"status": "error", "msg": "角色ID不能为空"})
    if not name:
        return jsonify({"status": "error", "msg": "角色名称不能为空"})
    if not isinstance(permissions, list):
        return jsonify({"status": "error", "msg": "permissions 格式错误"})

    conn = get_db_connection()
    try:
        role = conn.execute("SELECT id, name, is_system FROM roles WHERE id=%s", (role_id,)).fetchone()
        if not role:
            return jsonify({"status": "error", "msg": "角色不存在"})

        # ⚠️ 系统内置角色（is_system）只能由 super 编辑
        if role["is_system"] and not g.user.get("is_super"):
            return jsonify({"status": "error", "msg": "系统内置角色仅超级管理员可编辑"}), 403

        # 重名检查（排除自己）
        exist = conn.execute(
            "SELECT id FROM roles WHERE name=%s AND id!=%s",
            (name, role_id)
        ).fetchone()
        if exist:
            return jsonify({"status": "error", "msg": "角色名称已被其他角色使用"})

        # 更新基本信息
        conn.execute(
            "UPDATE roles SET name=%s, description=%s WHERE id=%s",
            (name, description, role_id)
        )

        # ⚠️ 非 super：保留自己没有的权限，只允许增减自己拥有的
        if not g.user.get("is_super"):
            user_perms = get_user_permissions(g.user["username"])
            current_perms = [r["permission_code"] for r in conn.execute(
                "SELECT permission_code FROM role_permissions WHERE role_id=%s", (role_id,)
            ).fetchall()]
            # 保留 admin 没有的权限（不能删也不能加）
            preserved = [p for p in current_perms if p not in user_perms]
            # 合并：admin 提交的自己拥有的 + 从DB保留的admin没有的
            permissions = preserved + [p for p in permissions if p in user_perms]

        # 全量替换权限
        conn.execute("DELETE FROM role_permissions WHERE role_id=%s", (role_id,))
        for pc in permissions:
            conn.execute(
                "INSERT INTO role_permissions (role_id, permission_code) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (role_id, pc)
            )
        conn.commit()
        op_log(f"更新角色：{name}（ID={role_id}）")
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "msg": str(e)})
    finally:
        conn.close()


# ===================== 删除角色 =====================
@role_bp.route('/api/roles/del', methods=['POST'])
@login_required
@require_permission("user.manage")
def delete_role():
    data = request.json
    role_id = data.get("id")

    if not role_id:
        return jsonify({"status": "error", "msg": "角色ID不能为空"})

    conn = get_db_connection()
    try:
        role = conn.execute("SELECT id, name, is_system FROM roles WHERE id=%s", (role_id,)).fetchone()
        if not role:
            return jsonify({"status": "error", "msg": "角色不存在"})
        if role["is_system"]:
            return jsonify({"status": "error", "msg": f"「{role['name']}」为系统内置角色，不可删除"})

        # 检查是否有用户正在使用此角色
        user_cnt = conn.execute(
            "SELECT COUNT(*) AS cnt FROM users WHERE role_id=%s",
            (role_id,)
        ).fetchone()
        if user_cnt and user_cnt["cnt"] > 0:
            return jsonify({
                "status": "error",
                "msg": f"该角色下还有 {user_cnt['cnt']} 个用户，请先迁移用户后再删除"
            })

        conn.execute("DELETE FROM role_permissions WHERE role_id=%s", (role_id,))
        conn.execute("DELETE FROM roles WHERE id=%s", (role_id,))
        conn.commit()
        op_log(f"删除角色：{role['name']}（ID={role_id}）")
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "msg": str(e)})
    finally:
        conn.close()
