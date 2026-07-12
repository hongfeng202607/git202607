# ===================== 分类管理 =====================
from flask import Blueprint, request, jsonify

from .db import get_db_connection, op_log
from .auth import login_required, require_permission

category_bp = Blueprint('category', __name__)

# ===================== 获取全部分类 =====================
@category_bp.route('/get_cate', methods=['GET'])
@login_required
def get_cate():
    with get_db_connection() as conn:
        rows = conn.execute("SELECT name FROM category_config ORDER BY id").fetchall()
    cates = [r["name"] for r in rows]
    if not cates:
        cates = ["其他"]
    return jsonify(cates)

# ===================== 保存分类 =====================
@category_bp.route('/save_cate', methods=['POST'])
@login_required
@require_permission("category.manage")
def save_cate():
    """保存用户自定义的分类列表"""
    data = request.json
    new_list = data.get("list", [])
    if not isinstance(new_list, list) or len(new_list) == 0:
        return jsonify({"status": "error", "msg": "数据格式错误"})

    try:
        with get_db_connection() as conn:
            # 获取当前 category_config 中的所有分类
            old_rows = conn.execute("SELECT name FROM category_config").fetchall()
            old_names = set(r["name"] for r in old_rows)
            new_names = set(new_list)

            # 被用户删除的分类 → 检查是否有知识记录正在使用
            removed = old_names - new_names
            for c in removed:
                cnt = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM operation_records WHERE category=%s AND recycle_status='正常'",
                    (c,)
                ).fetchone()
                if cnt and cnt["cnt"] > 0:
                    return jsonify({
                        "status": "error",
                        "msg": f"分类「{c}」已被 {cnt['cnt']} 条知识记录使用，请先将这些记录迁移到其他分类后再删除"
                    })

            # 全量替换 category_config（被删的分类已确认无记录使用，直接移除即可）
            conn.execute("DELETE FROM category_config")
            for i, name in enumerate(new_list):
                conn.execute(
                    "INSERT INTO category_config (id, name) VALUES (%s, %s)",
                    (i + 1, name)
                )
        op_log(f"分类配置已更新（共{len(new_list)}个分类）")
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "msg": str(e)})
