const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// 获取部门树形列表（全部）
router.get('/departments', authenticate, authorize(2, 3), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT dept_id, dept_name, parent_id, sort_order FROM department ORDER BY sort_order, dept_id'
    );
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error('Get departments error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 创建部门
router.post('/departments', authenticate, authorize(3), async (req, res) => {
  try {
    const { dept_name, parent_id, sort_order } = req.body;
    if (!dept_name) {
      return res.status(400).json({ code: 400, msg: '部门名称不能为空' });
    }
    if (dept_name.length > 50) {
      return res.status(400).json({ code: 400, msg: '部门名称不能超过50字符' });
    }
    // 检查同级下是否已有同名部门
    const exist = await pool.query(
      'SELECT dept_id FROM department WHERE dept_name = $1 AND parent_id IS NOT DISTINCT FROM $2 AND dept_id != COALESCE($3, 0)',
      [dept_name, parent_id || null, req.params.id || null]
    );
    if (exist.rows.length > 0) {
      return res.status(400).json({ code: 400, msg: '同级下已存在同名部门' });
    }
    const result = await pool.query(
      'INSERT INTO department (dept_name, parent_id, sort_order) VALUES ($1, $2, $3) RETURNING dept_id',
      [dept_name, parent_id || null, sort_order || 0]
    );
    res.json({ code: 200, data: { dept_id: result.rows[0].dept_id }, msg: '创建成功' });
  } catch (err) {
    console.error('Create department error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 更新部门
router.put('/departments/:id', authenticate, authorize(3), async (req, res) => {
  try {
    const { dept_name, parent_id, sort_order } = req.body;
    if (!dept_name) {
      return res.status(400).json({ code: 400, msg: '部门名称不能为空' });
    }
    if (dept_name.length > 50) {
      return res.status(400).json({ code: 400, msg: '部门名称不能超过50字符' });
    }
    // 防止把自己设为自己的父部门
    if (parseInt(req.params.id) === parseInt(parent_id)) {
      return res.status(400).json({ code: 400, msg: '不能将自己设为自己的上级部门' });
    }
    // 检查同级下是否已有同名部门（排除自身）
    const exist = await pool.query(
      'SELECT dept_id FROM department WHERE dept_name = $1 AND parent_id IS NOT DISTINCT FROM $2 AND dept_id != $3',
      [dept_name, parent_id || null, req.params.id]
    );
    if (exist.rows.length > 0) {
      return res.status(400).json({ code: 400, msg: '同级下已存在同名部门' });
    }
    await pool.query(
      'UPDATE department SET dept_name = $1, parent_id = $2, sort_order = $3 WHERE dept_id = $4',
      [dept_name, parent_id || null, sort_order || 0, req.params.id]
    );
    res.json({ code: 200, msg: '更新成功' });
  } catch (err) {
    console.error('Update department error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 删除部门
router.delete('/departments/:id', authenticate, authorize(3), async (req, res) => {
  try {
    const deptId = req.params.id;
    // 检查是否有子部门
    const childCheck = await pool.query(
      'SELECT COUNT(*) AS cnt FROM department WHERE parent_id = $1',
      [deptId]
    );
    if (parseInt(childCheck.rows[0].cnt) > 0) {
      return res.status(400).json({ code: 400, msg: '该部门下还有子部门，请先删除子部门' });
    }
    // 检查是否有用户
    const userCheck = await pool.query(
      'SELECT COUNT(*) AS cnt FROM sys_user WHERE dept_id = $1',
      [deptId]
    );
    if (parseInt(userCheck.rows[0].cnt) > 0) {
      return res.status(400).json({ code: 400, msg: '该部门下还有用户，请先调整用户部门' });
    }
    await pool.query('DELETE FROM department WHERE dept_id = $1', [deptId]);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    console.error('Delete department error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

module.exports = router;
