/**
 * 慧报空间 - PostgreSQL 数据库备份脚本
 * 用法：node backup.js
 * 
 * 依赖：已安装 pg_dump（PostgreSQL 自带）
 * 配置：修改下方 CONFIG 对象中的参数
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ===================== 配置区 =====================
const CONFIG = {
  // 数据库连接
  dbHost: process.env.DB_HOST || '127.0.0.1',
  dbPort: process.env.DB_PORT || '5432',
  dbName: process.env.DB_NAME || 'work_report_db',
  dbUser: process.env.DB_USER || 'postgres',
  dbPassword: process.env.DB_PASSWORD || '123456',

  // pg_dump 路径（自动适配 Linux / Windows）
  pgBin: process.platform === 'win32'
    ? 'F:\\PostgreSQL\\bin'
    : '/usr/bin',    // Linux 默认路径，也可以用 `which pg_dump` 自动查找

  // 备份文件保存目录（默认脚本所在目录下的 backup 文件夹）
  backupDir: path.join(__dirname, 'backup'),

  // 保留最近多少天的备份
  keepDays: 30,
};
// =================================================

function pad(n) {
  return String(n).padStart(2, '0');
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function log(msg, type = 'INFO') {
  const icons = { INFO: ' ', SUCCESS: ' ok', ERROR: ' x', WARN: ' !' };
  console.log(`[${icons[type] || ' '}] ${msg}`);
}

async function main() {
  console.log('');
  console.log('============================================');
  console.log('  慧报空间 - 数据库备份');
  console.log('============================================');
  console.log('');

  // 1. 检查 pg_dump 是否存在（自动适配 Linux / Windows）
  const pgDumpName = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
  let pgDump = path.join(CONFIG.pgBin, pgDumpName);

  // Linux 下如果指定路径找不到，尝试从 PATH 查找
  if (!fs.existsSync(pgDump) && process.platform !== 'win32') {
    try {
      const which = execSync('which pg_dump 2>/dev/null', { stdio: 'pipe' }).toString().trim();
      if (which) pgDump = which;
    } catch (e) { /* not in PATH */ }
  }

  if (!fs.existsSync(pgDump)) {
    log(`未找到 ${pgDumpName}，请检查 CONFIG.pgBin 配置`, 'ERROR');
    log(`当前值：${CONFIG.pgBin}`, 'WARN');
    console.log('');
    if (process.platform === 'win32') {
      console.log('试试：F:\\PostgreSQL\\bin');
      console.log('或：C:\\Program Files\\PostgreSQL\\16\\bin');
    } else {
      console.log('试试：sudo apt install postgresql-client-16');
      console.log('或：which pg_dump');
    }
    console.log('');
    process.exit(1);
  }
  log(`pg_dump 路径：${pgDump}`);

  // 2. 创建备份目录
  if (!fs.existsSync(CONFIG.backupDir)) {
    fs.mkdirSync(CONFIG.backupDir, { recursive: true });
  }

  // 3. 执行备份
  const fileName = `${CONFIG.dbName}_${timestamp()}.sql`;
  const filePath = path.join(CONFIG.backupDir, fileName);

  log(`数据库：${CONFIG.dbName}@${CONFIG.dbHost}:${CONFIG.dbPort}`);
  log(`保存到：${filePath}`);
  console.log('');

  try {
    process.env.PGPASSWORD = CONFIG.dbPassword;
    execSync(
      `"${pgDump}" -h ${CONFIG.dbHost} -p ${CONFIG.dbPort} -U ${CONFIG.dbUser} -d ${CONFIG.dbName} --no-owner --no-privileges -f "${filePath}"`,
      { stdio: 'pipe', timeout: 60000 }
    );
    process.env.PGPASSWORD = '';

    // 4. 检查备份文件
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      log(`备份完成！文件大小：${humanSize(stat.size)}`, 'SUCCESS');
    } else {
      log('备份文件未生成', 'ERROR');
      process.exit(1);
    }
  } catch (err) {
    process.env.PGPASSWORD = '';
    log(`备份失败：${err.message}`, 'ERROR');
    console.log('');
    console.log('可能的原因：');
    console.log('  1. PostgreSQL 服务未启动');
    console.log('  2. 密码不正确');
    console.log('  3. 数据库名称不正确');
    console.log('');
    console.log('测试连接命令：');
    console.log(`  "${path.join(CONFIG.pgBin, 'psql.exe')}" -h ${CONFIG.dbHost} -p ${CONFIG.dbPort} -U ${CONFIG.dbUser} -d ${CONFIG.dbName} -c "SELECT 1"`);
    console.log('');
    process.exit(1);
  }

  // 5. 清理旧备份
  console.log('');
  log(`清理 ${CONFIG.keepDays} 天前的备份...`);
  const files = fs.readdirSync(CONFIG.backupDir);
  const now = Date.now();
  const maxAge = CONFIG.keepDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const f of files) {
    if (!f.endsWith('.sql')) continue;
    const fp = path.join(CONFIG.backupDir, f);
    const stat = fs.statSync(fp);
    if (now - stat.mtimeMs > maxAge) {
      fs.unlinkSync(fp);
      deleted++;
    }
  }
  log(`共清理 ${deleted} 个旧备份文件`, deleted > 0 ? 'WARN' : 'INFO');

  console.log('');
  console.log('============================================');
  console.log(`  备份目录：${CONFIG.backupDir}`);
  console.log('============================================');
  console.log('');
}

main().catch(err => {
  console.error('备份脚本异常：', err);
  process.exit(1);
});
