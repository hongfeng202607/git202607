/**
 * 慧报空间 - 演示数据初始化脚本
 * 执行：cd backend && node init-demo-data.js
 * 
 * 功能：创建部门 → 用户 → 汇报关系 → 工作记录 → 周期汇报 → 审批通过
 * 完成后可用李主管账号测试"包含下属汇报"预览功能
 */
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: '127.0.0.1', port: 5432,
  database: 'work_report_db',
  user: 'postgres', password: '123456'
});

async function main() {
  console.log('开始初始化演示数据...\n');

  // ========== 1. 清理旧数据 ==========
  await pool.query('DELETE FROM report_record');
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM notification');
  await pool.query('DELETE FROM work_record');
  await pool.query('DELETE FROM cycle_report');
  await pool.query('DELETE FROM report_relation');
  await pool.query('DELETE FROM sys_user WHERE username != \'admin\'');
  await pool.query('DELETE FROM department');
  console.log('旧数据已清理\n');

  // ========== 2. 建部门 ==========
  await pool.query(`
    INSERT INTO department (dept_id, dept_name, parent_id, sort_order) VALUES
    (1, '管理层', NULL, 1),
    (2, '技术部', NULL, 2),
    (3, '研发组', 2, 1),
    (4, '测试组', 2, 2)
  `);
  console.log('部门：管理层、技术部、研发组、测试组');

  // ========== 3. 建用户 ==========
  const hash = await bcrypt.hash('123456', 10);
  await pool.query(`
    INSERT INTO sys_user (user_id, username, real_name, password, role_type, dept_id) VALUES
    (2, 'zhangzong',  '张总',   $1, 2, 1),
    (3, 'wangjingli', '王经理', $1, 2, 2),
    (4, 'lizhuguan',  '李主管', $1, 2, 3),
    (5, 'zhangsan',   '张三',   $1, 1, 3),
    (6, 'lisi',       '李四',   $1, 1, 3),
    (7, 'wangwu',     '王五',   $1, 1, 4)
  `, [hash]);
  console.log('用户：张总、王经理、李主管、张三、李四、王五（密码 123456）');

  // ========== 4. 汇报关系 ==========
  await pool.query(`
    INSERT INTO report_relation (reporter_id, receiver_id) VALUES
    (3, 2), (4, 3), (5, 4), (6, 4), (7, 3)
  `);
  console.log('汇报关系：张总←王经理←李主管←张三/李四，王经理←王五');

  // ========== 5. 工作记录 ==========
  const r1 = await pool.query(
    `INSERT INTO work_record (user_id, record_date, record_content, record_status, submit_time)
     VALUES (5, CURRENT_DATE, '完成了用户管理模块 CRUD 开发\n修复了登录页样式兼容性问题\n编写了 10 个单元测试', 1, NOW()) RETURNING record_id`
  );
  await pool.query(`UPDATE work_record SET display_id = TO_CHAR(NOW(), 'YYMMDDHH24MI') WHERE record_id = $1`, [r1.rows[0].record_id]);

  const r2 = await pool.query(
    `INSERT INTO work_record (user_id, record_date, record_content, record_status, submit_time)
     VALUES (6, CURRENT_DATE, '参加需求评审会议\n完成数据库表结构设计\n编写了接口文档', 1, NOW()) RETURNING record_id`
  );
  await pool.query(`UPDATE work_record SET display_id = TO_CHAR(NOW(), 'YYMMDDHH24MI') WHERE record_id = $1`, [r2.rows[0].record_id]);
  console.log('工作记录：张三、李四各 1 条');

  // ========== 6. 周期汇报 ==========
  const cycleStart = '2026-05-01';
  const cycleEnd = '2026-05-31';

  const c1 = await pool.query(
    `INSERT INTO cycle_report (user_id, receiver_id, report_type, cycle_start, cycle_end, report_content, generate_type, report_status, submit_time)
     VALUES (5, 4, 2, $1, $2, '本月完成了用户管理模块的开发工作，包含列表查询、新增、编辑、删除功能。\n修复了登录页在不同浏览器下的样式兼容性问题。\n编写了单元测试用例，覆盖率提升到 85%。', 1, 1, NOW()) RETURNING report_id`,
    [cycleStart, cycleEnd]
  );
  const c2 = await pool.query(
    `INSERT INTO cycle_report (user_id, receiver_id, report_type, cycle_start, cycle_end, report_content, generate_type, report_status, submit_time)
     VALUES (6, 4, 2, $1, $2, '本月参与了新项目需求评审，明确了技术方案和开发计划。\n完成了数据库核心表结构设计，包含 5 张表的完整 DDL。\n编写了 API 接口文档，覆盖所有业务接口。', 1, 1, NOW()) RETURNING report_id`,
    [cycleStart, cycleEnd]
  );
  await pool.query('INSERT INTO report_record (report_id, record_id) VALUES ($1, $2), ($3, $4)',
    [c1.rows[0].report_id, r1.rows[0].record_id, c2.rows[0].report_id, r2.rows[0].record_id]);
  console.log('周期汇报：张三、李四已提交月报给李主管');

  // ========== 7. 审批通过 ==========
  await pool.query(`
    INSERT INTO audit_log (report_id, operator_id, action_type, action_comment) VALUES
    ($1, 4, 3, '工作完成得不错，继续加油！'),
    ($2, 4, 3, '收到，辛苦了')
  `, [c1.rows[0].report_id, c2.rows[0].report_id]);
  await pool.query('UPDATE cycle_report SET report_status = 3 WHERE report_id IN ($1, $2)',
    [c1.rows[0].report_id, c2.rows[0].report_id]);
  console.log('审批：李主管已通过张三和李四的月报');

  // ========== 8. 通知 ==========
  await pool.query(`
    INSERT INTO notification (user_id, type, title, content, report_id) VALUES
    (5, 'approve', '月报已通过', '李主管通过了你的月报，意见：工作完成得不错，继续加油！', $1),
    (6, 'approve', '月报已通过', '李主管通过了你的月报，意见：收到，辛苦了', $2)
  `, [c1.rows[0].report_id, c2.rows[0].report_id]);

  // ========== 完成 ==========
  console.log('\n==================== 初始化完成 ====================');
  console.log('');
  console.log('登录信息：');
  console.log('  管理员：admin / admin123');
  console.log('  李主管：lizhuguan / 123456（可看到张三、李四的汇报）');
  console.log('  王经理：wangjingli / 123456（可看到李主管、张三、李四的汇报）');
  console.log('  张总：  zhangzong / 123456（可看到所有人的汇报）');
  console.log('  张三：  zhangsan / 123456（普通员工）');
  console.log('  李四：  lisi / 123456（普通员工）');
  console.log('  王五：  wangwu / 123456（普通员工）');
  console.log('');
  console.log('测试预览：');
  console.log('  1. 用李主管(lizhuguan)登录 → 新建汇报 → 加载记录');
  console.log('  2. 勾选"包含下属汇报" → 出现"预览"按钮');
  console.log('  3. 点击"预览"查看张三和李四的已通过月报');
  console.log('  4. 点击 AI 生成，汇报内容将包含下属的总结');

  pool.end();
}

main().catch(err => { console.error('初始化失败:', err); pool.end(); });
