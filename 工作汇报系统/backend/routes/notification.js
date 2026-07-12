const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');

// 获取当前用户的通知列表
router.get('/notifications', authenticate, async (req, res) => {
  try {
    const { unread_only } = req.query;
    let sql = `SELECT n.*, n.create_time::text AS create_time
               FROM notification n
               WHERE n.user_id = $1`;
    const params = [req.user.user_id];
    if (unread_only === '1') {
      sql += ' AND n.is_read = 0';
    }
    sql += ' ORDER BY n.create_time DESC LIMIT 50';
    const result = await pool.query(sql, params);
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 获取未读通知数量
router.get('/notifications/unread-count', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*) AS count FROM notification WHERE user_id = $1 AND is_read = 0',
      [req.user.user_id]
    );
    res.json({ code: 200, data: { count: parseInt(result.rows[0].count) } });
  } catch (err) {
    console.error('Get unread count error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 标记单条通知已读
router.post('/notifications/read', authenticate, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ code: 400, msg: '通知ID不能为空' });
    await pool.query(
      'UPDATE notification SET is_read = 1 WHERE id = $1 AND user_id = $2',
      [id, req.user.user_id]
    );
    res.json({ code: 200, msg: '已标记已读' });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 全部标记已读
router.post('/notifications/read-all', authenticate, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notification SET is_read = 1 WHERE user_id = $1 AND is_read = 0',
      [req.user.user_id]
    );
    res.json({ code: 200, msg: '已全部标记已读' });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

module.exports = router;
