const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// 所有接口仅超级管理员可访问
router.use(authenticate, authorize(3));

// ==================== 在线用户 ====================

// 获取在线用户列表（含 AI 调用统计）
router.get('/online-users', async (req, res) => {
  try {
    const users = await pool.query(`
      SELECT u.user_id, u.username, u.real_name, u.role_type, u.last_active_time, u.token_version,
        COALESCE(ai.cnt, 0) AS ai_call_count,
        ai.last_ai_time
      FROM sys_user u
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS cnt, MAX(create_time) AS last_ai_time
        FROM system_log WHERE action = 'ai_generate'
        GROUP BY user_id
      ) ai ON u.user_id = ai.user_id
      WHERE u.is_delete = 0
      ORDER BY u.last_active_time DESC NULLS LAST
    `);
    res.json({ code: 200, data: users.rows });
  } catch (err) {
    console.error('Get online users error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// AI 调用统计（按用户分组）
router.get('/logs/ai-stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT user_id, username, real_name, COUNT(*) AS call_count, MAX(create_time) AS last_call_time
      FROM system_log WHERE action = 'ai_generate'
      GROUP BY user_id, username, real_name
      ORDER BY call_count DESC
    `);
    res.json({ code: 200, data: result.rows });
  } catch (err) {
    console.error('Get AI stats error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 清退用户
router.post('/kick/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    // 不能清退自己
    if (parseInt(userId) === req.user.user_id) {
      return res.status(400).json({ code: 400, msg: '不能清退自己' });
    }
    await pool.query('UPDATE sys_user SET token_version = token_version + 1, last_active_time = NULL WHERE user_id = $1', [userId]);
    // 清退日志
    await pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [req.user.user_id, req.user.username, req.user.real_name, 'kick', 'user', userId, '清退用户 #' + userId]
    ).catch(() => {});
    res.json({ code: 200, msg: '清退成功，该用户下次操作时将自动退出登录' });
  } catch (err) {
    console.error('Kick user error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// ==================== 数据备份 ====================

// 自动查找 pg_dump / psql 路径
function findTool(name) {
  const toolName = process.platform === 'win32' ? name + '.exe' : name;
  // Windows 常用路径
  const winPaths = [
    'F:\\PostgreSQL\\bin\\' + toolName,
    'C:\\Program Files\\PostgreSQL\\18\\bin\\' + toolName,
    'C:\\Program Files\\PostgreSQL\\17\\bin\\' + toolName,
    'C:\\Program Files\\PostgreSQL\\16\\bin\\' + toolName
  ];
  if (process.platform === 'win32') {
    const found = winPaths.find(p => fs.existsSync(p));
    if (found) return found;
  }
  try { const w = execSync('which ' + name + ' 2>/dev/null', { stdio: 'pipe' }).toString().trim(); if (w) return w; } catch(e) {}
  return name; // fallback to bare command
}

// 执行备份
router.post('/backup', async (req, res) => {
  try {
    const backupDir = path.resolve(__dirname, '..', 'backup');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const pad = n => String(n).padStart(2, '0');
    const d = new Date();
    const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    const fileName = `慧报空间备份_${ts}.sql`;
    const filePath = path.join(backupDir, fileName);

    const pgDump = findTool('pg_dump');

    const db = require('../config');
    process.env.PGPASSWORD = db.db.password;
    execSync(
      `"${pgDump}" -h ${db.db.host} -p ${db.db.port} -U ${db.db.user} -d ${db.db.database} --no-owner --no-privileges -f "${filePath}"`,
      { stdio: 'pipe', timeout: 60000 }
    );
    process.env.PGPASSWORD = '';

    // gzip
    let gzipPath = filePath;
    try { execSync(`gzip -f "${filePath}"`, { stdio: 'pipe' }); gzipPath = filePath + '.gz'; } catch(e) {}

    const stat = fs.statSync(gzipPath);

    await pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, details) VALUES ($1, $2, $3, $4, $5)',
      [req.user.user_id, req.user.username, req.user.real_name, 'backup', '备份数据库：' + fileName]
    ).catch(() => {});

    res.json({ code: 200, data: { fileName: path.basename(gzipPath), size: stat.size }, msg: '备份完成' });
  } catch (err) {
    process.env.PGPASSWORD = '';
    console.error('Backup error:', err);
    res.status(500).json({ code: 500, msg: '备份失败：' + (err.message || '') });
  }
});

// 获取备份文件列表
router.get('/backups', async (req, res) => {
  try {
    const backupDir = path.resolve(__dirname, '..', 'backup');
    if (!fs.existsSync(backupDir)) return res.json({ code: 200, data: [] });

    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.sql') || f.endsWith('.sql.gz'))
      .map(f => {
        const fp = path.join(backupDir, f);
        const stat = fs.statSync(fp);
        return { fileName: f, size: stat.size, createTime: stat.mtime };
      })
      .sort((a, b) => b.createTime - a.createTime);

    res.json({ code: 200, data: files });
  } catch (err) {
    console.error('List backups error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 恢复数据库
router.post('/restore', async (req, res) => {
  try {
    const { fileName } = req.body;
    if (!fileName) return res.status(400).json({ code: 400, msg: '请指定备份文件' });

    const backupDir = path.resolve(__dirname, '..', 'backup');
    let filePath = path.join(backupDir, fileName);

    if (!fs.existsSync(filePath)) return res.status(404).json({ code: 404, msg: '备份文件不存在' });

    // 如果是 .gz 先解压
    let restoreFile = filePath;
    if (fileName.endsWith('.gz')) {
      restoreFile = filePath.replace('.gz', '');
      if (!fs.existsSync(restoreFile)) {
        execSync(`gzip -d -k -f "${filePath}"`, { stdio: 'pipe' });
      }
    }

    const db = require('../config');
    process.env.PGPASSWORD = db.db.password;
    const psql = findTool('psql');
    execSync(
      `"${psql}" -h ${db.db.host} -p ${db.db.port} -U ${db.db.user} -d ${db.db.database} -f "${restoreFile}"`,
      { stdio: 'pipe', timeout: 120000 }
    );
    process.env.PGPASSWORD = '';

    await pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, details) VALUES ($1, $2, $3, $4, $5)',
      [req.user.user_id, req.user.username, req.user.real_name, 'restore', '恢复数据库：' + fileName]
    ).catch(() => {});

    res.json({ code: 200, msg: '恢复成功' });
  } catch (err) {
    process.env.PGPASSWORD = '';
    console.error('Restore error:', err);
    res.status(500).json({ code: 500, msg: '恢复失败：' + (err.message || '') });
  }
});

// 删除备份文件
router.post('/backups/delete', async (req, res) => {
  try {
    const { fileName } = req.body;
    if (!fileName) return res.status(400).json({ code: 400, msg: '请指定备份文件' });
    const backupDir = path.resolve(__dirname, '..', 'backup');
    const filePath = path.join(backupDir, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ code: 404, msg: '文件不存在' });
    fs.unlinkSync(filePath);
    // 如果存在对应的 .gz 文件也一并删除
    const gzipPath = filePath + '.gz';
    if (fs.existsSync(gzipPath)) fs.unlinkSync(gzipPath);
    await pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, details) VALUES ($1, $2, $3, $4, $5)',
      [req.user.user_id, req.user.username, req.user.real_name, 'delete_backup', '删除备份文件：' + fileName]
    ).catch(() => {});
    res.json({ code: 200, msg: '已删除' });
  } catch (err) {
    console.error('Delete backup error:', err);
    res.status(500).json({ code: 500, msg: '删除失败' });
  }
});

// ==================== 系统日志 ====================

// 获取操作日志
router.get('/logs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const countResult = await pool.query('SELECT COUNT(*) AS total FROM system_log');
    const total = parseInt(countResult.rows[0].total);

    const result = await pool.query(
      'SELECT * FROM system_log ORDER BY create_time DESC LIMIT $1 OFFSET $2',
      [pageSize, offset]
    );

    res.json({ code: 200, data: result.rows, total });
  } catch (err) {
    console.error('Get logs error:', err);
    res.status(500).json({ code: 500, msg: '服务器错误' });
  }
});

// 清理日志（手动触发）
router.post('/logs/clean', async (req, res) => {
  try {
    const keepDays = Math.max(1, parseInt(req.body.keepDays) || 30);
    const result = await pool.query(
      'DELETE FROM system_log WHERE create_time < NOW() - $1::INTERVAL',
      [keepDays + ' days']
    );
    const deleted = result.rowCount;
    await pool.query(
      'INSERT INTO system_log (user_id, username, real_name, action, details) VALUES ($1, $2, $3, $4, $5)',
      [req.user.user_id, req.user.username, req.user.real_name, 'clean_logs', `清理 ${deleted} 条 ${keepDays} 天前的日志`]
    ).catch(() => {});
    res.json({ code: 200, msg: `已清理 ${deleted} 条日志`, data: { deleted } });
  } catch (err) {
    console.error('Clean logs error:', err);
    res.status(500).json({ code: 500, msg: '清理失败' });
  }
});

// 自动清理：每天凌晨3点删除30天前的日志
const CLEAN_INTERVAL = 24 * 60 * 60 * 1000; // 24h
function scheduleLogCleanup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(async () => {
    try {
      const r = await pool.query("DELETE FROM system_log WHERE create_time < NOW() - INTERVAL '30 days'");
      if (r.rowCount > 0) console.log(`[AutoClean] 已清理 ${r.rowCount} 条过期日志`);
    } catch (e) { console.error('[AutoClean] 清理失败:', e.message); }
    setInterval(async () => {
      try {
        const r = await pool.query("DELETE FROM system_log WHERE create_time < NOW() - INTERVAL '30 days'");
        if (r.rowCount > 0) console.log(`[AutoClean] 已清理 ${r.rowCount} 条过期日志`);
      } catch (e) { console.error('[AutoClean] 清理失败:', e.message); }
    }, CLEAN_INTERVAL);
  }, delay);
  console.log(`[AutoClean] 下次自动清理: ${next.toLocaleString()}`);
}
scheduleLogCleanup();

module.exports = router;
