<template>
  <div class="page-container">
    <div class="page-header"><h2>系统管理</h2></div>
    <p style="color:#909399;margin-bottom:16px">在线用户、数据备份与系统日志管理。</p>

    <el-card>
      <el-tabs v-model="activeTab">
        <!-- ========== Tab 1: 在线用户 ========== -->
        <el-tab-pane label="在线用户" name="users">
          <el-table :data="onlineUsers" stripe v-loading="loadingUsers" style="width:100%">
            <el-table-column prop="username" label="用户名" width="110" />
            <el-table-column prop="real_name" label="姓名" width="100" />
            <el-table-column label="角色" width="100"><template #default="{row}"><el-tag :type="row.role_type===3?'danger':row.role_type===2?'warning':'info'" size="small">{{ {1:'员工',2:'管理者',3:'超管'}[row.role_type] }}</el-tag></template></el-table-column>
            <el-table-column label="在线状态" width="90">
              <template #default="{row}">
                <el-tag v-if="isOnline(row.last_active_time)" type="success" size="small">在线</el-tag>
                <el-tag v-else type="info" size="small">离线</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="最近活动" width="170"><template #default="{row}">{{ formatDate(row.last_active_time) || '从未' }}</template></el-table-column>
            <el-table-column prop="ai_call_count" label="AI调用" width="70" />
            <el-table-column label="最后AI调用" width="170"><template #default="{row}">{{ formatDate(row.last_ai_time) || '-' }}</template></el-table-column>
            <el-table-column label="操作" width="80">
              <template #default="{row}">
                <el-button v-if="row.user_id!==authStore.user?.user_id" text type="danger" size="small" @click="kickUser(row)">清退</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- ========== Tab 2: 数据备份 ========== -->
        <el-tab-pane label="数据备份" name="backup">
          <div style="margin-bottom:12px">
            <el-button type="primary" @click="createBackup" :loading="backingUp"><el-icon><Folder /></el-icon> 创建备份</el-button>
          </div>
          <el-table :data="backupFiles" stripe v-loading="loadingBackups" style="width:100%">
            <el-table-column prop="fileName" label="文件名" min-width="280" />
            <el-table-column label="大小" width="100"><template #default="{row}">{{ formatSize(row.size) }}</template></el-table-column>
            <el-table-column label="创建时间" width="170"><template #default="{row}">{{ formatDate(row.createTime) }}</template></el-table-column>
            <el-table-column label="操作" width="200">
              <template #default="{row}">
                <el-button text type="primary" size="small" @click="restoreBackup(row)">恢复</el-button>
                <el-button text type="danger" size="small" @click="deleteBackup(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- ========== Tab 3: 系统日志 ========== -->
        <el-tab-pane label="系统日志" name="logs">
          <div class="pagination-wrapper">
            <div class="pagination-left">
              <el-button size="small" @click="loadLogs">刷新</el-button>
              <el-button size="small" type="danger" plain @click="showCleanDialog=true">清理日志</el-button>
            </div>
            <div class="pagination-info">
              <span class="page-total">共 {{ logTotalPages }} 页</span>
              <el-select v-model="logPageSize" style="width:120px;margin-left:8px" @change="logPage=1;loadLogs()">
                <el-option label="每页 20 条" :value="20" />
                <el-option label="每页 50 条" :value="50" />
                <el-option label="每页 100 条" :value="100" />
              </el-select>
            </div>
          </div>
          <el-table :data="logs" stripe v-loading="loadingLogs" style="width:100%">
            <el-table-column label="时间" width="170"><template #default="{row}">{{ formatDate(row.create_time) }}</template></el-table-column>
            <el-table-column prop="username" label="用户" width="100" />
            <el-table-column label="操作" width="110"><template #default="{row}"><el-tag size="small">{{ actionLabel(row.action) }}</el-tag></template></el-table-column>
            <el-table-column label="详情" min-width="300"><template #default="{row}">{{ row.details || '-' }}</template></el-table-column>
          </el-table>
          <div v-if="logTotalPages > 1" style="text-align:center;margin-top:12px">
            <el-pagination background layout="prev,pager,next" :total="logTotal" :page-size="logPageSize" v-model:current-page="logPage" @current-change="loadLogs" />
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>
    <el-dialog v-model="showCleanDialog" title="清理日志" width="400px">
      <el-form label-width="100px">
        <el-form-item label="保留天数">
          <el-input-number v-model="cleanKeepDays" :min="1" :max="365" /> 天
        </el-form-item>
        <div style="color:#909399;font-size:13px;padding-left:100px">将删除 {{ cleanKeepDays }} 天前的所有操作日志（不可恢复）。</div>
      </el-form>
      <template #footer>
        <el-button @click="showCleanDialog=false">取消</el-button>
        <el-button type="danger" @click="cleanLogs">确认清理</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import api from "../../api"
import { useAuthStore } from "../../stores/auth"
import { formatDate } from "../../utils/format"
const authStore = useAuthStore()

const activeTab = ref('users')

// ========== 在线用户 ==========
const loadingUsers = ref(false); const onlineUsers = ref([])
async function loadOnlineUsers() {
  loadingUsers.value = true
  try { const r = await api.get("/system/online-users"); onlineUsers.value = r.data || [] }
  catch(e) { ElMessage.error(e.msg||"加载失败") }
  finally { loadingUsers.value = false }
}
function isOnline(t) {
  if (!t) return false
  return (Date.now() - new Date(t).getTime()) < 5 * 60 * 1000
}
async function kickUser(row) {
  await ElMessageBox.confirm(`确认清退用户「${row.real_name}」？清退后该用户需要重新登录。`, "清退确认", { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' })
  try { await api.post("/system/kick/" + row.user_id); ElMessage.success("清退成功"); await loadOnlineUsers() }
  catch(e) { ElMessage.error(e.msg||"操作失败") }
}

// ========== 数据备份 ==========
const backingUp = ref(false); const loadingBackups = ref(false); const backupFiles = ref([])
async function createBackup() {
  backingUp.value = true
  try { const r = await api.post("/system/backup"); ElMessage.success(r.msg||"备份完成"); await loadBackups() }
  catch(e) { ElMessage.error(e.msg||"备份失败") }
  finally { backingUp.value = false }
}
async function loadBackups() {
  loadingBackups.value = true
  try { const r = await api.get("/system/backups"); backupFiles.value = r.data || [] }
  catch(e) {} finally { loadingBackups.value = false }
}
async function restoreBackup(row) {
  await ElMessageBox.confirm(`确认使用「${row.fileName}」恢复数据库？此操作将覆盖当前所有数据！`, "恢复确认", { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' })
  try { const r = await api.post("/system/restore", { fileName: row.fileName }); ElMessage.success(r.msg||"恢复成功") }
  catch(e) { ElMessage.error(e.msg||"恢复失败") }
}
async function deleteBackup(row) {
  await ElMessageBox.confirm(`确认删除备份文件「${row.fileName}」？`, "删除确认", { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' })
  try { const r = await api.post("/system/backups/delete", { fileName: row.fileName }); ElMessage.success(r.msg||"删除成功"); await loadBackups() }
  catch(e) { ElMessage.error(e.msg||"删除失败") }
}
function formatSize(bytes) {
  if (!bytes) return '0B'
  const u = ['B','KB','MB','GB']; let i = 0
  while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++ }
  return bytes.toFixed(1) + u[i]
}

// ========== 系统日志 ==========
const loadingLogs = ref(false); const logs = ref([])
const logPage = ref(1); const logPageSize = ref(50); const logTotal = ref(0)
const logTotalPages = computed(() => Math.ceil(logTotal.value / logPageSize.value) || 1)
const showCleanDialog = ref(false); const cleanKeepDays = ref(30)
async function loadLogs() {
  loadingLogs.value = true
  try { const r = await api.get("/system/logs", { params: { page: logPage.value, pageSize: logPageSize.value } }); logs.value = r.data || []; logTotal.value = r.total || 0 }
  catch(e) {} finally { loadingLogs.value = false }
}
function actionLabel(a) {
  const map = { login:'登录', save_draft:'保存草稿', submit_record:'提交记录', recall_record:'撤回记录', delete_record:'删除记录', ai_generate:'AI生成', approve:'审批通过', reject:'审批退回', backup:'备份', restore:'恢复', kick:'清退', clean_logs:'清理日志' }
  return map[a] || a
}
async function cleanLogs() {
  try { const r = await api.post("/system/logs/clean", { keepDays: cleanKeepDays.value }); ElMessage.success(r.msg||"清理完成"); showCleanDialog.value = false; await loadLogs() }
  catch(e) { ElMessage.error(e.msg||"清理失败") }
}

onMounted(() => { loadOnlineUsers(); loadBackups(); loadLogs() })
</script>
<style scoped>
.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.page-header h2{font-size:22px;margin:0}
.pagination-wrapper{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.pagination-info{display:flex;align-items:center;font-size:13px;color:#606266}
.page-total{white-space:nowrap}
</style>
