const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const config = require('../config');
const { authenticate } = require('../middleware/auth');

// 密码MD5简单哈希（用于默认密码兼容）
const crypto = require('crypto');
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// 用户登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ code: 400, msg: '用户名和密码不能为空' });
    }

    const result = await pool.query(
      'SELECT * FROM sys_user WHERE username = $1 AND is_delete = 0',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ code: 401, msg: '用户名或密码错误' });
    }

    const user = result.rows[0];
    
    // 验证密码：尝试bcrypt比较，兼容MD5旧密码
    let valid = false;
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
      valid = await bcrypt.compare(password, user.password);
    } else {
      valid = (md5(password) === user.password);
      // 如果MD5匹配，升级为bcrypt
      if (valid) {
        const hashed = await bcrypt.hash(password, 10);
        await pool.query('UPDATE sys_user SET password = $1 WHERE user_id = $2', [hashed, user.user_id]);
      }
    }

    if (!valid) {
      return res.status(401).json({ code: 401, msg: '用户名或密码错误' });
    }

    const token = jwt.sign(
      { user_id: user.user_id, username: user.username, real_name: user.real_name, role_type: user.role_type, dept_id: user.dept_id, token_version: user.token_version || 0 },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    res.json({
      code: 200,
      data: {
        token,
        user: {
          user_id: user.user_id,
          username: user.username,
          real_name: user.real_name,
          role_type: user.role_type,
          dept_id: user.dept_id,
        },
      },
    });
    // 登录日志
    await pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, details) VALUES ($1, $2, $3, $4, $5)',
      [user.user_id, user.username, user.real_name, 'login', '登录系统']
    ).catch(() => {});
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 获取当前用户信息
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT user_id, username, real_name, role_type, dept_id, create_time FROM sys_user WHERE user_id = $1 AND is_delete = 0',
      [req.user.user_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '用户不存在' });
    }
    res.json({ code: 200, data: result.rows[0] });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 修改密码
router.put('/password', authenticate, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const userResult = await pool.query('SELECT password FROM sys_user WHERE user_id = $1', [req.user.user_id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ code: 404, msg: '用户不存在' });
    }
    
    const user = userResult.rows[0];
    let valid = false;
    if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
      valid = await bcrypt.compare(oldPassword, user.password);
    } else {
      valid = (md5(oldPassword) === user.password);
    }
    
    if (!valid) {
      return res.status(400).json({ code: 400, msg: '原密码错误' });
    }
    
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE sys_user SET password = $1, update_time = NOW() WHERE user_id = $2', [hashed, req.user.user_id]);
    
    res.json({ code: 200, msg: '密码修改成功' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

module.exports = router;
