const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');

// 获取当前用户的汇报单
router.get('/reports', authenticate, async (req, res) => {
  try {
    const { status, report_type, start_date, end_date } = req.query;
    let sql = `SELECT cr.*, u.real_name AS receiver_name,
               cr.cycle_start::text AS cycle_start, cr.cycle_end::text AS cycle_end
               FROM cycle_report cr
               JOIN sys_user u ON cr.receiver_id = u.user_id
               WHERE cr.user_id = $1 AND cr.is_delete = 0`;
    const params = [req.user.user_id];
    let paramIndex = 2;
    
    if (status !== undefined && status !== '') {
      sql += ' AND cr.report_status = $' + paramIndex++;
      params.push(parseInt(status));
    }
    if (report_type) {
      sql += ' AND cr.report_type = $' + paramIndex++;
      params.push(parseInt(report_type));
    }
    if (start_date) {
      sql += ' AND cr.cycle_start >= $' + paramIndex++;
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND cr.cycle_end <= $' + paramIndex++;
      params.push(end_date);
    }
    sql += ' ORDER BY cr.create_time DESC';
    
    const result = await pool.query(sql, params);
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error('Get reports error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 创建/提交汇报单（支持存草稿）
router.post('/reports', authenticate, async (req, res) => {
  try {
    const { report_type, cycle_start, cycle_end, report_content, generate_type, record_ids, save_as_draft } = req.body;
    if (!report_type || !cycle_start || !cycle_end || !report_content) {
      return res.status(400).json({ code: 400, msg: '必填字段不能为空' });
    }
    if (report_content.length > 10000) {
      return res.status(400).json({ code: 400, msg: '汇报内容不能超过10000字符' });
    }
    
    // 获取接收人（汇报关系中的上级）
    const relationResult = await pool.query(
      'SELECT receiver_id FROM report_relation WHERE reporter_id = $1 LIMIT 1',
      [req.user.user_id]
    );
    
    if (relationResult.rows.length === 0) {
      return res.status(400).json({ code: 400, msg: '未配置汇报接收人，请联系管理员' });
    }
    
    const receiver_id = relationResult.rows[0].receiver_id;

    // 检查同一周期是否已有汇报单（避免重复创建）
    const existReport = await pool.query(
      `SELECT report_id, report_status FROM cycle_report
       WHERE user_id = $1 AND receiver_id = $2 AND report_type = $3
       AND cycle_start = $4 AND cycle_end = $5 AND is_delete = 0`,
      [req.user.user_id, receiver_id, report_type, cycle_start, cycle_end]
    );
    if (existReport.rows.length > 0) {
      return res.status(400).json({ code: 400, msg: '该周期已存在汇报单，请编辑或删除后重试' });
    }

    const isDraft = save_as_draft === true;
    const reportStatus = isDraft ? 0 : 1;

    let insertSql, insertParams;
    if (isDraft) {
      insertSql = `INSERT INTO cycle_report (user_id, receiver_id, report_type, cycle_start, cycle_end, report_content, generate_type, report_status)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING report_id`;
      insertParams = [req.user.user_id, receiver_id, report_type, cycle_start, cycle_end, report_content, generate_type || 1, 0];
    } else {
      insertSql = `INSERT INTO cycle_report (user_id, receiver_id, report_type, cycle_start, cycle_end, report_content, generate_type, report_status, submit_time)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING report_id`;
      insertParams = [req.user.user_id, receiver_id, report_type, cycle_start, cycle_end, report_content, generate_type || 1, 1];
    }

    const result = await pool.query(insertSql, insertParams);
    const reportId = result.rows[0].report_id;

    // 写入工作记录关联（record_ids 由前端传入）
    if (Array.isArray(record_ids) && record_ids.length > 0) {
      for (const rid of record_ids) {
        await pool.query(
          `INSERT INTO report_record (report_id, record_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [reportId, rid]
        );
      }
    }

    res.json({ code: 200, data: { report_id: reportId }, msg: isDraft ? '草稿已保存' : '提交成功' });

    // 非草稿提交时：通知上级
    if (!isDraft) {
      const typeText = { 1: '周报', 2: '月报', 3: '季报' }[report_type] || '汇报';
      await pool.query(
        `INSERT INTO notification (user_id, type, title, content, report_id) VALUES ($1, 'submit', $2, $3, $4)`,
        [receiver_id, `${typeText}待审核`, `${req.user.real_name} 提交了 ${cycle_start} ~ ${cycle_end} 的${typeText}，请审核`, reportId]
      ).catch(err => console.error('Notify receiver error:', err.message));
    }
  } catch (err) {
    console.error('Create report error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 编辑周期汇报内容（仅草稿和已退回可编辑）
router.post('/reports/edit/:id', authenticate, async (req, res) => {
  try {
    const { report_content, report_type, cycle_start, cycle_end, record_ids } = req.body;
    if (!report_content) {
      return res.status(400).json({ code: 400, msg: '汇报内容不能为空' });
    }
    if (report_content.length > 10000) {
      return res.status(400).json({ code: 400, msg: '汇报内容不能超过10000字符' });
    }
    
    const check = await pool.query(
      'SELECT report_status FROM cycle_report WHERE report_id = $1 AND user_id = $2 AND is_delete = 0',
      [req.params.id, req.user.user_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '汇报单不存在' });
    }
    if (check.rows[0].report_status !== 0 && check.rows[0].report_status !== 2) {
      return res.status(400).json({ code: 400, msg: '只有草稿或已退回的汇报可编辑' });
    }
    
    // 更新汇报内容、类型和周期
    let updateSql = 'UPDATE cycle_report SET report_content = $1';
    const updateParams = [report_content];
    let paramIdx = 2;
    
    if (report_type) {
      updateSql += ', report_type = $' + paramIdx++;
      updateParams.push(parseInt(report_type));
    }
    if (cycle_start) {
      updateSql += ', cycle_start = $' + paramIdx++;
      updateParams.push(cycle_start);
    }
    if (cycle_end) {
      updateSql += ', cycle_end = $' + paramIdx++;
      updateParams.push(cycle_end);
    }
    updateSql += ' WHERE report_id = $' + paramIdx++;
    updateParams.push(req.params.id);
    
    await pool.query(updateSql, updateParams);
    
    // 更新关联的工作记录（替换旧的关联）
    if (Array.isArray(record_ids)) {
      await pool.query('DELETE FROM report_record WHERE report_id = $1', [req.params.id]);
      for (const rid of record_ids) {
        if (!rid) continue;
        await pool.query(
          `INSERT INTO report_record (report_id, record_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [req.params.id, rid]
        );
      }
    }
    
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) {
    console.error('Update report error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 获取周期内已提交的工作记录（用于生成汇报）
router.get('/reports/work-records', authenticate, async (req, res) => {
  try {
    const { start_date, end_date, include_sub_reports } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ code: 400, msg: '开始日期和结束日期不能为空' });
    }

    // 1. 查自己的工作记录
    const myRecords = await pool.query(
      `SELECT record_id, display_id, user_id, NULL AS reporter_name,
              record_date::text AS record_date, record_content, record_status, submit_time::text AS submit_time,
              '_record' AS _type, NULL AS report_type, NULL AS cycle_start, NULL AS cycle_end
       FROM work_record
       WHERE user_id = $1 AND record_status = 1 AND is_delete = 0
       AND record_date >= $2 AND record_date <= $3
       ORDER BY record_date`,
      [req.user.user_id, start_date, end_date]
    );

    let results = myRecords.rows;

    // 2. 如果包含下属已通过的周期汇报
    if (include_sub_reports === 'true') {
      const subReports = await pool.query(`
        WITH RECURSIVE sub_tree AS (
          SELECT reporter_id AS user_id FROM report_relation WHERE receiver_id = $1
          UNION
          SELECT r.reporter_id FROM report_relation r JOIN sub_tree s ON r.receiver_id = s.user_id
        )
        SELECT cr.report_id, NULL AS display_id, cr.user_id, u.real_name AS reporter_name,
               NULL AS record_date, cr.report_content, cr.report_status, cr.submit_time::text AS submit_time,
               '_sub_report' AS _type, cr.report_type, cr.cycle_start::text AS cycle_start, cr.cycle_end::text AS cycle_end
        FROM cycle_report cr
        JOIN sys_user u ON cr.user_id = u.user_id
        WHERE cr.user_id IN (SELECT user_id FROM sub_tree)
        AND cr.user_id != $1
        AND cr.report_status = 3
        AND cr.receiver_id = $1
        AND cr.is_delete = 0
        AND cr.cycle_start >= $2 AND cr.cycle_end <= $3
        ORDER BY cr.user_id, cr.cycle_start`,
        [req.user.user_id, start_date, end_date]
      );
      results = [...results, ...subReports.rows];
    }
    
    res.json({ code: 200, data: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 提交汇报单给上级（从草稿/已退回变为已提交）
router.post('/reports/submit', authenticate, async (req, res) => {
  try {
    const { report_id } = req.body;
    if (!report_id) {
      return res.status(400).json({ code: 400, msg: '汇报ID不能为空' });
    }
    
    const check = await pool.query(
      'SELECT * FROM cycle_report WHERE report_id = $1 AND user_id = $2 AND is_delete = 0',
      [report_id, req.user.user_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '汇报单不存在' });
    }
    if (check.rows[0].report_status !== 0 && check.rows[0].report_status !== 2) {
      return res.status(400).json({ code: 400, msg: '当前状态不可提交' });
    }
    
    const report = check.rows[0];

    // 提交时自动关联该周期内的已提交工作记录（仅当关联为空时补充）
    const existingAssoc = await pool.query(
      'SELECT COUNT(*) AS cnt FROM report_record WHERE report_id = $1',
      [report_id]
    );
    if (parseInt(existingAssoc.rows[0].cnt) === 0) {
      await pool.query(
        `INSERT INTO report_record (report_id, record_id)
         SELECT $1, wr.record_id FROM work_record wr
         WHERE wr.user_id = $2 AND wr.record_status = 1 AND wr.is_delete = 0
         AND wr.record_date >= $3 AND wr.record_date <= $4
         AND NOT EXISTS (SELECT 1 FROM report_record rr WHERE rr.report_id = $1 AND rr.record_id = wr.record_id)`,
        [report_id, req.user.user_id, report.cycle_start, report.cycle_end]
      );
    }
    
    await pool.query(
      'UPDATE cycle_report SET report_status = 1, submit_time = NOW() WHERE report_id = $1',
      [report_id]
    );
    
    // 通知上级
    const typeText = { 1: '周报', 2: '月报', 3: '季报' }[report.report_type] || '汇报';
    await pool.query(
      `INSERT INTO notification (user_id, type, title, content, report_id) VALUES ($1, 'submit', $2, $3, $4)`,
      [report.receiver_id, `${typeText}待审核`, `${req.user.real_name} 提交了 ${report.cycle_start} ~ ${report.cycle_end} 的${typeText}，请审核`, report_id]
    ).catch(err => console.error('Notify receiver error:', err.message));
    
    res.json({ code: 200, msg: '提交成功' });
  } catch (err) {
    console.error('Submit report error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 删除周期汇报（仅草稿和已退回可删除）
router.delete('/reports/:id', authenticate, async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT report_status FROM cycle_report WHERE report_id = $1 AND user_id = $2 AND is_delete = 0',
      [req.params.id, req.user.user_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '汇报单不存在' });
    }
    if (check.rows[0].report_status !== 0 && check.rows[0].report_status !== 2) {
      return res.status(400).json({ code: 400, msg: '已提交或已通过的汇报不可删除' });
    }
    await pool.query(
      'UPDATE cycle_report SET is_delete = 1 WHERE report_id = $1',
      [req.params.id]
    );
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    console.error('Delete report error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// AI 生成汇报内容（前端调用入口）
router.post('/reports/ai-generate', authenticate, async (req, res) => {
  try {
    const { type, cycle_start, cycle_end, record_ids, sub_reports } = req.body;
    if (!cycle_start || !cycle_end) {
      return res.status(400).json({ code: 400, msg: '周期不能为空' });
    }
    // 获取选中的工作记录
    let recordText = '';
    if (record_ids && record_ids.length > 0) {
      const records = await pool.query(
        'SELECT record_date, record_content FROM work_record WHERE record_id = ANY($1::int[]) AND user_id = $2 ORDER BY record_date',
        [record_ids, req.user.user_id]
      );
      recordText = records.rows.map(r => `${r.record_date}: ${r.record_content}`).join('\n');
    }
    const typeText = type === 1 ? '周报' : '月报';
    let userMsg = `请为 ${req.user.real_name} 生成一份 ${cycle_start} ~ ${cycle_end} 的${typeText}。\n\n`;
    if (recordText) userMsg += `## 工作记录\n${recordText}\n\n`;
    if (sub_reports && sub_reports.length > 0) userMsg += `## 下属汇报摘要\n${sub_reports.join('\n\n')}\n\n`;
    userMsg += '请生成一份完整、结构清晰的汇报内容。';
    // 转发到 ai-proxy/generate
    const proxyReq = { ...req, body: { messages: [{ role: 'user', content: userMsg }] }, url: '/api/ai-proxy/generate', method: 'POST' };
    // 手动调用 ai-proxy/generate 的路由处理
    const { messages } = proxyReq.body;
    // 从数据库读取 AI 配置
    const configResult = await pool.query('SELECT config_key, config_value FROM ai_config');
    const configMap = {};
    configResult.rows.forEach(row => { configMap[row.config_key] = row.config_value; });
    const api_url = configMap.api_url;
    const model_name = configMap.model_name;
    const api_key = configMap.api_key;
    const system_prompt = configMap.system_prompt || '你是一个工作汇报助手，请根据以下工作记录生成一份简洁的总结报告。请直接输出汇报内容，不要输出思考过程。';
    if (!api_url || !model_name) {
      return res.status(400).json({ code: 400, msg: 'AI 尚未配置，请联系管理员' });
    }
    const isQwen3 = /qwen\s*3/i.test(model_name);
    const finalSystemPrompt = (isQwen3 && !system_prompt.includes('/no_think') ? '/no_think\n' : '') + system_prompt
      + '\n\n请使用 Markdown 格式输出。不要输出「工作汇报」「本周工作总结」等外层大标题，直接从内容开始。用 ## 或 ### 做标题，用 - 做列表，用 **加粗** 突出重点。';
    const headers = { 'Content-Type': 'application/json' };
    if (api_key) headers['Authorization'] = 'Bearer ' + api_key;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const resp = await fetch(api_url, {
      method: 'POST', headers,
      body: JSON.stringify({ model: model_name, messages: [{ role: 'system', content: finalSystemPrompt }, ...messages], max_tokens: 4096 }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return res.status(500).json({ code: 500, msg: `AI 请求失败 (${resp.status}): ${errText}` });
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (content) {
      // 记录 AI 调用日志
      pool.query(
        'INSERT INTO system_log (user_id, username, real_name, action, details) VALUES ($1,$2,$3,$4,$5)',
        [req.user.user_id, req.user.username, req.user.real_name, 'ai_generate', 'AI 生成汇报内容']
      ).catch(() => {});
      res.json({ code: 200, data: { content } });
    } else {
      res.status(500).json({ code: 500, msg: 'AI 返回内容为空' });
    }
  } catch (err) {
    console.error('AI generate error:', err);
    res.status(500).json({ code: 500, msg: 'AI 生成失败：' + (err.message || '') });
  }
});

// AI 代理 - 测试连接
router.post('/ai-proxy/test', authenticate, async (req, res) => {
  try {
    // 允许管理员和上级操作
    if (req.user.role_type !== 3) {
      return res.status(403).json({ code: 403, msg: '无权限' });
    }
    const { api_url, model_name } = req.body;
    if (!api_url || !model_name) {
      return res.status(400).json({ code: 400, msg: '接口地址和模型名称不能为空' });
    }

    // 从数据库读取 api_key（前端不再传递明文，防止脱敏值透传）
    const configResult = await pool.query("SELECT config_value FROM ai_config WHERE config_key = 'api_key'");
    let api_key = configResult.rows[0]?.config_value || '';

    const headers = { 'Content-Type': 'application/json' };
    if (api_key) headers['Authorization'] = 'Bearer ' + api_key;

    // 判断是否 Qwen3 模型（需要 /no_think 关闭思考模式）
    const isQwen3 = /qwen\s*3/i.test(model_name);

    const testMessages = [{ role: 'user', content: (isQwen3 ? '/no_think\n' : '') + '你好，请回复OK' }];

    const testController = new AbortController();
    const testTimeout = setTimeout(() => testController.abort(), 30000);

    const resp = await fetch(api_url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model_name,
        messages: testMessages,
        max_tokens: 50
      }),
      signal: testController.signal
    });
    clearTimeout(testTimeout);

    if (resp.ok) {
      const result = await resp.json().catch(() => ({}));
      const msg = result.choices?.[0]?.message;
      const content = msg?.content || msg?.reasoning_content || '';
      res.json({ code: 200, msg: content ? '连接成功' : '连接成功（返回内容为空，但接口可达）' });
    } else {
      const text = await resp.text().catch(() => '');
      res.json({ code: 400, msg: 'HTTP ' + resp.status + (text ? ': ' + text.slice(0, 200) : '') });
    }
  } catch (err) {
    console.error('AI test error:', err.message);
    res.json({ code: 500, msg: '连接失败: ' + err.message });
  }
});

// AI 代理 - 生成汇报
router.post('/ai-proxy/generate', authenticate, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !messages.length) {
      return res.status(400).json({ code: 400, msg: '消息内容不能为空' });
    }

    // 从数据库读取 AI 配置
    const configResult = await pool.query('SELECT config_key, config_value FROM ai_config');
    const configMap = {};
    configResult.rows.forEach(row => { configMap[row.config_key] = row.config_value; });

    const api_url = configMap.api_url;
    const model_name = configMap.model_name;
    const api_key = configMap.api_key;
    const system_prompt = configMap.system_prompt || '你是一个工作汇报助手，请根据以下工作记录生成一份简洁的总结报告。请直接输出汇报内容，不要输出思考过程。';

    if (!api_url || !model_name) {
      return res.status(400).json({ code: 400, msg: 'AI 尚未配置，请联系管理员' });
    }

    // Qwen3 思考模式：只在 Qwen3 模型时加 /no_think 关闭思考
    const isQwen3 = /qwen\s*3/i.test(model_name);
    const finalSystemPrompt = (isQwen3 && !system_prompt.includes('/no_think') ? '/no_think\n' : '') + system_prompt
      + '\n\n请使用 Markdown 格式输出。不要输出「工作汇报」「本周工作总结」等外层大标题，直接从内容开始。用 ## 或 ### 做标题，用 - 做列表，用 **加粗** 突出重点，用 --- 分隔段落。';

    const fullMessages = [
      { role: 'system', content: finalSystemPrompt },
      ...messages
    ];

    const headers = { 'Content-Type': 'application/json' };
    if (api_key) headers['Authorization'] = 'Bearer ' + api_key;

    // 120 秒超时，防止 AI 服务挂起
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    const resp = await fetch(api_url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model_name,
        messages: fullMessages,
        temperature: 0.7,
        max_tokens: 4096
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return res.status(resp.status).json({ code: resp.status, msg: 'AI 服务返回错误: HTTP ' + resp.status });
    }

    const result = await resp.json();
    // 兼容 OpenAI 格式、国产模型格式、Qwen3 思考模式
    const msg = result.choices?.[0]?.message;
    const content = msg?.content
                  || msg?.reasoning_content   // Qwen3 思考模式（降级使用思考内容）
                  || result.output?.text
                  || result.result
                  || result.content
                  || '';

    if (content) {
      res.json({ code: 200, data: { content }, generate_type: 2 });
      pool.query(
        'INSERT INTO system_log (user_id, username, real_name, action, details) VALUES ($1,$2,$3,$4,$5)',
        [req.user.user_id, req.user.username, req.user.real_name, 'ai_generate', 'AI 生成汇报内容']
      ).catch(() => {});
    } else {
      res.json({ code: 400, msg: 'AI 返回内容为空', raw: JSON.stringify(result).slice(0, 500) });
    }
  } catch (err) {
    console.error('AI generate error:', err.message);
    res.status(500).json({ code: 500, msg: 'AI 生成失败: ' + err.message });
  }
});

// 获取AI配置
router.get('/ai-config', authenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT config_key, config_value, config_desc FROM ai_config ORDER BY config_id');
    const configMap = {};
    result.rows.forEach(row => {
      // API 密钥脱敏：仅显示前4后4
      if (row.config_key === 'api_key' && row.config_value && row.config_value.length > 8) {
        configMap[row.config_key] = row.config_value.slice(0, 4) + '****' + row.config_value.slice(-4);
      } else {
        configMap[row.config_key] = row.config_value;
      }
    });
    res.json({ code: 200, data: configMap });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 更新AI配置（管理员）
router.put('/ai-config', authenticate, async (req, res) => {
  try {
    // 仅超管可管理AI配置
    if (req.user.role_type !== 3) {
      return res.status(403).json({ code: 403, msg: '无权限' });
    }
    const { configs } = req.body;
    if (!configs || typeof configs !== 'object') {
      return res.status(400).json({ code: 400, msg: '参数错误' });
    }
    
    for (const [key, value] of Object.entries(configs)) {
      // API 密钥脱敏显示时不可更新
      if (key === 'api_key' && typeof value === 'string' && value.includes('****')) continue;
      await pool.query(
        `INSERT INTO ai_config (config_key, config_value, update_time)
         VALUES ($1, $2, NOW())
         ON CONFLICT (config_key) DO UPDATE SET config_value = $2, update_time = NOW()`,
        [key, value]
      );
    }
    
    res.json({ code: 200, msg: '配置更新成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

module.exports = router;
