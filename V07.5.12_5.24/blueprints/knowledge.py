# ===================== 知识记录 CRUD =====================
import re
import json
import difflib
import os
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify, current_app, g

from .db import get_db_connection, sync_all_categories, op_log, auto_backup_database, build_data_perm_where, tokenize_keywords, build_like_conditions, ensure_category
from .auth import login_required, require_permission

knowledge_bp = Blueprint('knowledge', __name__)

# ===================== DEBUG 测试 =====================
@knowledge_bp.route('/debug_backup', methods=['GET'])
def debug_backup():
    from .db import auto_backup_database, op_log
    print("[DEBUG] /debug_backup called")
    op_log("手动测试备份")
    auto_backup_database()
    return jsonify({"status": "ok"})

# ===================== 知识查询 =====================
@knowledge_bp.route('/search', methods=['POST'])
@login_required
def search():
    data = request.json
    key = data.get("keyword", "").strip()
    cate = data.get("cate", "全部")
    startDate = data.get("startDate", "").strip()
    endDate = data.get("endDate", "").strip()
    page = data.get("page", 1)
    pageSize = data.get("pageSize", 20)

    with get_db_connection() as conn:
        where = " WHERE recycle_status='正常'"
        params = []

        # 数据权限过滤
        where, params = build_data_perm_where(conn, g.user["username"], where, params)

        if cate != "全部":
            where += " AND category=%s"
            params.append(cate)

        if key:
            if key.isdigit():
                where += " AND id=%s"
                params.append(int(key))
            else:
                # 分词搜索（使用公共分词函数）
                keywords = tokenize_keywords(key)

                conditions_str, like_params = build_like_conditions(
                    keywords,
                    ["question", "solution", "remark", "submitter", "proposer"]
                )
                where += " AND (" + conditions_str + ")"
                params.extend(like_params)

                # 取全部匹配记录，按加权评分（标题0.6+内容0.4）排序，再分页
                date_where = ""
                date_params = []
                if startDate:
                    date_where += " AND substr(record_time, 1, 4) || '-' || substr(record_time, 6, 2) || '-' || substr(record_time, 9, 2) >= %s"
                    date_params.append(startDate)
                if endDate:
                    date_where += " AND substr(record_time, 1, 4) || '-' || substr(record_time, 6, 2) || '-' || substr(record_time, 9, 2) <= %s"
                    date_params.append(endDate)
                all_rows = conn.execute("SELECT * FROM operation_records" + where + date_where, params + date_params).fetchall()
                candidates = [dict(r) for r in all_rows]
                for c in candidates:
                    title = (c['question'] or '').strip()
                    content = ((c['solution'] or '') + ' ' + (c['remark'] or '')).strip()
                    title_score = difflib.SequenceMatcher(None, key, title).ratio() if title else 0
                    content_score = difflib.SequenceMatcher(None, key, content).ratio() if content else 0
                    hit_count = sum(1 for w in keywords if len(w) >= 2 and (w in title or w in content))
                    c['_score'] = title_score * 0.6 + content_score * 0.4 + hit_count * 50 + (100 if c['is_important'] else 0)
                candidates.sort(key=lambda c: c['_score'], reverse=True)

                total = len(candidates)
                page_rows = candidates[(page - 1) * pageSize : page * pageSize]
                page_ids = [r["id"] for r in page_rows]

                # 批量查询附件状态（修复 N+1）
                attach_ids = set()
                if page_ids:
                    placeholders = ",".join(["%s"] * len(page_ids))
                    attach_rows = conn.execute(
                        "SELECT DISTINCT knowledge_id FROM attachments WHERE knowledge_id IN (" + placeholders + ")",
                        page_ids
                    ).fetchall()
                    attach_ids = set(r["knowledge_id"] for r in attach_rows)

                result = []
                for item in page_rows:
                    item["has_attachment"] = item["id"] in attach_ids
                    result.append({k: v for k, v in item.items() if k != '_score'})
                return jsonify({"records": result, "total": total})

        if startDate:
            where += " AND substr(record_time, 1, 4) || '-' || substr(record_time, 6, 2) || '-' || substr(record_time, 9, 2) >= %s"
            params.append(startDate)
        if endDate:
            where += " AND substr(record_time, 1, 4) || '-' || substr(record_time, 6, 2) || '-' || substr(record_time, 9, 2) <= %s"
            params.append(endDate)

        count_sql = "SELECT COUNT(*) FROM operation_records" + where
        total = conn.execute(count_sql, params).fetchone()['count']

        sql = "SELECT * FROM operation_records" + where + " ORDER BY id DESC LIMIT %s OFFSET %s"
        page_params = params + [pageSize, (page - 1) * pageSize]
        rows = conn.execute(sql, page_params).fetchall()

        # 批量查询附件状态（修复 N+1）
        page_ids = [r["id"] for r in rows]
        attach_ids = set()
        if page_ids:
            placeholders = ",".join(["%s"] * len(page_ids))
            attach_rows = conn.execute(
                "SELECT DISTINCT knowledge_id FROM attachments WHERE knowledge_id IN (" + placeholders + ")",
                page_ids
            ).fetchall()
            attach_ids = set(r["knowledge_id"] for r in attach_rows)

        result = []
        for r in rows:
            item = dict(r)
            item["has_attachment"] = item["id"] in attach_ids
            result.append(item)
        return jsonify({"records": result, "total": total})

# ===================== 新增知识 =====================
@knowledge_bp.route('/add', methods=['POST'])
@login_required
@require_permission("knowledge.add")
def add():
    data = request.json
    category = data.get("cate", "").strip()
    proposer = data.get("proposer", "").strip()
    question = data.get("question", "").strip()
    solution = data.get("solution", "").strip()
    remark = data.get("remark", "").strip()
    if not question or not solution:
        return jsonify({"status": "error", "msg": "请填写完整"})
    now = datetime.now().strftime("%Y年%m月%d日 %H时%M分%S秒")
    # submitter 自动填当前登录用户
    creator = g.user["username"]
    with get_db_connection() as conn:
        cursor = conn.execute('''
        INSERT INTO operation_records
        (category, submitter, question, solution, remark, record_time, proposer)
        VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id
        ''', (category, creator, question, solution, remark, now, proposer))
        new_id = cursor.fetchone()["id"]
        conn.commit()
    ensure_category(category)
    title_short = question[:20] + ('...' if len(question) > 20 else '')
    op_log(f"新增知识「{title_short}」→ {category or '未分类'}（ID={new_id}）")
    return jsonify({"status": "success", "id": new_id})

# ===================== 查重接口 =====================
@knowledge_bp.route('/api/check_duplicate', methods=['POST'])
@login_required
def check_duplicate():
    data = request.json
    question = data.get("question", "").strip()
    solution = data.get("solution", "").strip()
    threshold = float(data.get("threshold", 0.30))
    modes = data.get("modes", ["title"])
    if not question:
        return jsonify({"status": "error", "msg": "请填写标题"})

    if not modes or not isinstance(modes, list) or len(modes) == 0:
        return jsonify({"status": "success", "duplicates": [], "high_warning_count": 0, "total_found": 0})

    with get_db_connection() as conn:
        base_where = " WHERE recycle_status='正常'"
        dp_where, dp_params = build_data_perm_where(conn, g.user["username"], base_where, [])
        # 限制扫描最近 500 条，避免全表扫描 + Python difflib 比对的性能问题
        rows = conn.execute(
            "SELECT id, question, solution FROM operation_records" + dp_where
            + " ORDER BY id DESC LIMIT 500",
            dp_params
        ).fetchall()

    result_map = {}

    for mode in modes:
        if mode == "title_content":
            new_text = (question + " " + solution).strip()
        else:
            new_text = question

        for row in rows:
            if mode == "title_content":
                existing_text = ((row["question"] or "") + " " + (row["solution"] or "")).strip()
            else:
                existing_text = (row["question"] or "").strip()
            if not existing_text:
                continue

            ratio = difflib.SequenceMatcher(None, new_text, existing_text).ratio()
            if ratio >= threshold:
                rid = row["id"]
                sim = round(ratio * 100, 1)
                if rid not in result_map or sim > result_map[rid]["similarity"]:
                    solution_preview = (row["solution"] or "")
                    if len(solution_preview) > 200:
                        solution_preview = solution_preview[:200] + "..."
                    result_map[rid] = {
                        "id": rid,
                        "question": row["question"] or "",
                        "solution": solution_preview,
                        "similarity": sim
                    }

    results = list(result_map.values())
    results.sort(key=lambda x: x["similarity"], reverse=True)

    high_warn = [r for r in results if r["similarity"] >= 80]

    return jsonify({
        "status": "success",
        "duplicates": results,
        "high_warning_count": len(high_warn),
        "total_found": len(results)
    })

# ===================== 删除（移入回收站） =====================
@knowledge_bp.route('/del', methods=['POST'])
@login_required
@require_permission("knowledge.delete")
def delete():
    id_param = request.json.get("id")
    print(f"[DEBUG] delete() called, id={id_param}")
    with get_db_connection() as conn:
        # 先查记录是否存在且正常
        row = conn.execute(
            "SELECT id, recycle_status, question, category FROM operation_records WHERE id=%s",
            (id_param,)
        ).fetchone()
        if not row:
            return jsonify({"status": "error", "msg": f"记录ID={id_param} 不存在"})
        if row["recycle_status"] == "回收站":
            return jsonify({"status": "error", "msg": f"记录ID={id_param} 已在回收站中"})
        title_short = (row["question"] or "")[:20] + ('...' if len(row["question"] or "") > 20 else '')
        cate = row["category"] or "未分类"
        conn.execute(
            "UPDATE operation_records SET recycle_status='回收站' WHERE id=%s",
            (id_param,)
        )
        conn.commit()
    op_log(f"移入回收站「{title_short}」→ {cate}（ID={id_param}）")
    auto_backup_database()
    return jsonify({"status": "success"})

# ===================== 编辑 =====================
@knowledge_bp.route('/edit', methods=['POST'])
@login_required
@require_permission("knowledge.edit")
def edit():
    data = request.json
    id = data.get("id")
    category = data.get("cate", "").strip()
    proposer = data.get("proposer", "").strip()
    question = data.get("question", "").strip()
    solution = data.get("solution", "").strip()
    remark = data.get("remark", "").strip()
    if not question or not solution:
        return jsonify({"status": "error", "msg": "请填写完整"})
    with get_db_connection() as conn:
        # 检查记录是否存在
        row = conn.execute("SELECT id FROM operation_records WHERE id=%s", (id,)).fetchone()
        if not row:
            return jsonify({"status": "error", "msg": f"记录 ID={id} 不存在"})
        conn.execute('''
        UPDATE operation_records
        SET category=%s, proposer=%s, question=%s, solution=%s, remark=%s
        WHERE id=%s
        ''', (category, proposer, question, solution, remark, id))
        conn.commit()
    ensure_category(category)
    title_short = question[:20] + ('...' if len(question) > 20 else '')
    op_log(f"编辑知识「{title_short}」→ {category or '未分类'}（ID={id}）")
    auto_backup_database()
    return jsonify({"status": "success"})

# ===================== 回收站 =====================
@knowledge_bp.route('/get_recycle', methods=['POST'])
@login_required
@require_permission("recycle.view")
def get_recycle():
    with get_db_connection() as conn:
        where = " WHERE recycle_status='回收站'"
        params = []
        where, params = build_data_perm_where(conn, g.user["username"], where, params)
        rows = conn.execute("SELECT * FROM operation_records" + where + " ORDER BY id DESC", params).fetchall()
    return jsonify([dict(r) for r in rows])

@knowledge_bp.route('/restore_recycle', methods=['POST'])
@login_required
@require_permission("recycle.restore")
def restore_recycle():
    id = request.json.get("id")
    with get_db_connection() as conn:
        row = conn.execute("SELECT question, category FROM operation_records WHERE id=%s", (id,)).fetchone()
        conn.execute("UPDATE operation_records SET recycle_status='正常' WHERE id=%s", (id,))
        conn.commit()
    title_short = (row["question"] or "")[:20] + ('...' if len(row["question"] or "") > 20 else '') if row else ""
    cate = row["category"] or "未分类" if row else "未分类"
    op_log(f"恢复记录「{title_short}」→ {cate}（ID={id}）")
    return jsonify({})

@knowledge_bp.route('/delete_permanent', methods=['POST'])
@login_required
@require_permission("knowledge.permanent_del")
def delete_permanent():
    id = request.json.get("id")
    try:
        with get_db_connection() as conn:
            # 先查标题用于日志
            old_row = conn.execute("SELECT question, category FROM operation_records WHERE id=%s", (id,)).fetchone()
            title_short = (old_row["question"] or "")[:20] + ('...' if len(old_row["question"] or "") > 20 else '') if old_row else ""
            cate = old_row["category"] or "未分类" if old_row else "未分类"
            attaches = conn.execute("SELECT save_name FROM attachments WHERE knowledge_id=%s", (id,)).fetchall()
            for att in attaches:
                fpath = os.path.join(current_app.config['UPLOAD_FOLDER'], att["save_name"])
                if os.path.exists(fpath):
                    os.remove(fpath)
            conn.execute("DELETE FROM attachments WHERE knowledge_id=%s", (id,))
            conn.execute("DELETE FROM operation_records WHERE id=%s", (id,))
            conn.commit()
        op_log(f"永久删除「{title_short}」→ {cate}（ID={id}）")
    except Exception as e:
        op_log(f"永久删除失败：{str(e)}")
    auto_backup_database()
    return jsonify({})

# ===================== 搜索建议 =====================
@knowledge_bp.route('/api/suggest', methods=['GET'])
@login_required
def api_suggest():
    q = request.args.get('q', '')
    if not q:
        return jsonify([])
    with get_db_connection() as conn:
        where = " WHERE recycle_status='正常'"
        params = []
        where, params = build_data_perm_where(conn, g.user["username"], where, params)
        q_condition = " AND question LIKE %s"
        rows = conn.execute(
            'SELECT id, question FROM operation_records' + where + q_condition + ' ORDER BY id DESC LIMIT 6',
            params + [f'%{q}%']
        ).fetchall()
    return jsonify([{"id": r["id"], "question": r["question"]} for r in rows])

# ===================== 搜索日志 =====================
@knowledge_bp.route('/api/log_search', methods=['POST'])
@login_required
def log_search():
    key = request.json.get('keyword', '').strip()
    if not key:
        return jsonify({"status": "ok"})
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        with get_db_connection() as conn:
            exist = conn.execute('SELECT id FROM search_history WHERE keyword=%s', (key,)).fetchone()
            if exist:
                conn.execute('UPDATE search_history SET count=count+1, last_time=%s WHERE keyword=%s', (now, key))
            else:
                conn.execute('INSERT INTO search_history (keyword, last_time) VALUES (%s, %s)', (key, now))
            conn.commit()
        return jsonify({"status": "ok"})
    except:
        return jsonify({"status": "error"})

# ===================== 本周新增数量 =====================
@knowledge_bp.route('/api/weekly_added_count', methods=['GET'])
@login_required
def get_weekly_added_count():
    now = datetime.now()
    week_start = now - timedelta(days=now.weekday())
    week_start = week_start.strftime("%Y-%m-%d %H:%M:%S")

    with get_db_connection() as conn:
        where = " WHERE record_time >= %s"
        params = [week_start]
        # 不限制 recycle_status，统计所有新增
        count = conn.execute('SELECT COUNT(*) FROM operation_records' + where, params).fetchone()['count']
    return jsonify({"status": "success", "count": count})

# ===================== 统计数据 =====================
@knowledge_bp.route('/api/stat_counts', methods=['GET'])
@login_required
def get_stat_counts():
    now = datetime.now()
    week_start = (now - timedelta(days=now.weekday())).strftime("%Y年%m月%d日")
    month_start = now.strftime("%Y年%m月") + "01日"
    cate = request.args.get('cate', '')

    with get_db_connection() as conn:
        # 数据权限过滤
        dp_base = " WHERE recycle_status='正常'"
        dp_params = []
        dp_where, dp_params = build_data_perm_where(conn, g.user["username"], dp_base, dp_params)

        if cate and cate != '全部':
            cate_where = dp_where + " AND category=%s"
            cate_params = dp_params + [cate]
            total = conn.execute(
                "SELECT COUNT(*) FROM operation_records" + cate_where,
                cate_params
            ).fetchone()['count']
            weekly = conn.execute(
                "SELECT COUNT(*) FROM operation_records" + cate_where + " AND record_time >= %s",
                cate_params + [week_start]
            ).fetchone()['count']
            monthly = conn.execute(
                "SELECT COUNT(*) FROM operation_records" + cate_where + " AND record_time >= %s",
                cate_params + [month_start]
            ).fetchone()['count']
        else:
            total = conn.execute("SELECT COUNT(*) FROM operation_records" + dp_where, dp_params).fetchone()['count']
            weekly = conn.execute("SELECT COUNT(*) FROM operation_records" + dp_where + " AND record_time >= %s", dp_params + [week_start]).fetchone()['count']
            monthly = conn.execute("SELECT COUNT(*) FROM operation_records" + dp_where + " AND record_time >= %s", dp_params + [month_start]).fetchone()['count']

    return jsonify({
        "status": "success",
        "total": total,
        "weekly": weekly,
        "monthly": monthly
    })

# ===================== 仪表盘数据 =====================
@knowledge_bp.route('/api/dashboard', methods=['GET'])
@login_required
def get_dashboard():
    now = datetime.now()
    with get_db_connection() as conn:
        dp_base = " WHERE recycle_status='正常'"
        dp_params = []
        dp_where, dp_params = build_data_perm_where(conn, g.user["username"], dp_base, dp_params)

        # 1. 分类分布
        rows = conn.execute(
            "SELECT category, COUNT(*) as cnt FROM operation_records" + dp_where + " GROUP BY category ORDER BY cnt DESC",
            dp_params
        ).fetchall()
        categories = [{"name": r["category"] or "未分类", "count": r["cnt"]} for r in rows]

        # 2. 最近7天趋势
        trend = []
        for i in range(6, -1, -1):
            d = (now - timedelta(days=i)).strftime("%Y-%m-%d")
            d_cn = (now - timedelta(days=i)).strftime("%Y年%m月%d日")
            cnt = conn.execute(
                "SELECT COUNT(*) as c FROM operation_records" + dp_where + " AND record_time >= %s AND record_time < %s",
                dp_params + [d_cn, (now - timedelta(days=i-1)).strftime("%Y年%m月%d日")] if i > 0 else dp_params + [d_cn, (now + timedelta(days=1)).strftime("%Y年%m月%d日")]
            ).fetchone()['c']
            trend.append({"date": d, "count": cnt})

        # 3. 最近8条业务动态（白名单过滤）
        recent = []
        # 业务事件白名单关键词
        activity_whitelist = [
            '新增知识', '编辑知识', '移入回收站', '恢复记录', '永久删除',
            '批量导入', '清空所有知识',
            '用户登录', '用户登出',
            '从备份恢复',
            '新增角色', '更新角色', '删除角色', '修改用户',
            '分类配置已更新',
            '数据权限开关', '更新数据权限授权',
            'AI解析成功',
        ]
        log_path = os.path.join(current_app.instance_path, 'server.log') if hasattr(current_app, 'instance_path') else os.path.join(os.path.dirname(os.path.dirname(__file__)), 'server.log')
        if not os.path.exists(log_path):
            log_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'server.log')
        if os.path.exists(log_path):
            try:
                with open(log_path, 'r', encoding='utf-8', errors='ignore') as f:
                    lines = f.readlines()[-500:]
                for line in reversed(lines):
                    if '【操作日志】' not in line:
                        continue
                    m = re.search(r'【操作日志】(\d{4}[-\d]+\s+\d{2}[:\d]+)\s*\[([^\]]*)\]\s*(.*)', line)
                    if not m:
                        continue
                    content = m.group(3).strip()
                    # 白名单过滤
                    if not any(kw in content for kw in activity_whitelist):
                        continue
                    # 解析动作类型
                    action_type = 'other'
                    action_icon = '●'
                    action_color = '#86909c'
                    if '新增知识' in content:
                        action_type, action_icon, action_color = 'add', '+', '#0fc6c2'
                    elif '编辑知识' in content:
                        action_type, action_icon, action_color = 'edit', '~', '#165DFF'
                    elif '移入回收站' in content:
                        action_type, action_icon, action_color = 'delete', '×', '#e24b4a'
                    elif '永久删除' in content:
                        action_type, action_icon, action_color = 'perm_del', '×', '#e24b4a'
                    elif '恢复记录' in content:
                        action_type, action_icon, action_color = 'restore', '↻', '#0fc6c2'
                    elif '批量导入' in content:
                        action_type, action_icon, action_color = 'import', '↑', '#9f7aea'
                    elif '清空所有知识' in content:
                        action_type, action_icon, action_color = 'clear', '!', '#f9ab00'
                    elif '用户登录' in content:
                        action_type, action_icon, action_color = 'login', '→', '#165DFF'
                    elif '用户登出' in content:
                        action_type, action_icon, action_color = 'logout', '←', '#86909c'
                    elif '从备份恢复' in content:
                        action_type, action_icon, action_color = 'restore_backup', '↻', '#f9ab00'
                    elif '新增角色' in content or '更新角色' in content or '删除角色' in content:
                        action_type, action_icon, action_color = 'role', '♦', '#9f7aea'
                    elif '修改用户' in content:
                        action_type, action_icon, action_color = 'role', '♦', '#9f7aea'
                    elif '分类配置' in content:
                        action_type, action_icon, action_color = 'config', '☰', '#86909c'
                    elif '数据权限' in content:
                        action_type, action_icon, action_color = 'config', '☰', '#86909c'
                    elif 'AI解析成功' in content:
                        action_type, action_icon, action_color = 'ai', '✦', '#9f7aea'
                    recent.append({
                        "time": m.group(1),
                        "user": m.group(2),
                        "content": content,
                        "action_type": action_type,
                        "action_icon": action_icon,
                        "action_color": action_color,
                    })
                    if len(recent) >= 8:
                        break
            except Exception:
                pass

        # 4. 星标数
        star_count = conn.execute(
            "SELECT COUNT(*) as c FROM operation_records" + dp_where + " AND is_important=1",
            dp_params
        ).fetchone()['c']

    return jsonify({
        "status": "success",
        "categories": categories,
        "trend": trend,
        "recent": recent,
        "star_count": star_count
    })

# ===================== 标星切换 =====================
@knowledge_bp.route('/api/toggle_star/<int:id>', methods=['POST'])
@login_required
def toggle_star(id):
    with get_db_connection() as conn:
        row = conn.execute("SELECT is_important FROM operation_records WHERE id=%s", (id,)).fetchone()
        if not row:
            return jsonify({"status": "error", "message": "记录不存在"}), 404
        new_val = 0 if row["is_important"] else 1
        conn.execute("UPDATE operation_records SET is_important=%s WHERE id=%s", (new_val, id))
    return jsonify({"status": "success", "is_important": new_val})
