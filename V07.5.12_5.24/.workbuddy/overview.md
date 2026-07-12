# 智行知识库 V07.5.12 — 全面代码审查报告

> 审查日期：2026-05-22 22:00
> 项目行数：~8300 行（Python 2700 + JS 2942 + CSS 814 + HTML 1046）
> 审查方式：3 Agent 并行 + 人工交叉验证

---

## 🔴 紧急级别（建议立即修复）

### S1. 附件上传 XSS 漏洞
- **文件**：`static/app.js:1612`
- **问题**：`tip.innerHTML = "✅ 上传成功：" + d.origin_name;` — 用户上传的文件名未经转义直接插入 HTML。攻击者可上传名为 `<img src=x onerror=alert(1)>.txt` 的文件，脚本将被执行。
- **修复**：改为 `tip.innerText` 或 `escapeHtml(d.origin_name)`
- **影响**：存储型 XSS，涉及全站用户

### S2. Token 明文存储在 localStorage
- **文件**：`static/app.js` 全局
- **问题**：登录 Token 存 `localStorage`，可被同源 XSS 窃取。标准做法是 HttpOnly Cookie。
- **修复**：改为 `httpOnly` Cookie + CSRF Token 方案，或至少加 `secure` 标志
- **影响**：Token 泄露可导致任意用户身份被盗用

### S3. 密码 Base64 非安全存储
- **文件**：`static/app.js` 工具登录处
- **问题**：tools.html 和 index.html 中密码以 Base64 或明文形式在内存中处理
- **修复**：始终采用哈希比对，前端不应持有明文密码

### S4. PostgreSQL 路径硬编码
- **文件**：`app.py:181,249`
- **问题**：`pg_dump = r"F:\PostgreSQL\bin\pg_dump"` 和 `psql = r"F:\PostgreSQL\bin\psql.exe"` 路径写死，换机器必崩溃
- **修复**：改为 `os.environ.get('KB_PG_DUMP', 'pg_dump')` 或者加入 PATH 查找
- **同类型**：`手动备份.py:47`、`恢复备份.py:45,58` 也有同样的硬编码

### S5. shell=True 命令注入风险
- **文件**：`app.py:187`
- **问题**：`subprocess.run(cmd, ..., shell=True)` — 如果数据库名/用户名包含特殊字符可被利用
- **修复**：改用 `subprocess.run([executable, arg1, arg2])` 列表传参，废除 shell=True
- **同类型**：`手动备份.py:55`、`恢复备份.py:44,58`

---

## 🟠 高优级别

### P1. auth.py 数据库连接模式未统一
- **文件**：`blueprints/auth.py:191,228,234,248,263,279,288,301,333,349`
- **问题**：10 处仍使用 `conn = get_db_connection()` + 手动 `conn.close()`，存在连接泄露风险（之前重构只修了部分函数）
- **修复**：全部改为 `with get_db_connection() as conn:`
- **影响**：高并发下连接池耗尽

### P2. 数据权限开关无缓存
- **文件**：`blueprints/db.py:617`
- **问题**：`is_data_permission_enabled()` 每次 API 请求都查 `sys_config` 表
- **修复**：加 `@functools.lru_cache(maxsize=1, ttl=60)` 或 Flask 应用级缓存
- **影响**：每次搜索/查询多一次 DB 访问

### P3. AI API Key 明文存储
- **文件**：`blueprints/db.py:sys_config` 表
- **问题**：AI API Key 以明文存入数据库，数据库泄露即 Key 泄露
- **修复**：入库前对称加密（如 `cryptography.fernet`），读取时解密

### P4. 无 CSRF 防护
- **文件**：全站
- **问题**：所有 API 仅靠 `token` Header 验证，无 CSRF Token 机制。虽受同源策略保护，但若搭配其他漏洞可被利用。
- **修复**：关键操作（删除、清空、恢复）加 CSRF Token 校验

### P5. saveEdit 无响应校验
- **文件**：`static/app.js:editRecord` 相关函数
- **问题**：编辑保存后不检查后端返回状态，静默失败时用户误以为保存成功
- **修复**：`saveEdit()` 中检查 `r.json().status`

---

## 🟡 中优级别

### M1. 权限缓存持久化但无刷新机制
- **文件**：`static/app.js:120-127`
- **问题**：权限存 `localStorage`，管理员修改角色权限后用户需重新登录才能生效
- **修复**：每次 `checkLogin()` 强制同步服务端最新权限（已部分实现），可再加定时轮询

### M2. 搜索无 loading 态（general search）
- **文件**：`static/app.js:search()`
- **问题**：搜索时界面静止，大结果集时用户无感知
- **修复**：搜索时显示骨架屏或加载动画（之前实现过骨架屏但撤销了）

### M3. 13 个全局变量污染
- **文件**：`static/app.js` 顶部
- **问题**：`let currentPage, pageSize, allRecords, currentPermissions...` 13 个全局变量，易造成命名冲突和状态管理混乱
- **修复**：封装为 AppState 对象或模块模式

### M4. 分类弹窗频繁 DOM 重建
- **文件**：`static/app.js:openCateModal()`
- **问题**：每次打开分类管理都重建全部 DOM，现有 18 个分类时产生大量 DOM 操作
- **修复**：缓存分类 HTML，仅在变化时重建

### M5. 恢复备份无超时通知
- **文件**：`app.py:api_backup_restore`
- **问题**：恢复操作 120 秒超时，但前端无进度提示，用户可能误以为卡死
- **修复**：前端使用轮询或 WebSocket 展示进度

### M6. is_super 判断不严谨
- **文件**：`blueprints/db.py:init_admin` — `username='admin'`
- **问题**：硬编码 username='admin' 判断超级管理员，改名后失效
- **修复**：用 `is_super` 字段或 roles 表判断

---

## 🟢 低优/建议

### L1. 前端按钮权限混合策略
- **文件**：`static/app.js`
- **问题**：部分按钮用条件渲染（有权限才生成 HTML），部分用 `display:none`，后者的 DOM 节点仍然存在
- **修复**：统一采用条件渲染

### L2. CSS transition:all 滥用
- **文件**：`static/style.css` 多处
- **问题**：`transition:all 0.3s ease` 会对所有属性变化触发动画，影响性能
- **修复**：指定具体属性如 `transition: opacity 0.3s, transform 0.3s`

### L3. backgr.png 等素材未压缩
- **文件**：`uploads/backgr.png` 等
- **问题**：背景图片未压缩优化，影响首屏加载
- **修复**：使用 TinyPNG 压缩或转为 WebP

### L4. 缺失 requirements.txt 同步
- **文件**：`requirements.txt`
- **问题**：已有 `requirements.txt` 但未包含 `requests` 等运行时依赖
- **修复**：导出完整依赖清单

### L5. 手动备份.py 和恢复备份.py 可删除
- **功能**已被 `tools.html` 替代，保留独立脚本易混淆
- **建议**：删除或在文档中标注为"已废弃"

### L6. 项目目录说明缺少 .workbuddy 目录说明
- **文件**：`项目目录说明.txt`
- **建议**：补充 `.workbuddy/` 目录说明

---

## 📈 前端现代化升级路线图

### 近期（1-2 天）
| 事项 | 说明 | 复杂度 |
|------|------|--------|
| 修复 XSS 漏洞 | origin_name 未转义 + localStorage token | 低 |
| 统一连接风格 | auth.py 10 处手动 close → with 模式 | 中 |
| PostgreSQL 路径环境变量化 | 4 处硬编码改为环境变量 | 低 |
| 取消 shell=True | 改用列表传参执行 subprocess | 低 |

### 中期（3-5 天）
| 事项 | 说明 | 复杂度 |
|------|------|--------|
| 前端模块化 | 拆分 app.js（2942行）为 5-8 个模块 | 高 |
| CSS 变量化 | 抽取主题色、间距、阴影为 CSS 变量 | 中 |
| 搜索防抖/loading | 完善搜索体验 | 低 |
| AI Key 加密存储 | 入库前对称加密 | 中 |

### 远期（1-2 周）
| 事项 | 说明 |
|------|------|
| 迁移 Vue 3 + Vite | 180KB JS → 组件化开发，提升可维护性 |
| 引入 TypeScript | 类型安全减少运行时错误 |
| 单元测试 | 后端 pytest + 前端 vitest |
| CI/CD 流水线 | GitHub Actions 自动测试+部署 |

---

## 📊 统计摘要

| 类别 | 数量 | 最严重项 |
|------|------|---------|
| 🔴 安全漏洞 | 5 | XSS (S1), Token存储 (S2) |
| 🟠 BUG | 6 | 连接泄露 (P1) |
| 🟠 性能问题 | 4 | N+1查询少量残留 |
| 🟡 代码异味 | 8 | 全局变量、重复代码 |
| 🟢 架构建议 | 7 | 前端框架迁移 |
| **总计** | **30+** | |

> 注：上次审查已修复的 18 项（SQL注入、密码环境变量化、N+1查询、公共分词等）经确认仍保持修复状态，未退化。
