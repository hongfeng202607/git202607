# ===================== 附件管理 =====================
import os
from datetime import datetime
from flask import Blueprint, request, jsonify, send_from_directory, current_app

from .db import get_db_connection, allowed_file, op_log
from .auth import login_required, require_permission

attachment_bp = Blueprint('attachment', __name__)

# ===================== 上传附件 =====================
@attachment_bp.route('/upload', methods=['POST'])
@login_required
@require_permission("attachment.upload")
def upload_file():
    if 'file' not in request.files:
        return jsonify({"status": "error", "msg": "没有文件"})
    file = request.files['file']
    if file.filename == '':
        return jsonify({"status": "error", "msg": "未选择文件"})
    if file and allowed_file(file.filename):
        import uuid
        ext = file.filename.rsplit('.', 1)[1].lower()
        save_name = str(uuid.uuid4()) + "." + ext
        upload_folder = current_app.config['UPLOAD_FOLDER']
        file.save(os.path.join(upload_folder, save_name))
        return jsonify({
            "status": "success",
            "origin_name": file.filename,
            "save_name": save_name,
            "file_ext": ext
        })
    else:
        return jsonify({"status": "error", "msg": "不支持的文件类型"})

# ===================== 下载附件 =====================
@attachment_bp.route('/download/<save_name>')
@login_required
def download_file(save_name):
    try:
        with get_db_connection() as conn:
            row = conn.execute(
                "SELECT origin_name FROM attachments WHERE save_name=%s",
                (save_name,)
            ).fetchone()
            origin_name = row["origin_name"] if row else save_name
        # 脱敏文件名：移除 CRLF 防止 HTTP 头注入
        safe_name = origin_name.replace('\r', '').replace('\n', '')
        return send_from_directory(
            current_app.config['UPLOAD_FOLDER'],
            save_name,
            as_attachment=True,
            download_name=safe_name
        )
    except Exception as e:
        return "文件不存在", 404

# ===================== 绑定附件到知识记录 =====================
@attachment_bp.route('/bind_attachment', methods=['POST'])
@login_required
@require_permission("attachment.upload")
def bind_attachment():
    data = request.form
    knowledge_id = data.get("knowledge_id")
    origin_name = data.get("origin_name")
    save_name = data.get("save_name")
    file_ext = data.get("file_ext")
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_db_connection() as conn:
        conn.execute('''
            INSERT INTO attachments (knowledge_id, origin_name, save_name, file_ext, create_time)
            VALUES (%s, %s, %s, %s, %s)
        ''', (knowledge_id, origin_name, save_name, file_ext, now))
        conn.commit()
    return jsonify({"status": "success"})

# ===================== 获取附件列表 =====================
@attachment_bp.route('/get_attachments', methods=['GET'])
@login_required
def get_attachments():
    knowledge_id = request.args.get("knowledge_id")
    with get_db_connection() as conn:
        rows = conn.execute("SELECT * FROM attachments WHERE knowledge_id=%s", (knowledge_id,)).fetchall()
    return jsonify([dict(r) for r in rows])

# ===================== 删除附件 =====================
@attachment_bp.route('/del_attachment', methods=['POST'])
@login_required
@require_permission("attachment.delete")
def del_attachment():
    data = request.json
    attach_id = data.get("id")
    with get_db_connection() as conn:
        attach = conn.execute("SELECT * FROM attachments WHERE id=%s", (attach_id,)).fetchone()
        if attach:
            fpath = os.path.join(current_app.config["UPLOAD_FOLDER"], attach["save_name"])
            if os.path.exists(fpath):
                os.remove(fpath)
            conn.execute("DELETE FROM attachments WHERE id=%s", (attach_id,))
            conn.commit()
    return jsonify({"status": "success"})
