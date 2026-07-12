const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// 获取所有用户（管理员）
router.get('/users', authenticate, authorize(2, 3), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT user_id, username, real_name, role_type, dept_id, create_time FROM sys_user WHERE is_delete = 0 AND username != \'admin\' ORDER BY user_id'
    );
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 创建用户（管理员）
router.post('/users', authenticate, authorize(3), async (req, res) => {
  try {
    const { username, real_name, password, role_type, dept_id } = req.body;
    if (!username || !real_name || !password) {
      return res.status(400).json({ code: 400, msg: '用户名、姓名、密码不能为空' });
    }
    // 输入长度校验
    if (username.length > 50) {
      return res.status(400).json({ code: 400, msg: '用户名不能超过50字符' });
    }
    if (real_name.length > 50) {
      return res.status(400).json({ code: 400, msg: '姓名不能超过50字符' });
    }
    
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash(password, 10);
    
    const result = await pool.query(
      'INSERT INTO sys_user (username, real_name, password, role_type, dept_id) VALUES ($1, $2, $3, $4, $5) RETURNING user_id',
      [username, real_name, hashed, role_type || 1, dept_id || null]
    );
    
    res.json({ code: 200, data: { user_id: result.rows[0].user_id }, msg: '创建成功' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ code: 400, msg: '用户名已存在' });
    }
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 更新用户（含可选密码修改）
router.put('/users/:id', authenticate, authorize(3), async (req, res) => {
  try {
    const { real_name, role_type, dept_id, password } = req.body;
    // 输入长度校验
    if (real_name && real_name.length > 50) {
      return res.status(400).json({ code: 400, msg: '姓名不能超过50字符' });
    }
    if (password && password.length < 6) {
      return res.status(400).json({ code: 400, msg: '密码长度不能少于6位' });
    }
    if (password && password.length > 100) {
      return res.status(400).json({ code: 400, msg: '密码长度不能超过100字符' });
    }

    let sql = 'UPDATE sys_user SET real_name = $1, role_type = $2, dept_id = $3, update_time = NOW()';
    const params = [real_name, role_type, dept_id];
    let paramIdx = 4;

    if (password) {
      const bcrypt = require('bcryptjs');
      const hashed = await bcrypt.hash(password, 10);
      sql += ', password = $' + paramIdx++;
      params.push(hashed);
    }

    sql += ' WHERE user_id = $' + paramIdx;
    params.push(req.params.id);

    await pool.query(sql, params);
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 删除用户（软删除）
router.delete('/users/:id', authenticate, authorize(3), async (req, res) => {
  try {
    // 防止管理员删除自己的账号
    console.log('DELETE DEBUG: req.params.id=' + req.params.id + '(' + typeof req.params.id + '), req.user.user_id=' + req.user.user_id + '(' + typeof req.user.user_id + '), Number()比较结果:' + (Number(req.params.id) === Number(req.user.user_id)));
    if (String(req.params.id) === String(req.user.user_id)) {
      return res.status(400).json({ code: 400, msg: '不能删除自己的账号' });
    }
    await pool.query('UPDATE sys_user SET is_delete = 1, update_time = NOW() WHERE user_id = $1', [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// ===== 汇报关系管理 =====

// 获取所有汇报关系
router.get('/relations', authenticate, authorize(2, 3), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rr.relation_id, rr.reporter_id, rr.receiver_id,
        u1.real_name AS reporter_name, u2.real_name AS receiver_name
      FROM report_relation rr
      JOIN sys_user u1 ON rr.reporter_id = u1.user_id
      JOIN sys_user u2 ON rr.receiver_id = u2.user_id
      ORDER BY rr.relation_id`
    );
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 获取当前用户的汇报接收人（下属查上级）
router.get('/relations/my-receiver', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.real_name
      FROM report_relation rr
      JOIN sys_user u ON rr.receiver_id = u.user_id
      WHERE rr.reporter_id = $1`,
      [req.user.user_id]
    );
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 获取当前用户的汇报下属（上级查下属）
router.get('/relations/my-reporters', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.real_name, u.dept_id
      FROM report_relation rr
      JOIN sys_user u ON rr.reporter_id = u.user_id
      WHERE rr.receiver_id = $1`,
      [req.user.user_id]
    );
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 添加汇报关系
router.post('/relations', authenticate, authorize(3), async (req, res) => {
  try {
    const { reporter_id, receiver_id } = req.body;
    if (!reporter_id || !receiver_id) {
      return res.status(400).json({ code: 400, msg: '汇报人和接收人不能为空' });
    }
    if (reporter_id === receiver_id) {
      return res.status(400).json({ code: 400, msg: '汇报人和接收人不能相同' });
    }
    const result = await pool.query(
      'INSERT INTO report_relation (reporter_id, receiver_id) VALUES ($1, $2) RETURNING relation_id',
      [reporter_id, receiver_id]
    );
    res.json({ code: 200, data: { relation_id: result.rows[0].relation_id }, msg: '添加成功' });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ code: 400, msg: '该汇报关系已存在' });
    }
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 删除汇报关系
router.delete('/relations/:id', authenticate, authorize(3), async (req, res) => {
  try {
    await pool.query('DELETE FROM report_relation WHERE relation_id = $1', [req.params.id]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

module.exports = router;
