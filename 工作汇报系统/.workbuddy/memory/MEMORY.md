# 工作记忆

## 项目：工作汇报系统
- 技术栈：Vue 3 + Vite 8 + Element Plus + Express 5 + PostgreSQL 18
- 后端端口：8902，前端开发端口：5173
- PostgreSQL 安装在 F:\PostgreSQL，密码是 123456（非默认的 postgres）
- 数据库 work_report_db 已创建，7张表已初始化

## 关键修复记录（2026-05-26）
1. **SQL参数占位符丢失**：所有4个路由文件（auth/user/record/report/audit.js）中 `$1, $2...` 参数占位符全部被吞掉，导致 JS 语法错误。已修复恢复。
2. **bcrypt前缀检测**：auth.js 中 `startsWith('')` 空字符串改为 `startsWith('$2a$')` / `startsWith('$2b$')`
3. **Express 5 通配符路由**：`app.get("*")` 改为 `app.get("/{*splat}")`（Express 5 使用 path-to-regexp v8 语法）
4. **数据库密码**：配置文件默认密码从 'postgres' 改为 '123456'
5. **init.sql 密码不一致**：注释写 admin123，实际 MD5 是 123456 的哈希。已修正为 admin123 的正确 MD5
6. **数据库和表未创建**：手动创建了 work_report_db 并执行 init.sql
7. **文件编码问题（GBK→UTF-8）**：init.sql 和6个后端JS文件原为 GBK 编码，导致中文乱码写入数据库。已全部转为 UTF-8，并修复数据库中已写入的乱码数据
8. **新建汇报弹窗内容残留（2026-05-30）**：保存/删除汇报后再次新建弹窗还显示上次内容。新增 `openCreateDialog()` 函数统一重置 `reportForm`、`workRecords`、`selectedRecordIds`、`selectAllRecords`、`showAllRecords`、`includeSubReports`、`isAiGenerated` 等状态

## 默认登录
- 用户名：admin / 密码：admin123

## AI 配置
- LM Studio 本地服务：`http://127.0.0.1:8080/v1/chat/completions`（必须用 127.0.0.1，不能用 localhost）
- API Token：`sk-lm-NkDwT4hM:ZhAY2Q5Y1QP7v7x0tzLS`
- 模型：Qwen3-1.7B（GGUF Q6_K）
- Qwen3 思考模式：用 `/no_think` 前缀关闭（`extra_body` 和 `chat_format` 对 LM Studio 无效）

## Windows 排障经验
- `taskkill /F` 在 Git Bash 中需写成 `taskkill //F`，否则参数被吞
- Node.js `fetch('http://localhost:...')` 解析到 IPv6 `[::1]`，本地服务只监听 IPv4 时需改用 `127.0.0.1`
- 数据库中文数据写入必须通过 Node.js（UTF-8），psql 终端直接写中文可能编码错误
- .bat 文件必须 GBK/ASCII 编码，.js/.vue/.sql 必须 UTF-8 编码

## 业务逻辑关键规则
- 工作记录锁定规则：基于 `report_record` 关联表查询（不再是日期范围匹配），`checkCycleReportLocked(userId, recordId)` 查 record_id 是否被 `report_status IN (1,2)` 的汇报引用
- 已通过(3)的汇报不锁定工作记录（审批已完成，撤回记录不影响已通过的汇报内容）
- 周期汇报状态流：草稿(0) → 已提交(1) → 已退回(2) / 已通过(3)
- 取消了工作记录自动生成周期汇报（syncToCycleReport 函数保留但不自动调用）
- 工作记录有 display_id（格式 YYMMDDHH24MI，如 2606011015），由 TO_CHAR(NOW(), 'YYMMDDHH24MI') 生成，前端表格显示
- 新建/提交周期汇报时自动关联该周期内已提交的工作记录到 report_record 表
- 前端创建汇报时可通过 checkbox 选择关联哪些工作记录
- 审批通知系统：领导退回/通过/备注时自动通知提交人，Layout 顶部铃铛 + Dashboard 通知卡片，60秒轮询未读数

## 包含下属汇报功能（设计验证，符合预期）
- 只加载**直接下属**的已通过周期汇报（`receiver_id = 当前用户`），跨级下属不加载——有意设计，因中间级汇报已汇总下级内容
- 下属汇报周期必须**完全落在**领导筛选周期范围内（`cycle_start >= start AND cycle_end <= end`）才加载——有意设计，确保下属汇报内容在领导汇报周期内
- 两个规则均已验证，符合设计意图，无需改动
