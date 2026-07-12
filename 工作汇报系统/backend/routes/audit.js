const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// 递归查询所有间接下属（含自己）
async function findAllSubordinates(userId) {
  const result = await pool.query(`
    WITH RECURSIVE sub_tree AS (
      SELECT reporter_id AS user_id FROM report_relation WHERE receiver_id = $1
      UNION
      SELECT r.reporter_id FROM report_relation r JOIN sub_tree s ON r.receiver_id = s.user_id
    )
    SELECT user_id FROM sub_tree
  `, [userId]);
  const ids = result.rows.map(r => r.user_id);
  ids.push(userId);
  return ids;
}

// 获取待审核列表（上级查看下属的汇报单，超管查看全部）
router.get('/pending', authenticate, authorize(2, 3), async (req, res) => {
  try {
    const { status, scope } = req.query;
    const isAdmin = req.user.role_type === 3;
    let sql = `
      SELECT cr.*, u.real_name AS reporter_name, u.dept_id, d.dept_name,
             cr.cycle_start::text AS cycle_start, cr.cycle_end::text AS cycle_end,
             (SELECT u2.real_name FROM audit_log al
              JOIN sys_user u2 ON al.operator_id = u2.user_id
              WHERE al.report_id = cr.report_id
              ORDER BY al.create_time DESC LIMIT 1) AS last_operator_name,
             (SELECT al.action_type FROM audit_log al
              WHERE al.report_id = cr.report_id
              ORDER BY al.create_time DESC LIMIT 1) AS last_action_type
      FROM cycle_report cr
      JOIN sys_user u ON cr.user_id = u.user_id
      LEFT JOIN department d ON u.dept_id = d.dept_id
      WHERE cr.is_delete = 0
    `;
    const params = [];
    let paramIndex = 1;

    // 直属下属：只看直接汇报给自己的（超管也生效）
    if (scope === 'direct') {
      sql += ' AND cr.receiver_id = $' + paramIndex++;
      params.push(req.user.user_id);
    } else if (!isAdmin) {
      // 非超管 + 全部下属：多级穿透
      const subIds = await findAllSubordinates(req.user.user_id);
      const others = subIds.filter(id => id !== req.user.user_id);
      if (others.length > 0) {
        sql += ' AND cr.user_id = ANY($' + paramIndex++ + ') AND cr.receiver_id = ANY($' + paramIndex++ + ')';
        params.push(others, subIds);
      } else {
        sql += ' AND 1 = 0';
      }
    }
    // 超管 + 全部下属：不设过滤，看到所有

    if (status !== undefined && status !== '') {
      sql += ' AND cr.report_status = $' + paramIndex++;
      params.push(parseInt(status));
    } else {
      sql += ' AND cr.report_status IN (1, 2, 3)'; // 已提交、已退回、已通过
    }
    sql += ' ORDER BY cr.submit_time DESC';
    
    const result = await pool.query(sql, params);
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error('Get pending audits error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 审批通过
router.post('/approve', authenticate, authorize(2, 3), async (req, res) => {
  try {
    const { report_id, comment } = req.body;
    if (!report_id) {
      return res.status(400).json({ code: 400, msg: '汇报ID不能为空' });
    }

    // 验证权限：超管可审批任何汇报，上级只能审批提交给自己的
    const isAdmin = req.user.role_type === 3;
    let checkSql, checkParams;
    if (isAdmin) {
      checkSql = 'SELECT * FROM cycle_report WHERE report_id = $1 AND is_delete = 0 AND report_status = 1';
      checkParams = [report_id];
    } else {
      checkSql = 'SELECT * FROM cycle_report WHERE report_id = $1 AND receiver_id = $2 AND is_delete = 0 AND report_status = 1';
      checkParams = [report_id, req.user.user_id];
    }
    const check = await pool.query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(403).json({ code: 403, msg: '无权操作此汇报或状态不正确' });
    }

    // 更新汇报状态为已通过
    await pool.query(
      'UPDATE cycle_report SET report_status = 3, reject_reason = NULL WHERE report_id = $1',
      [report_id]
    );

    // 写入审批日志
    await pool.query(
      'INSERT INTO audit_log (report_id, operator_id, action_type, action_comment) VALUES ($1, $2, 3, $3)',
      [report_id, req.user.user_id, comment || '审批通过']
    );

    // 通知提交人：汇报已通过
    const reportInfo = await pool.query(
      'SELECT user_id, report_type, cycle_start::text, cycle_end::text FROM cycle_report WHERE report_id = $1',
      [report_id]
    );
    if (reportInfo.rows.length > 0) {
      const rp = reportInfo.rows[0];
      const typeText = { 1: '周报', 2: '月报', 3: '季报' }[rp.report_type] || '汇报';
      await pool.query(
        `INSERT INTO notification (user_id, type, title, content, report_id) VALUES ($1, 'approve', $2, $3, $4)`,
        [rp.user_id, `${typeText}已通过`, `${req.user.real_name} 审批通过了您 ${rp.cycle_start} ~ ${rp.cycle_end} 的${typeText}${comment ? '，评语：' + comment : ''}`, report_id]
      );
    }

    res.json({ code: 200, msg: '审批通过' });
    pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.user_id, req.user.username, req.user.real_name, 'approve', 'report', report_id, '审批通过汇报 #' + report_id]
    ).catch(() => {});
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 退回汇报
router.post('/reject', authenticate, authorize(2, 3), async (req, res) => {
  try {
    const { report_id, reason } = req.body;
    if (!report_id || !reason) {
      return res.status(400).json({ code: 400, msg: '汇报ID和退回原因不能为空' });
    }
    
    // 验证权限：超管可退回任何汇报，上级只能退回提交给自己的
    const isAdmin = req.user.role_type === 3;
    let checkSql, checkParams;
    if (isAdmin) {
      checkSql = 'SELECT * FROM cycle_report WHERE report_id = $1 AND is_delete = 0 AND report_status = 1';
      checkParams = [report_id];
    } else {
      checkSql = 'SELECT * FROM cycle_report WHERE report_id = $1 AND receiver_id = $2 AND is_delete = 0 AND report_status = 1';
      checkParams = [report_id, req.user.user_id];
    }
    const check = await pool.query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(403).json({ code: 403, msg: '无权操作或该汇报不可退回' });
    }
    
    // 更新汇报状态为已退回
    await pool.query(
      'UPDATE cycle_report SET report_status = 2, reject_reason = $1 WHERE report_id = $2',
      [reason, report_id]
    );
    
    // 写入审批日志
    await pool.query(
      'INSERT INTO audit_log (report_id, operator_id, action_type, action_comment) VALUES ($1, $2, 1, $3)',
      [report_id, req.user.user_id, reason]
    );

    // 通知提交人：汇报已退回
    const reportInfo = await pool.query(
      'SELECT user_id, report_type, cycle_start::text, cycle_end::text FROM cycle_report WHERE report_id = $1',
      [report_id]
    );
    if (reportInfo.rows.length > 0) {
      const rp = reportInfo.rows[0];
      const typeText = { 1: '周报', 2: '月报', 3: '季报' }[rp.report_type] || '汇报';
      await pool.query(
        `INSERT INTO notification (user_id, type, title, content, report_id) VALUES ($1, 'reject', $2, $3, $4)`,
        [rp.user_id, `${typeText}已退回`, `${req.user.real_name} 退回了您 ${rp.cycle_start} ~ ${rp.cycle_end} 的${typeText}，原因：${reason}`, report_id]
      );
    }
    
    res.json({ code: 200, msg: '退回成功' });
    pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.user_id, req.user.username, req.user.real_name, 'reject', 'report', report_id, '退回汇报 #' + report_id]
    ).catch(() => {});
  } catch (err) {
    console.error('Reject error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 添加备注
router.post('/comment', authenticate, authorize(2, 3), async (req, res) => {
  try {
    const { report_id, comment } = req.body;
    if (!report_id || !comment) {
      return res.status(400).json({ code: 400, msg: '汇报ID和备注内容不能为空' });
    }
    
    // 验证权限：超管可备注任何汇报，上级只能备注提交给自己的
    const isAdmin = req.user.role_type === 3;
    let checkSql, checkParams;
    if (isAdmin) {
      checkSql = 'SELECT * FROM cycle_report WHERE report_id = $1 AND is_delete = 0';
      checkParams = [report_id];
    } else {
      checkSql = 'SELECT * FROM cycle_report WHERE report_id = $1 AND receiver_id = $2 AND is_delete = 0';
      checkParams = [report_id, req.user.user_id];
    }
    const check = await pool.query(checkSql, checkParams);
    if (check.rows.length === 0) {
      return res.status(403).json({ code: 403, msg: '无权操作此汇报' });
    }
    
    // 写入审批日志
    await pool.query(
      'INSERT INTO audit_log (report_id, operator_id, action_type, action_comment) VALUES ($1, $2, 2, $3)',
      [report_id, req.user.user_id, comment]
    );

    // 通知提交人：收到新备注
    const reportInfo = await pool.query(
      'SELECT user_id, report_type, cycle_start::text, cycle_end::text FROM cycle_report WHERE report_id = $1',
      [report_id]
    );
    if (reportInfo.rows.length > 0) {
      const rp = reportInfo.rows[0];
      const typeText = { 1: '周报', 2: '月报', 3: '季报' }[rp.report_type] || '汇报';
      await pool.query(
        `INSERT INTO notification (user_id, type, title, content, report_id) VALUES ($1, 'comment', $2, $3, $4)`,
        [rp.user_id, `${typeText}收到新备注`, `${req.user.real_name} 对您 ${rp.cycle_start} ~ ${rp.cycle_end} 的${typeText}添加了备注：${comment}`, report_id]
      );
    }
    
    res.json({ code: 200, msg: '备注添加成功' });
  } catch (err) {
    console.error('Comment error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 重新提交被退回的汇报
router.post('/resubmit', authenticate, async (req, res) => {
  try {
    const { report_id, report_content } = req.body;
    if (!report_id || !report_content) {
      return res.status(400).json({ code: 400, msg: '参数错误' });
    }
    
    const check = await pool.query(
      'SELECT * FROM cycle_report WHERE report_id = $1 AND user_id = $2 AND report_status = 2',
      [report_id, req.user.user_id]
    );
    if (check.rows.length === 0) {
      return res.status(400).json({ code: 400, msg: '汇报单不存在或状态不正确' });
    }
    
    const report = check.rows[0];

    // 增量补充关联记录（保留用户之前手动选择的记录）
    await pool.query(
      `INSERT INTO report_record (report_id, record_id)
       SELECT $1, wr.record_id FROM work_record wr
       WHERE wr.user_id = $2 AND wr.record_status = 1 AND wr.is_delete = 0
       AND wr.record_date >= $3 AND wr.record_date <= $4
       ON CONFLICT (report_id, record_id) DO NOTHING`,
      [report_id, req.user.user_id, report.cycle_start, report.cycle_end]
    );

    await pool.query(
      `UPDATE cycle_report SET report_content = $1, report_status = 1, reject_reason = NULL, submit_time = NOW()
       WHERE report_id = $2`,
      [report_content, report_id]
    );

    // 通知上级：退回后重新提交
    const typeText = { 1: '周报', 2: '月报', 3: '季报' }[report.report_type] || '汇报';
    await pool.query(
      `INSERT INTO notification (user_id, type, title, content, report_id) VALUES ($1, 'submit', $2, $3, $4)`,
      [report.receiver_id, `${typeText}已重新提交`, `${req.user.real_name} 重新提交了 ${report.cycle_start} ~ ${report.cycle_end} 的${typeText}，请审核`, report_id]
    ).catch(err => console.error('Notify receiver error:', err.message));
    
    res.json({ code: 200, msg: '重新提交成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 获取审批日志
router.get('/logs/:report_id', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT al.*, u.real_name AS operator_name
       FROM audit_log al
       JOIN sys_user u ON al.operator_id = u.user_id
       WHERE al.report_id = $1
       ORDER BY al.create_time`,
      [req.params.report_id]
    );
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

module.exports = router;
