# ===================== AI 功能 =====================
import re
import json
import difflib
import requests
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify, g

from .db import get_db_connection, get_ai_config, op_log, build_data_perm_where, tokenize_keywords, build_like_conditions
from .auth import login_required, require_permission, super_admin_required

ai_bp = Blueprint('ai', __name__)

# ===================== AI配置管理（仅超级管理员） =====================
@ai_bp.route('/api/admin/ai_config', methods=['GET'])
@login_required
@super_admin_required
@require_permission("ai.manage")
def get_ai_config_api():
    cfg = get_ai_config()
    key_raw = cfg["key"]
    if key_raw and len(key_raw) > 8:
        masked = key_raw[:4] + "****" + key_raw[-4:]
    elif key_raw:
        masked = key_raw[:2] + "****" + key_raw[-2:]
    else:
        masked = ""
    return jsonify({
        "status": "success",
        "url": cfg["url"],
        "key": masked,
        "key_exists": bool(cfg["key"]),
        "model": cfg["model"]
    })

@ai_bp.route('/api/admin/ai_config', methods=['POST'])
@login_required
@super_admin_required
@require_permission("ai.manage")
def set_ai_config_api():
    data = request.json
    url = data.get("url", "").strip()
    key = data.get("key", "").strip()
    model = data.get("model", "").strip()
    if not url or not model:
        return jsonify({"status": "error", "msg": "API地址和模型名称不能为空"})
    with get_db_connection() as conn:
        conn.execute(
            "INSERT INTO sys_config (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            ("ai_api_url", url)
        )
        if key:
            conn.execute(
                "INSERT INTO sys_config (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                ("ai_api_key", key)
            )
        conn.execute(
            "INSERT INTO sys_config (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            ("ai_model", model)
        )
        conn.commit()
    op_log(f"AI配置已更新：URL={url}, Model={model}")
    return jsonify({"status": "success", "msg": "AI配置已保存"})

@ai_bp.route('/api/admin/ai_config/test', methods=['POST'])
@login_required
@super_admin_required
@require_permission("ai.manage")
def test_ai_config_api():
    """测试AI连接：先保存配置→再从数据库读取测试，并校验返回体是合法JSON"""
    data = request.json or {}
    url = data.get("url", "").strip()
    key = data.get("key", "").strip()
    model = data.get("model", "").strip()

    # 先保存到数据库
    if url and model:
        with get_db_connection() as conn:
            conn.execute(
                "INSERT INTO sys_config (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                ("ai_api_url", url)
            )
            if key:
                conn.execute(
                    "INSERT INTO sys_config (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                    ("ai_api_key", key)
                )
            conn.execute(
                "INSERT INTO sys_config (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                ("ai_model", model)
            )
            conn.commit()

    # 从数据库读取配置
    cfg = get_ai_config()
    url = cfg["url"]
    key = cfg["key"]
    model = cfg["model"]

    if not url or not model:
        return jsonify({"status": "error", "msg": "API地址和模型名称不能为空"})
    if not key:
        return jsonify({"status": "error", "msg": "API Key 未配置，无法测试"})

    try:
        payload = {
            "model": model,
            "messages": [
                {"role": "user", "content": "回复OK即可"}
            ],
            "temperature": 0.1,
            "max_tokens": 10
        }
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json"
        }
        resp = requests.post(url, json=payload, headers=headers, timeout=10)

        try:
            result = resp.json()
        except Exception:
            preview = resp.text[:200]
            op_log(f"AI连接测试失败：URL={url} 返回非JSON内容（可能是网页），前200字符: {preview}")
            return jsonify({
                "status": "error",
                "msg": f"❌ API 返回的不是 JSON 格式，请检查 API 地址是否正确\n返回内容预览：{preview}"
            })

        try:
            content = result["choices"][0]["message"]["content"]
            op_log(f"AI连接测试成功：URL={url}, Model={model}")
            return jsonify({"status": "success", "msg": "✅ 连接成功！API 正常响应（配置已保存）"})
        except (KeyError, IndexError, TypeError):
            preview = json.dumps(result, ensure_ascii=False)[:200]
            op_log(f"AI连接测试失败：URL={url} 返回JSON结构不匹配，内容: {preview}")
            return jsonify({
                "status": "error",
                "msg": f"❌ API 返回格式异常，未找到 choices[0].message.content\n返回内容预览：{preview}"
            })

    except requests.Timeout:
        return jsonify({"status": "error", "msg": "⏱️ 请求超时，请检查 API 地址和网络"})
    except requests.ConnectionError:
        return jsonify({"status": "error", "msg": "🔌 无法连接，请检查 API 地址是否正确"})
    except Exception as e:
        return jsonify({"status": "error", "msg": f"❌ {str(e)[:100]}"})

# ===================== 语义搜索（AI问答） =====================
@ai_bp.route('/api/semantic_search', methods=['POST'])
@login_required
@require_permission("ai.use")
def semantic_search():
    data = request.json
    query = data.get("keyword", "").strip()
    if not query:
        return jsonify({"records": [], "answer": "", "total": 0})

    with get_db_connection() as conn:
        # 分词搜索（使用公共分词函数）
        words = tokenize_keywords(query)
        conditions_str, params = build_like_conditions(
            words,
            ["question", "solution", "remark", "proposer"]
        )

        # 数据权限过滤
        base_where = " WHERE recycle_status='正常' AND ({})".format(conditions_str)
        dp_where, dp_params = build_data_perm_where(conn, g.user["username"], base_where, params)

        sql = "SELECT id, category, question, solution, remark, record_time, submitter, proposer, is_important FROM operation_records" + dp_where
        rows = conn.execute(sql, dp_params).fetchall()
        candidates = [dict(r) for r in rows]

        # 按相似度排序：标题权重0.6 + 核心内容权重0.4 + 关键词命中数加权
        for c in candidates:
            title = (c['question'] or '').strip()
            content = ((c['solution'] or '') + ' ' + (c['remark'] or '')).strip()
            title_score = difflib.SequenceMatcher(None, query, title).ratio() if title else 0
            content_score = difflib.SequenceMatcher(None, query, content).ratio() if content else 0
            hit_count = sum(1 for w in words if len(w) >= 2 and (w in title or w in content))
            c['_score'] = title_score * 0.6 + content_score * 0.4 + hit_count * 50
        candidates.sort(key=lambda c: c['_score'], reverse=True)

        # 也保留记录列表给前端展示（按相似度排序）
        records_for_display = [{k: v for k, v in c.items() if k != '_score'} for c in candidates]

        # AI 问答（无论有无匹配记录都调用，无记录时AI凭自身知识回答）
        ai_cfg = get_ai_config()
        ai_answer = ""
        if ai_cfg["key"]:
            try:
                if candidates:
                    candidate_text = ""
                    # 过滤：排除标题或内容完全不包含搜索特异词的记录，避免张冠李戴
                    # 用最长的关键词做精确匹配，如果筛空则回退
                    specific_kws = sorted([w for w in words if len(w) >= 2], key=len, reverse=True)[:3]
                    filtered = candidates[:10]
                    for kw in specific_kws:
                        temp = [c for c in filtered if kw in (c['question'] or '') or kw in (c['solution'] or '')]
                        if temp:
                            filtered = temp
                            break
                    for i, c in enumerate(filtered[:10]):
                        question = (c['question'] or '').strip()
                        solution = (c['solution'] or '').replace('\n', ' ')[:200]
                        info = f"[{i+1}] {question} | {solution}"
                        candidate_text += info + "\n"
                    system_prompt = "你是一个严谨的知识库问答助手。规则（必须遵守）：1. 只回答下方记录中明确写出的内容，记录中没有的信息严禁编造或推断；2. 回答不超过200字；3. 引用序号放在方括号里如[1][2]；4. 如果记录不足以回答就说'知识库中没有相关信息'。"
                    user_prompt = f"问题：{query}\n\n知识库：\n{candidate_text}"
                else:
                    system_prompt = "你是一个智能问答助手，回答问题先剔除Markdown格式、特殊符号、多余空格。知识库中没有相关内容，根据你的自身知识回答用户问题，控制在200字内。如果问题涉及专业知识而你不确定，如实说不知道。"
                    user_prompt = f"问题：{query}"

                payload = {
                    "model": ai_cfg["model"],
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    "temperature": 0.05,
                    "max_tokens": 526
                }
                headers = {
                    "Authorization": f"Bearer {ai_cfg['key']}",
                    "Content-Type": "application/json"
                }
                resp = requests.post(ai_cfg["url"], json=payload, headers=headers, stream=True, timeout=(10, 120))
                resp.raise_for_status()
                ai_answer = resp.json()["choices"][0]["message"]["content"].strip()
            except requests.Timeout:
                op_log(f"AI问答超时: URL={ai_cfg['url']}")
                ai_answer = ""
            except requests.RequestException as e:
                resp_body = ""
                if e.response is not None:
                    resp_body = e.response.text[:200]
                op_log(f"AI问答失败: {str(e)[:100]}，响应: {resp_body}")
                ai_answer = ""
            except Exception as e:
                op_log(f"AI问答异常: {str(e)}")
                ai_answer = ""

        return jsonify({"records": records_for_display, "answer": ai_answer, "total": len(candidates)})

# ===================== AI智能解析 =====================
@ai_bp.route('/api/ai_parse', methods=['POST'])
@login_required
@require_permission("ai.use")
def ai_parse():
    data = request.json
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"status": "error", "msg": "请输入要解析的文本"})

    # 读取系统全部分类列表
    with get_db_connection() as conn:
        rows = conn.execute("SELECT name FROM category_config ORDER BY id").fetchall()
    categories = [r["name"] for r in rows]

    system_prompt = f"""你是一个运维知识库信息提取助手。严格按以下规则从用户输入的杂乱文本中提取信息：

【任务】
提取4个固定字段：知识分类、提出人、标题、核心内容
禁止输出思考过程、禁止解释、禁止分析，只输出最终结果，不要任何额外内容。
【分类规则 - 重要】
必须从以下系统分类列表中选最匹配的一项，严禁自行创造新分类：
{json.dumps(categories, ensure_ascii=False)}

【字段要求】
1. 知识分类：从上方的系统分类列表中选最匹配的一项
2. 提出人：提取文本中提到的第一个人名；如果文本中没有提及任何人名，返回空字符串（即两个引号中间什么都不写："")
3. 标题：一句话概括核心问题/主题，简洁明了，不超过50字
4. 核心内容：提取关键的技术处理过程、解决方法或详细说明，这是知识的核心部分不可省略

【输出格式】
只返回以下纯JSON，不要任何多余文字、不要markdown标记：
{{"knowledge_category": "分类名", "creator": "人名", "title": "标题", "content": "核心内容"}}"""

    user_prompt = f"请解析以下文本：\n{text}"

    ai_cfg = get_ai_config()
    if not ai_cfg["key"]:
        return jsonify({"status": "error", "msg": "AI功能未配置，请联系管理员在「AI配置」中设置API Key"})
    try:
        payload = {
            "model": ai_cfg["model"],
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": 0.07,
            "max_tokens": 256
        }
        headers = {
            "Authorization": f"Bearer {ai_cfg['key']}",
            "Content-Type": "application/json"
        }
        resp = requests.post(ai_cfg["url"], json=payload, headers=headers, timeout=60)
        resp.raise_for_status()
        result = resp.json()
        ai_text = result["choices"][0]["message"]["content"].strip()
        ai_text = ai_text.replace("```json", "").replace("```", "").strip()

        # 尝试解析JSON，如果截断则自动修复
        parsed = None
        if not parsed:
            try:
                parsed = json.loads(ai_text)
            except json.JSONDecodeError:
                # 尝试修复截断的JSON：补全末尾引号和花括号
                fixed = ai_text.rstrip()
                # 如果以双引号结尾但未闭合，加一个双引号
                if fixed.count('"') % 2 != 0:
                    fixed += '"'
                # 补全花括号
                open_braces = fixed.count('{')
                close_braces = fixed.count('}')
                fixed += "}" * (open_braces - close_braces)
                try:
                    parsed = json.loads(fixed)
                    op_log(f"AI返回JSON截断已自动修复，补全了{open_braces - close_braces}个花括号")
                except json.JSONDecodeError:
                    # 更激进的修复：仅提取最后一个完整字段
                    import re as _re
                    m = _re.search(r'\{.*\}', ai_text, _re.DOTALL)
                    if m:
                        try:
                            parsed = json.loads(m.group())
                        except json.JSONDecodeError:
                            pass
        if not parsed:
            raise json.JSONDecodeError("无法解析AI返回的JSON", ai_text, 0)
    except requests.Timeout:
        op_log("AI解析接口请求超时")
        return jsonify({"status": "error", "msg": "AI接口请求超时，请稍后重试"})
    except requests.RequestException as e:
        resp_body = ""
        if e.response is not None:
            resp_body = e.response.text[:200]
        op_log(f"AI接口调用失败: {str(e)[:100]}，响应: {resp_body}")
        return jsonify({"status": "error", "msg": f"AI接口调用失败，请检查API配置或网络后重试"})
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        op_log(f"AI返回格式异常: {str(e)}，原始返回: {ai_text if 'ai_text' in locals() else 'N/A'}")
        return jsonify({"status": "error", "msg": "AI返回格式异常，请重试"})
    except Exception as e:
        op_log(f"AI解析异常: {str(e)}")
        return jsonify({"status": "error", "msg": f"解析异常：{str(e)}"})

    category = parsed.get("knowledge_category", "").strip()
    creator = parsed.get("creator", "").strip()
    title = parsed.get("title", "").strip()
    content = parsed.get("content", "").strip()

    if not category or category not in categories:
        op_log(f"AI返回分类「{category}」不在系统列表中，兜底为「其他」")
        category = "其他"

    if not creator:
        from flask import g
        creator = g.user["username"]

    if len(title) > 100:
        title = title[:97] + "..."

    op_log(f"AI解析成功：分类={category}，创建人={creator}，标题={title[:30]}...")
    return jsonify({
        "status": "success",
        "data": {
            "category": category,
            "proposer": creator,
            "question": title,
            "solution": content
        }
    })

# ===================== AI 辅助编辑 =====================
@ai_bp.route('/api/ai_enhance', methods=['POST'])
@login_required
@require_permission("ai.use")
def ai_enhance():
    """AI 优化编辑中的知识内容：修正措辞、补全信息、保持原意"""
    data = request.json
    question = (data.get("question", "") or "").strip()
    solution = (data.get("solution", "") or "").strip()
    remark = (data.get("remark", "") or "").strip()
    if not question and not solution:
        return jsonify({"status": "error", "msg": "标题和内容不能都为空"})

    ai_cfg = get_ai_config()
    if not ai_cfg["key"]:
        return jsonify({"status": "error", "msg": "AI功能未配置，请先设置API Key"})

    content_for_ai = f"标题：{question}\n核心内容：{solution}\n补充说明：{remark}"
    system_prompt = """你是一个知识库编辑助手。优化用户的知识记录，要求：
1. 修正错别字和语法错误
2. 优化表达，保持专业性，不改变原意
3. 补充合理的关键信息（确保准确）
4. 返回纯 JSON，格式：{"title":"优化后的标题","content":"优化后的核心内容","remark":"优化后的补充说明或留空","reason":"改动说明，50字内"}"""

    try:
        payload = {
            "model": ai_cfg["model"],
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content_for_ai}
            ],
            "temperature": 0.1,
            "max_tokens": 512
        }
        headers = {
            "Authorization": f"Bearer {ai_cfg['key']}",
            "Content-Type": "application/json"
        }
        resp = requests.post(ai_cfg["url"], json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        result = resp.json()
        ai_text = result["choices"][0]["message"]["content"].strip()
        ai_text = ai_text.replace("```json", "").replace("```", "").strip()
        parsed = json.loads(ai_text)

        suggested_title = parsed.get("title", "").strip() or question
        suggested_content = parsed.get("content", "").strip() or solution
        suggested_remark = parsed.get("remark", "").strip()
        reason = parsed.get("reason", "").strip()

        return jsonify({
            "status": "success",
            "data": {
                "title": suggested_title,
                "content": suggested_content,
                "remark": suggested_remark,
                "reason": reason
            }
        })
    except json.JSONDecodeError:
        return jsonify({"status": "error", "msg": "AI返回格式异常，请重试"})
    except requests.Timeout:
        return jsonify({"status": "error", "msg": "AI接口超时"})
    except requests.RequestException as e:
        return jsonify({"status": "error", "msg": f"AI接口调用失败: {str(e)[:80]}"})
    except Exception as e:
        return jsonify({"status": "error", "msg": f"AI异常: {str(e)[:80]}"})
