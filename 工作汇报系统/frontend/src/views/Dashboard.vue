<template>
  <div class="page-container">
    <div class="page-header"><h2>工作台</h2></div>
    <p style="color:#909399;margin-bottom:16px">数据概览和快捷操作入口。</p>
    <el-row :gutter="20">
      <el-col :span="6"><el-card shadow="hover"><div class="stat-item"><el-icon :size="32" color="#409EFF"><Document /></el-icon><div class="stat-info"><span class="stat-num">{{ stats.totalRecords }}</span><span class="stat-label">工作记录</span></div></div></el-card></el-col>
      <el-col :span="6"><el-card shadow="hover"><div class="stat-item"><el-icon :size="32" color="#67C23A"><Select /></el-icon><div class="stat-info"><span class="stat-num">{{ stats.submittedRecords }}</span><span class="stat-label">已提交</span></div></div></el-card></el-col>
      <el-col :span="6"><el-card shadow="hover"><div class="stat-item"><el-icon :size="32" color="#E6A23C"><TrendCharts /></el-icon><div class="stat-info"><span class="stat-num">{{ stats.totalReports }}</span><span class="stat-label">汇报单</span></div></div></el-card></el-col>
      <el-col :span="6"><el-card shadow="hover"><div class="stat-item"><el-icon :size="32" color="#F56C6C"><Clock /></el-icon><div class="stat-info"><span class="stat-num">{{ stats.pendingAudit }}</span><span class="stat-label">待审核</span></div></div></el-card></el-col>
    </el-row>
    <el-card class="mt-3">
      <template #header><span>快捷操作</span></template>
      <div class="quick-actions">
        <el-button type="primary" @click="$router.push('/records')"><el-icon><Document /></el-icon> 填写记录</el-button>
        <el-button type="success" @click="$router.push('/reports')"><el-icon><TrendCharts /></el-icon> 提交汇报</el-button>
        <el-button v-if="authStore.isSupervisor" type="warning" @click="$router.push('/audit')"><el-icon><Finished /></el-icon> 审批管理</el-button>
      </div>
    </el-card>
    <el-card class="mt-3">
      <template #header><span>审批通知</span></template>
      <div v-if="!notifyList.length" style="color:#909399;text-align:center;padding:10px">暂无通知</div>
      <div v-else class="notify-cards">
        <div v-for="n in notifyList" :key="n.id" class="notify-card" :class="{ unread: !n.is_read }" @click="goReports(n)">
          <el-icon :size="20" :color="n.type==='approve'?'#67C23A':n.type==='reject'?'#F56C6C':n.type==='submit'?'#E6A23C':'#409EFF'" style="flex-shrink:0;margin-top:2px">
            <component :is="n.type==='approve'?'CircleCheck':n.type==='reject'?'CircleClose':n.type==='submit'?'UploadFilled':'ChatDotRound'" />
          </el-icon>
          <div class="notify-card-body">
            <div class="notify-card-title">{{ n.title }}</div>
            <div class="notify-card-content">{{ n.content }}</div>
          </div>
          <div class="notify-card-time">{{ formatTime(n.create_time) }}</div>
        </div>
      </div>
    </el-card>
    <el-card class="mt-3"><template #header><span>最近记录</span></template>
      <el-table :data="recentRecords" stripe v-loading="loading" style="width:100%">
        <el-table-column prop="record_date" label="日期" width="120" />
        <el-table-column prop="record_content" label="内容" show-overflow-tooltip />
        <el-table-column prop="record_status" label="状态" width="100"><template #default="{row}"><el-tag :type="row.record_status===1?'success':'info'">{{ row.record_status===1?'已提交':'草稿' }}</el-tag></template></el-table-column>
        <el-table-column label="创建时间" width="180"><template #default="{row}">{{ formatDate(row.create_time) }}</template></el-table-column>
      </el-table>
    </el-card>
  </div>
</template>
<script setup>
import { ref, onMounted } from "vue"
import { useRouter } from "vue-router"
import { useAuthStore } from "../stores/auth"
import api from "../api"
import { formatDate } from "../utils/format"
const authStore = useAuthStore()
const router = useRouter()
const loading = ref(false); const recentRecords = ref([])
const notifyList = ref([])
const stats = ref({ totalRecords:0, submittedRecords:0, totalReports:0, pendingAudit:0 })

function formatTime(t) {
  if (!t) return ''
  const d = new Date(t), now = new Date(), diff = now - d
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff/60000) + '分钟前'
  if (diff < 86400000) return Math.floor(diff/3600000) + '小时前'
  return Math.floor(diff/86400000) + '天前'
}

async function goReports(n) {
  if (!n.is_read) {
    try { await api.post("/notifications/read", { id: n.id }); n.is_read = 1 } catch(e) {}
  }
  router.push(n.type === 'submit' ? '/audit' : '/reports')
}

onMounted(async () => {
  loading.value = true
  try {
    const [rr, rpr] = await Promise.all([api.get("/records"), api.get("/reports").catch(()=>({data:[]}))])
    const r = rr.data || []; recentRecords.value = r.slice(0,10)
    stats.value.totalRecords = r.length; stats.value.submittedRecords = r.filter(x=>x.record_status===1).length
    const rp = rpr.data || []; stats.value.totalReports = rp.length; stats.value.pendingAudit = rp.filter(x=>x.report_status===1).length
  } catch(e){} finally { loading.value=false }
  if (authStore.isSupervisor) { try { const a = await api.get("/audit/pending",{params:{status:1}}); stats.value.pendingAudit = (a.data||[]).length } catch(e){} }
  // 加载审批通知
  try { const nr = await api.get("/notifications", { params: { unread_only: '1' } }); notifyList.value = (nr.data || []).slice(0, 5) } catch(e) {}
})
</script>
<style scoped>
.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.page-header h2{font-size:22px;margin:0}
.stat-item { display: flex; align-items: center; gap: 16px; }
.notify-cards { display: flex; flex-direction: column; gap: 6px; }
.notify-card { display: flex; gap: 10px; padding: 10px 8px; border-radius: 6px; cursor: pointer; transition: background .15s }
.notify-card:hover { background: #f5f7fa; }
.notify-card .notify-card-title { font-size: 14px; font-weight: 500; color: #303133; }
.notify-card .notify-card-content { font-size: 12px; color: #606266; margin-top: 3px; word-break: break-all; }
.notify-card .notify-card-time { font-size: 11px; color: #c0c4cc; white-space: nowrap; margin-left: auto; padding-left: 8px; min-width: 52px; text-align: right; }
.notify-card .notify-card-body { flex: 1; min-width: 0; }
/* 未读：蓝色背景 + 深色文字 */
.notify-card.unread { background: #ecf5ff; }
.notify-card.unread .notify-card-title { font-weight: 600; color: #1a1a2e; }
.notify-card.unread .notify-card-content { color: #303133; }
.notify-card.unread:hover { background: #d9ecff; }
/* 已读：灰色淡化 */
.notify-card:not(.unread) .notify-card-title { color: #909399; }
.notify-card:not(.unread) .notify-card-content { color: #b0b3b8; }
.stat-info { display: flex; flex-direction: column; }
.stat-num { font-size: 28px; font-weight: bold; color: #303133; }
.stat-label { font-size: 13px; color: #909399; }
.mt-3 { margin-top: 12px; }
.quick-actions { display: flex; gap: 12px; }
.notify-cards { max-height: 260px; overflow-y: auto; }
.notify-card { display: flex; align-items: flex-start; gap: 10px; padding: 10px; border-radius: 6px; cursor: pointer; border-bottom: 1px solid #f2f3f5; }
.notify-card:hover { background: #f5f7fa; }
.notify-card.unread { background: #ecf5ff; }
.notify-card.unread:hover { background: #d9ecff; }
.notify-card-body { flex: 1; min-width: 0; }
.notify-card-title { font-size: 14px; font-weight: 500; color: #303133; }
.notify-card-content { font-size: 12px; color: #606266; margin-top: 2px; word-break: break-all; }
.notify-card-time { font-size: 11px; color: #c0c4cc; white-space: nowrap; flex-shrink: 0; margin-top: 2px; }
</style>
