const fs = require('fs');
const path = require('path');

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  const secretFile = path.join(__dirname, '..', 'jwt-secret.txt');
  if (fs.existsSync(secretFile)) {
    jwtSecret = fs.readFileSync(secretFile, 'utf8').trim();
  } else {
    console.error('FATAL: JWT_SECRET 环境变量未设置，且 jwt-secret.txt 不存在！');
    process.exit(1);
  }
}

module.exports = {
  port: process.env.PORT || 8902,
  jwtSecret,
  jwtExpiresIn: '24h',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'work_report_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '123456',
  },
};
