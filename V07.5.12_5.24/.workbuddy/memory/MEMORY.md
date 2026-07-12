# 智行知识库 — 长期记忆

## 项目版本
- 当前版本：V07.5.12（数据权限功能）
- 数据库：PostgreSQL，连接 localhost:5432/knowledge_base，用户 postgres/123456
- 架构：Flask + HTML5 单页应用，蓝图模块化（auth/knowledge/ai/attachment/category/role/data_permission）

## 关键功能模块
- RBAC权限系统：roles/permissions/role_permissions/users 表，支持自定义角色
- 权限依赖联动：`PERM_DEPENDS` 对象配置，勾选/取消自动联动（edit→view, delete→view, permanent_del→recycle.view 等）
- 前端 hasPermission(code)：currentPermissions 含 code 或 isSadmin=true 即通过
- 数据权限（V07.5.12新增）：user_data_permissions 表 + sys_config 开关，按创建人隔离知识记录
- AI配置：sys_config 存 ai_api_url/ai_api_key/ai_model，需 ai.manage 权限
- 查重系统：前端 localStorage 存 dedupEnabled/dedupModes/dedupThreshold，需 settings.dedup 权限

## 权限体系
- permissions 表字段：id(code PK)、name、group_name
- 系统设置分组（group_name='系统设置'）：settings.dedup(查重)、settings.data_perm(数据权限)
- 已删除 settings.view（无用权限）
- 设置按钮入口：有 settings.dedup 或 settings.data_perm 或 ai.manage 任一权限即可见
- 顶部工具栏按钮：无权限隐藏（display:none）
- 功能区域操作按钮：无权限置灰（perm-disabled class）
- super_admin（isSadmin）前端豁免所有权限检查；后端 require_permission 也加 _is_sadmin 豁免

## 数据权限逻辑
- 开关：sys_config key=data_permission_enabled，值为 0/1
- 过滤函数：build_data_perm_where(conn, username, base_where, params) 统一封装
- admin/super 豁免不受限制
- 普通用户只能看 submitter IN (自己 + 被授权的用户)
- user_data_permissions 表：granted_user_id（普通用户）+ granted_username（其他创建人）两种授权方式
- "其他"创建人：knowledge 表 submitter 存在但不在 users 表中（排除 admin/sadmin）
- 授权管理入口：系统设置 → 数据权限 → 授权管理弹窗（含"其他"分组）
- 后端数据权限API权限码：toggle/grant/grants 均仅需 settings.data_perm 权限，无额外超管限制
- 设置弹窗打开与AI配置加载解耦：AI配置失败不阻塞弹窗打开
- 手风琴默认收起状态

## 开发者偏好
- 公司已禁用DeepSeek，AI配置需用其他API
- 管理员角色判断：username='admin' 或 is_super=1 或 roles.name='admin'

## 管理工具
- `tools.html`（`/tools`）提供数据管理：导出Excel、导入恢复、清空记录
- 备份/恢复 API（V07.5.12 新增）：`/api/backup/manual` / list / restore，通过 tools.html 界面操作
- 操作日志可视化（2026-05-23 新增）：`/api/logs` GET API，集成在数据管理弹窗，支持分页/关键词/级别过滤
- 仪表盘改版（2026-05-23）：`/api/dashboard` GET API，返回分类分布/7天趋势/最近活动/星标数；前端 stat-box 改为6卡片布局（4统计+环形图+动态）
- 最新动态优化（2026-05-23）：白名单过滤17类业务事件，知识CRUD日志含标题+分类，每条动态带 action_type/icon/color；过滤AI调试/备份运维等技术日志
- 环境变量配置：KB_DB_HOST/PORT/USER/PASSWORD/NAME + KB_PG_BIN（PostgreSQL bin 目录）

## 已知待修复问题
- knowledge.py 有 DEBUG 路由 `/debug_backup` 和 print 调试语句（应移除）
- SECRET_KEY 每次重启变化（app.py 用 uuid4 生成）
- 部分 except 过于宽泛（裸 except）
- 文档中 DB 用户名已修正为 postgres（2026-05-23 修复）
