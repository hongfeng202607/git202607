const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');

// 检查记录是否被审批中的周期汇报引用
async function checkCycleReportLocked(userId, recordId) {
  const reportCheck = await pool.query(
    `SELECT cr.report_status FROM report_record rr
     JOIN cycle_report cr ON rr.report_id = cr.report_id
     WHERE rr.record_id = $1 AND cr.is_delete = 0
     AND cr.user_id = $2
     AND cr.report_status = 1`,
    [recordId, userId]
  );
  if (reportCheck.rows.length > 0) {
    return `该记录已被周期汇报引用（审批中），不可操作`;
  }
  return null;
}

// 获取当前用户的工作记录（分页）
router.get('/records', authenticate, async (req, res) => {
  try {
    const { start_date, end_date, status, page, pageSize, reqOffset } = req.query;
    const currentPage = Math.max(1, parseInt(page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(pageSize) || 20));
    // 如果前端传了 reqOffset，用它覆盖基于 page 的偏移计算
    const offset = reqOffset !== undefined ? parseInt(reqOffset) : (currentPage - 1) * limit;

    // 基础 WHERE 条件
    let whereClause = 'WHERE user_id = $1 AND is_delete = 0';
    const params = [req.user.user_id];
    let paramIndex = 2;

    if (start_date) {
      whereClause += ' AND record_date >= $' + paramIndex++;
      params.push(start_date);
    }
    if (end_date) {
      whereClause += ' AND record_date <= $' + paramIndex++;
      params.push(end_date);
    }
    if (status !== undefined && status !== '') {
      whereClause += ' AND record_status = $' + paramIndex++;
      params.push(parseInt(status));
    }

    // 查总数
    const countResult = await pool.query(
      'SELECT COUNT(*) AS total FROM work_record ' + whereClause,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // 查数据（带分页）
    const dataSql = 'SELECT * FROM work_record ' + whereClause +
      ' ORDER BY record_date DESC, create_time DESC LIMIT $' + paramIndex++ + ' OFFSET $' + paramIndex++;
    const dataResult = await pool.query(dataSql, [...params, limit, offset]);

    // 查询每条记录是否被审批中的周期汇报引用（基于关联表）
    const records = dataResult.rows.map(r => ({ ...r, cycle_report_status: null }));
    if (records.length > 0) {
      const recordIds = records.map(r => r.record_id);
      // 查找被审批中汇报引用的记录
      const lockResult = await pool.query(
        `SELECT rr.record_id, cr.report_status FROM report_record rr
         JOIN cycle_report cr ON rr.report_id = cr.report_id
         WHERE rr.record_id = ANY($1) AND cr.is_delete = 0 AND cr.report_status = 1
         AND cr.user_id = $2`,
        [recordIds, req.user.user_id]
      );
      for (const row of lockResult.rows) {
        const rec = records.find(r => r.record_id === row.record_id);
        if (rec) rec.cycle_report_status = row.report_status;
      }
    }

    res.json({ code: 200, data: records, total });
  } catch (err) {
    console.error('Get records error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 批量同步工作记录（从本地到服务端）
router.post('/records/sync', authenticate, async (req, res) => {
  try {
    const { records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ code: 400, msg: '记录不能为空' });
    }
    
    const results = [];
    for (const record of records) {
      // 检查是否已存在（通过日期+内容简单判断）
      const existResult = await pool.query(
        'SELECT record_id FROM work_record WHERE user_id = $1 AND record_date = $2 AND record_status = 1 AND is_delete = 0 AND record_content = $3',
        [req.user.user_id, record.record_date, record.record_content]
      );
      
      if (existResult.rows.length > 0) {
        results.push({ local_id: record._local_id, record_id: existResult.rows[0].record_id, status: 'exists' });
        continue;
      }
      
      const insertResult = await pool.query(
        `INSERT INTO work_record (user_id, record_date, record_content, record_status, submit_time)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING record_id`,
        [req.user.user_id, record.record_date, record.record_content, record.record_status || 1]
      );
      // 生成 display_id（YYMMDDHHmm 格式）
      await pool.query(
        `UPDATE work_record SET display_id = TO_CHAR(NOW(), 'YYMMDDHH24MI') WHERE record_id = $1`,
        [insertResult.rows[0].record_id]
      );
      results.push({ local_id: record._local_id, record_id: insertResult.rows[0].record_id, status: 'created' });
    }
    
    res.json({ code: 200, data: results, msg: '同步完成' });
  } catch (err) {
    console.error('Sync records error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 正式提交工作记录（单条）
router.post('/records/submit', authenticate, async (req, res) => {
  try {
    const { record_id, record_date, record_content, save_as_draft } = req.body;
    // 输入长度校验
    if (record_content && record_content.length > 5000) {
      return res.status(400).json({ code: 400, msg: '记录内容不能超过5000字符' });
    }
    let savedRecordId;

    const isDraft = save_as_draft === true;
    
    // 如果有record_id则更新，否则新建
    if (record_id) {
      const check = await pool.query(
        'SELECT record_status FROM work_record WHERE record_id = $1 AND user_id = $2',
        [record_id, req.user.user_id]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ code: 404, msg: '记录不存在' });
      }
      if (check.rows[0].record_status === 1) {
        return res.status(400).json({ code: 400, msg: '该记录已正式提交，不可重复提交' });
      }
      
      // 更新已有草稿：更新内容，并根据是否草稿决定状态
      const status = isDraft ? 0 : 1;
      await pool.query(
        `UPDATE work_record SET record_date = $1, record_content = $2, record_status = $3,
         submit_time = $4, update_time = NOW() WHERE record_id = $5 AND user_id = $6`,
        [record_date, record_content, status, isDraft ? null : new Date(), record_id, req.user.user_id]
      );
      savedRecordId = record_id;
    } else {
      // 新建
      const status = isDraft ? 0 : 1;
      const result = await pool.query(
        `INSERT INTO work_record (user_id, record_date, record_content, record_status, submit_time)
         VALUES ($1, $2, $3, $4, $5) RETURNING record_id`,
        [req.user.user_id, record_date, record_content, status, isDraft ? null : new Date()]
      );
      savedRecordId = result.rows[0].record_id;
      // 生成 display_id（YYMMDDHHmm 格式）
      await pool.query(
        `UPDATE work_record SET display_id = TO_CHAR(NOW(), 'YYMMDDHH24MI') WHERE record_id = $1`,
        [savedRecordId]
      );
    }

    res.json({ code: 200, data: { record_id: savedRecordId }, msg: isDraft ? '草稿已保存' : '提交成功' });
    pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.user_id, req.user.username, req.user.real_name, isDraft ? 'save_draft' : 'submit_record', 'record', savedRecordId, isDraft ? '保存工作记录草稿' : '提交工作记录']
    ).catch(() => {});
  } catch (err) {
    console.error('Submit record error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 编辑工作记录（仅草稿可编辑，且周期汇报未提交）
router.put('/records/:id', authenticate, async (req, res) => {
  try {
    const { record_date, record_content } = req.body;
    if (!record_date || !record_content) {
      return res.status(400).json({ code: 400, msg: '日期和内容不能为空' });
    }
    if (record_content.length > 5000) {
      return res.status(400).json({ code: 400, msg: '记录内容不能超过5000字符' });
    }
    const check = await pool.query(
      'SELECT record_status FROM work_record WHERE record_id = $1 AND user_id = $2 AND is_delete = 0',
      [req.params.id, req.user.user_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '记录不存在' });
    }
    if (check.rows[0].record_status !== 0) {
      return res.status(400).json({ code: 400, msg: '只有草稿状态的记录可编辑' });
    }
    const lockMsg = await checkCycleReportLocked(req.user.user_id, req.params.id);
    if (lockMsg) {
      return res.status(400).json({ code: 400, msg: lockMsg });
    }
    await pool.query(
      'UPDATE work_record SET record_date = $1, record_content = $2, update_time = NOW() WHERE record_id = $3',
      [record_date, record_content, req.params.id]
    );
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) {
    console.error('Update record error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 撤回工作记录（已提交→草稿，允许重新编辑）
router.post('/records/recall', authenticate, async (req, res) => {
  try {
    const { record_id } = req.body;
    if (!record_id) {
      return res.status(400).json({ code: 400, msg: '记录ID不能为空' });
    }
    const check = await pool.query(
      'SELECT record_status FROM work_record WHERE record_id = $1 AND user_id = $2 AND is_delete = 0',
      [record_id, req.user.user_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '记录不存在' });
    }
    if (check.rows[0].record_status !== 1) {
      return res.status(400).json({ code: 400, msg: '只有已提交的记录可以撤回' });
    }
    const lockMsg = await checkCycleReportLocked(req.user.user_id, record_id);
    if (lockMsg) {
      return res.status(400).json({ code: 400, msg: lockMsg });
    }
    await pool.query(
      'UPDATE work_record SET record_status = 0, update_time = NOW() WHERE record_id = $1',
      [record_id]
    );
    res.json({ code: 200, msg: '已撤回为草稿' });
    pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.user_id, req.user.username, req.user.real_name, 'recall_record', 'record', record_id, '撤回工作记录']
    ).catch(() => {});
  } catch (err) {
    console.error('Recall record error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 批量导入工作记录
router.post('/records/batch-import', authenticate, async (req, res) => {
  try {
    const { records } = req.body;
    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ code: 400, msg: '记录列表不能为空' });
    }
    if (records.length > 500) {
      return res.status(400).json({ code: 400, msg: '单次导入不能超过500条' });
    }
    let imported = 0;
    for (const item of records) {
      if (!item.record_date || !item.record_content) continue;
      if (item.record_content.length > 5000) continue;
      const result = await pool.query(
        `INSERT INTO work_record (user_id, record_date, record_content, record_status, submit_time)
         VALUES ($1, $2, $3, $4, $5) RETURNING record_id`,
        [req.user.user_id, item.record_date, item.record_content, item.record_status || 0, item.record_status === 1 ? new Date() : null]
      );
      await pool.query(
        `UPDATE work_record SET display_id = TO_CHAR(NOW(), 'YYMMDDHH24MI') WHERE record_id = $1`,
        [result.rows[0].record_id]
      );
      imported++;
    }
    res.json({ code: 200, msg: `成功导入 ${imported} 条记录` });
  } catch (err) {
    console.error('Batch import error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 删除工作记录（仅草稿可删，且周期汇报未提交）
router.delete('/records/:id', authenticate, async (req, res) => {
  try {
    const check = await pool.query(
      'SELECT record_status FROM work_record WHERE record_id = $1 AND user_id = $2 AND is_delete = 0',
      [req.params.id, req.user.user_id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '记录不存在' });
    }
    if (check.rows[0].record_status === 1) {
      return res.status(400).json({ code: 400, msg: '已正式提交的记录不可删除' });
    }
    const lockMsg = await checkCycleReportLocked(req.user.user_id, req.params.id);
    if (lockMsg) {
      return res.status(400).json({ code: 400, msg: lockMsg });
    }

    await pool.query('UPDATE work_record SET is_delete = 1, update_time = NOW() WHERE record_id = $1', [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

module.exports = router;
