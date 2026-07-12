const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const recordRoutes = require('./routes/record');
const reportRoutes = require('./routes/report');
const auditRoutes = require('./routes/audit');
const notificationRoutes = require('./routes/notification');
const deptRoutes = require('./routes/dept');
const systemRoutes = require('./routes/system');

const app = express();

// 中间件
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// 路由注册
app.use('/api/auth', authRoutes);
app.use('/api', userRoutes);
app.use('/api', recordRoutes);
app.use('/api', reportRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api', notificationRoutes);
app.use('/api', deptRoutes);
app.use('/api/system', systemRoutes);


// 生产环境：托管构建好的前端静态文件
const path = require("path");
const frontendDist = path.join(__dirname, "..", "frontend", "dist");
const fs = require("fs");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get("/{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(frontendDist, "index.html"));
  });
  console.log("Frontend dist loaded:", frontendDist);
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ code: 200, msg: 'OK', time: new Date().toISOString() });
});

// 404
app.use((req, res) => {
  res.status(404).json({ code: 404, msg: '接口不存在' });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ code: 500, msg: '服务器内部错误' });
});

app.listen(config.port, () => {
  console.log('Work Report backend started on port ' + config.port);
});

module.exports = app;
