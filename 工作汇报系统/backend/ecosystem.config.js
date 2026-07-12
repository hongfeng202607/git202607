/**
 * 慧报空间 - PM2 生产环境配置
 * 用法：pm2 start ecosystem.config.js
 *       pm2 save && pm2 startup（开机自启）
 */
module.exports = {
  apps: [{
    name: 'huibao',
    script: 'app.js',
    cwd: __dirname,

    // 环境变量（按实际修改）
    env: {
      NODE_ENV: 'production',
      PORT: 8902,
      DB_HOST: '127.0.0.1',
      DB_PORT: 5432,
      DB_NAME: 'work_report_db',
      DB_USER: 'postgres',
      DB_PASSWORD: '123456',
    },

    // 日志
    error_file: '/var/log/huibao/error.log',
    out_file: '/var/log/huibao/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    // 自动重启
    max_restarts: 10,
    restart_delay: 3000,
    max_memory_restart: '500M',

    // 进程守护
    instances: 1,
    exec_mode: 'fork',
  }]
};
