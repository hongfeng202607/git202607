const jwt = require('jsonwebtoken');
const config = require('../config');
const pool = require('../config/db');

// 验证JWT令牌
function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ code: 401, msg: '未登录，请先登录' });
  }
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    
    // 实时校验用户状态和 token_version
    pool.query(
      'SELECT is_delete, token_version FROM sys_user WHERE user_id = $1',
      [decoded.user_id]
    ).then(userCheck => {
      if (userCheck.rows.length === 0 || userCheck.rows[0].is_delete === 1) {
        return res.status(401).json({ code: 401, msg: '用户已被禁用或已删除' });
      }
      // token_version 校验（用于清退机制）
      const dbVersion = userCheck.rows[0].token_version || 0;
      if (dbVersion !== (decoded.token_version || 0)) {
        return res.status(401).json({ code: 401, msg: '账户已在其他设备登录或已被管理员清退' });
      }
      req.user = decoded;
      // 异步更新最后活跃时间，不阻塞请求
      pool.query('UPDATE sys_user SET last_active_time = NOW() WHERE user_id = $1', [decoded.user_id]).catch(() => {});
      next();
    }).catch(err => {
      console.error('Auth DB check error:', err.message);
      return res.status(500).json({ code: 500, msg: '服务器错误' });
    });
  } catch (err) {
    return res.status(401).json({ code: 401, msg: '令牌无效或已过期' });
  }
}

// 角色验证中间件
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ code: 401, msg: '未登录' });
    }
    if (!roles.includes(req.user.role_type)) {
      return res.status(403).json({ code: 403, msg: '无权限执行此操作' });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
