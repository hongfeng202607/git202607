const { Pool, types } = require('pg');
const config = require('./index');

// 修复 PostgreSQL 日期类型的解析
// 默认 pg 驱动把 date/timestamp 转为 JS Date（UTC），导致东八区时差和格式问题
// 改为直接返回字符串，避免时区转换和 ISO 格式化
// OID 参考: date=1082, timestamp=1114, timestamptz=1184
types.setTypeParser(1082, val => val);       // date → 'YYYY-MM-DD'
types.setTypeParser(1114, val => val);        // timestamp → 'YYYY-MM-DD HH:mm:ss'
types.setTypeParser(1184, val => val);        // timestamptz → 'YYYY-MM-DD HH:mm:ss+00'

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

module.exports = pool;
