<template>
  <el-container class="layout-container">
    <el-aside :width="isCollapse ? '64px' : '220px'" class="layout-aside">
      <div class="aside-header" @click="isCollapse = !isCollapse">
        <span v-if="!isCollapse" class="aside-title">慧报空间</span>
        <el-icon v-else size="20"><Fold /></el-icon>
      </div>
      <el-menu :default-active="route.path" :collapse="isCollapse" :collapse-transition="false"
        background-color="#1d1e1f" text-color="#bfcbd9" active-text-color="#409EFF" router>
        <template v-for="item in menuItems" :key="item.path">
          <el-menu-item v-if="!item.roles || item.roles.includes(authStore.roleType)" :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon>
            <template #title>{{ item.title }}</template>
          </el-menu-item>
        </template>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="layout-header">
        <div class="header-left">
          <el-breadcrumb><el-breadcrumb-item :to="{path:'/dashboard'}">首页</el-breadcrumb-item><el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item></el-breadcrumb>
        </div>
        <div class="header-right">
          <el-popover placement="bottom-end" :width="380" trigger="click" @show="fetchNotifications">
            <template #reference>
              <el-badge :value="unreadCount || ''" :hidden="!unreadCount" :max="99" class="notify-badge">
                <el-icon :size="20" style="cursor:pointer;color:#606266"><Bell /></el-icon>
              </el-badge>
            </template>
            <div class="notify-panel">
              <div class="notify-header">
                <span class="notify-title">通知</span>
                <el-button v-if="unreadCount" link type="primary" size="small" @click="readAll">全部已读</el-button>
              </div>
              <div v-if="notifyLoading" style="text-align:center;padding:20px"><el-icon class="is-loading"><Loading /></el-icon></div>
              <div v-else-if="!notifications.length" style="text-align:center;padding:20px;color:#909399">暂无通知</div>
              <div v-else class="notify-list">
                <div v-for="n in notifications" :key="n.id" class="notify-item" :class="{ unread: !n.is_read }" @click="handleNotify(n)">
                  <div class="notify-item-left">
                    <el-icon :size="18" :color="n.type==='approve'?'#67C23A':n.type==='reject'?'#F56C6C':n.type==='submit'?'#E6A23C':'#409EFF'">
                      <component :is="n.type==='approve'?'CircleCheck':n.type==='reject'?'CircleClose':n.type==='submit'?'UploadFilled':'ChatDotRound'" />
                    </el-icon>
                  </div>
                  <div class="notify-item-body">
                    <div class="notify-item-title">{{ n.title }}</div>
                    <div class="notify-item-content">{{ n.content }}</div>
                    <div class="notify-item-time">{{ formatDate(n.create_time) }}</div>
                  </div>
                </div>
              </div>
            </div>
          </el-popover>
          <el-dropdown trigger="click">
            <span class="user-info">
              <el-avatar :size="32" icon="UserFilled" />
              <span class="user-name">{{ authStore.user?.real_name }}</span>
              <span class="user-role">({{ authStore.roleName }})</span>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown><el-dropdown-menu><el-dropdown-item @click="showPwdDialog=true">修改密码</el-dropdown-item><el-dropdown-item @click="handleLogout">退出登录</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </el-header>
      <el-main class="layout-main"><router-view /></el-main>
    </el-container>
  </el-container>
  <el-dialog v-model="showPwdDialog" title="修改密码" width="420px">
    <el-form :model="pwdForm" label-width="100px">
      <el-form-item label="原密码"><el-input v-model="pwdForm.oldPassword" type="password" show-password /></el-form-item>
      <el-form-item label="新密码"><el-input v-model="pwdForm.newPassword" type="password" show-password /></el-form-item>
      <el-form-item label="确认密码"><el-input v-model="pwdForm.confirmPassword" type="password" show-password /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="showPwdDialog=false">取消</el-button>
      <el-button type="primary" @click="handleChangePwd" :loading="pwdLoading">确认修改</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue"
import { useRoute, useRouter } from "vue-router"
import { useAuthStore } from "../stores/auth"
import { ElMessageBox, ElMessage } from "element-plus"
import api from "../api"
import { formatDate } from "../utils/format"
const route = useRoute(); const router = useRouter(); const authStore = useAuthStore(); const isCollapse = ref(false)

// 通知相关
const notifications = ref([])
const unreadCount = ref(0)
const notifyLoading = ref(false)
let pollTimer = null

async function fetchUnreadCount() {
  try { const r = await api.get("/notifications/unread-count"); unreadCount.value = r.data?.count || 0 } catch(e) {}
}
async function fetchNotifications() {
  notifyLoading.value = true
  try { const r = await api.get("/notifications"); notifications.value = r.data || [] } catch(e) {}
  finally { notifyLoading.value = false }
}
async function readAll() {
  try { await api.post("/notifications/read-all"); unreadCount.value = 0; await fetchNotifications() } catch(e) {}
}
async function handleNotify(n) {
  if (!n.is_read) {
    try { await api.post("/notifications/read", { id: n.id }); n.is_read = 1; unreadCount.value = Math.max(0, unreadCount.value - 1) } catch(e) {}
  }
  if (n.report_id) router.push(n.type === 'submit' ? '/audit' : '/reports')
}
const menuItems = [
  { path: "/dashboard", title: "工作台", icon: "Odometer" },
  { path: "/records", title: "工作记录", icon: "Document" },
  { path: "/reports", title: "周期汇报", icon: "TrendCharts" },
  { path: "/audit", title: "审批管理", icon: "Finished", roles: [2, 3] },
  { path: "/admin/users", title: "用户管理", icon: "User", roles: [3] },
  { path: "/admin/relations", title: "汇报关系", icon: "Connection", roles: [3] },
  { path: "/admin/departments", title: "部门管理", icon: "OfficeBuilding", roles: [3] },
  { path: "/admin/ai-config", title: "AI 配置", icon: "Setting", roles: [3] },
  { path: "/admin/system", title: "系统管理", icon: "Tools", roles: [3] },
]
const currentTitle = computed(() => { const item = menuItems.find(m => m.path === route.path); return item?.title || "" })
function handleLogout() { ElMessageBox.confirm("确认退出登录？", "提示", { confirmButtonText: '确定', cancelButtonText: '取消' }).then(() => { authStore.logout(); router.push("/login") }).catch(() => {}) }

// 修改密码
const showPwdDialog = ref(false); const pwdLoading = ref(false)
const pwdForm = ref({ oldPassword: "", newPassword: "", confirmPassword: "" })
async function handleChangePwd() {
  const f = pwdForm.value
  if (!f.oldPassword || !f.newPassword) { ElMessage.warning("请填写完整"); return }
  if (f.newPassword !== f.confirmPassword) { ElMessage.warning("两次密码不一致"); return }
  if (f.newPassword.length < 6) { ElMessage.warning("新密码至少6位"); return }
  pwdLoading.value = true
  try {
    await api.put("/auth/password", { oldPassword: f.oldPassword, newPassword: f.newPassword })
    ElMessage.success("密码修改成功")
    showPwdDialog.value = false; f.oldPassword = ""; f.newPassword = ""; f.confirmPassword = ""
  } catch (e) { ElMessage.error(e.msg || "修改失败") }
  finally { pwdLoading.value = false }
}

onMounted(() => { fetchUnreadCount(); pollTimer = setInterval(fetchUnreadCount, 60000) })
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>
<style scoped>
.layout-container { height: 100vh; }
.layout-aside { background-color: #1d1e1f; overflow-y: auto; transition: width 0.3s; }
.aside-header { height: 60px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 18px; font-weight: 600; cursor: pointer; border-bottom: 1px solid #2a2b2c; }
.aside-title { white-space: nowrap; }
.layout-header { display: flex; align-items: center; justify-content: space-between; background: #fff; border-bottom: 1px solid #e4e7ed; padding: 0 20px; height: 60px; }
.layout-main { background: #f5f7fa; padding: 20px; overflow-y: auto; }
.user-info { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.user-name { font-size: 14px; color: #303133; }
.user-role { font-size: 12px; color: #909399; }
.notify-badge { margin-right: 16px; display: inline-flex; align-items: center; }
.notify-panel { max-height: 400px; }
.notify-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid #ebeef5; margin-bottom: 4px; }
.notify-title { font-weight: 600; font-size: 15px; color: #303133; }
.notify-list { max-height: 340px; overflow-y: auto; }
.notify-item { display: flex; gap: 10px; padding: 10px 4px; border-bottom: 1px solid #f2f3f5; cursor: pointer; border-radius: 4px; }
.notify-item:hover { background: #f5f7fa; }
.notify-item.unread { background: #ecf5ff; }
.notify-item.unread:hover { background: #d9ecff; }
.notify-item-left { padding-top: 2px; }
.notify-item-body { flex: 1; min-width: 0; }
.notify-item-title { font-size: 14px; font-weight: 500; color: #303133; }
.notify-item-content { font-size: 12px; color: #606266; margin-top: 2px; word-break: break-all; }
.notify-item-time { font-size: 11px; color: #c0c4cc; margin-top: 4px; }
</style>
