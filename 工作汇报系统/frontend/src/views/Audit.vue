<template>
  <div class="page-container">
    <div class="page-header"><h2>审批管理</h2></div>
    <p style="color:#909399;margin-bottom:16px">审核下属提交的汇报单。</p>
    <el-card>
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div style="display:flex;align-items:center;gap:12px">
            <span>待审核列表</span>
            <el-radio-group v-model="scope" size="small" @change="loadPending">
              <el-radio-button value="all">全部下属</el-radio-button>
              <el-radio-button value="direct">直属下属</el-radio-button>
            </el-radio-group>
          </div>
          <el-radio-group v-model="filterStatus" size="small" @change="loadPending">
            <el-radio-button :value="1">待审核</el-radio-button>
            <el-radio-button :value="2">已退回</el-radio-button>
            <el-radio-button :value="3">已通过</el-radio-button>
            <el-radio-button :value="''">全部</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <el-table :data="pendingList" stripe v-loading="loading" style="width:100%">
        <el-table-column prop="reporter_name" label="汇报人" width="100" />
        <el-table-column label="部门" width="100"><template #default="{row}">{{ row.dept_name || '-' }}</template></el-table-column>
        <el-table-column label="类型" width="70"><template #default="{row}"><el-tag :type="row.report_type===1?'primary':'success'" size="small">{{ row.report_type===1?'周报':'月报' }}</el-tag></template></el-table-column>
        <el-table-column label="周期" width="240"><template #default="{row}">{{ row.cycle_start }} ~ {{ row.cycle_end }}</template></el-table-column>
        <el-table-column label="内容" min-width="300"><template #default="{row}"><div class="md-cell" v-html="marked(row.report_content||'')"></div></template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{row}">
          <div>
            <el-tag :type="row.report_status===1?'success':row.report_status===2?'danger':row.report_status===3?'':''" size="small">{{ statusText(row.report_status) }}</el-tag>
            <div v-if="row.last_operator_name && row.report_status!==1" style="font-size:11px;color:#909399;margin-top:2px;white-space:nowrap">{{ row.last_operator_name }} <template v-if="row.last_action_type===1">退回</template><template v-else-if="row.last_action_type===3">通过</template><template v-else-if="row.last_action_type===2">备注</template></div>
          </div>
        </template></el-table-column>
        <el-table-column label="提交时间" width="170"><template #default="{row}">{{ formatDate(row.submit_time) }}</template></el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{row}">
            <el-button v-if="row.report_status===1 && isReceiver(row)" text type="success" size="small" @click="handleApprove(row)">通过</el-button>
            <el-button v-if="row.report_status===1 && isReceiver(row)" text type="danger" size="small" @click="showRejectDialog(row)">退回</el-button>
            <el-button v-if="isReceiver(row)" text type="warning" size="small" @click="showCommentDialog(row)">备注</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading&&pendingList.length===0" description="暂无审核项" />
    </el-card>
    <el-dialog v-model="showReject" title="退回报" width="600px">
      <p style="margin-bottom:12px">退回 <b>{{ currentRow?.reporter_name }}</b> 的汇报</p>
      <div v-if="currentRow?.report_content" class="md-block" v-html="marked(currentRow.report_content)"></div>
      <el-input v-model="rejectReason" type="textarea" :rows="4" placeholder="请输入退回原因..." />
      <template #footer><el-button @click="showReject=false">取消</el-button><el-button type="danger" @click="handleReject">确认退回</el-button></template>
    </el-dialog>
    <el-dialog v-model="showComment" title="添加备注" width="600px">
      <p style="margin-bottom:12px">为 <b>{{ currentRow?.reporter_name }}</b> 的汇报添加备注</p>
      <div v-if="currentRow?.report_content" class="md-block" v-html="marked(currentRow.report_content)"></div>
      <el-input v-model="commentText" type="textarea" :rows="4" placeholder="请输入备注内容..." />
      <template #footer><el-button @click="showComment=false">取消</el-button><el-button type="primary" @click="handleComment">添加备注</el-button></template>
    </el-dialog>
    <el-dialog v-model="showApproveDialog" title="审批通过" width="600px">
      <p style="margin-bottom:12px">确认通过 <b>{{ currentRow?.reporter_name }}</b> 的汇报？</p>
      <div v-if="currentRow?.report_content" class="md-block" v-html="marked(currentRow.report_content)"></div>
      <el-input v-model="approveComment" type="textarea" :rows="3" placeholder="审批意见（选填）..." />
      <template #footer><el-button @click="showApproveDialog=false">取消</el-button><el-button type="success" @click="confirmApprove">确认通过</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, onMounted } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import api from "../api"
import { useAuthStore } from "../stores/auth"
import { formatDate } from "../utils/format"
import { marked } from "marked"
const authStore = useAuthStore()
const isReceiver = (row) => Number(row.receiver_id) === Number(authStore.user?.user_id)
const loading = ref(false); const pendingList = ref([]); const filterStatus = ref(1); const scope = ref('direct')
const showReject = ref(false); const showComment = ref(false); const showApproveDialog = ref(false)
const currentRow = ref(null); const rejectReason = ref(""); const commentText = ref(""); const approveComment = ref("")

function statusText(s) {
  return s === 1 ? '已提交' : s === 2 ? '已退回' : s === 3 ? '已通过' : '草稿'
}

async function loadPending() {
  loading.value = true
  try {
    const params = { scope: scope.value }; if (filterStatus.value !== "") params.status = filterStatus.value
    console.log('请求参数:', JSON.stringify(params))
    const r = await api.get("/audit/pending", { params }); pendingList.value = r.data || []
  } catch (e) {} finally { loading.value = false }
}
function showRejectDialog(row) { currentRow.value = row; rejectReason.value = ""; showReject.value = true }
async function handleReject() {
  if (!rejectReason.value) { ElMessage.warning("请输入退回原因"); return }
  try { await api.post("/audit/reject", { report_id: currentRow.value.report_id, reason: rejectReason.value }); ElMessage.success("已退回"); showReject.value = false; await loadPending() } catch (e) { ElMessage.error(e.msg || "操作失败") }
}
function showCommentDialog(row) { currentRow.value = row; commentText.value = ""; showComment.value = true }
async function handleComment() {
  if (!commentText.value) { ElMessage.warning("请输入备注内容"); return }
  try { await api.post("/audit/comment", { report_id: currentRow.value.report_id, comment: commentText.value }); ElMessage.success("备注已添加"); showComment.value = false; await loadPending() } catch (e) { ElMessage.error(e.msg || "操作失败") }
}
function handleApprove(row) {
  currentRow.value = row; approveComment.value = ""; showApproveDialog.value = true
}
async function confirmApprove() {
  try {
    await api.post("/audit/approve", { report_id: currentRow.value.report_id, comment: approveComment.value })
    ElMessage.success("审批通过"); showApproveDialog.value = false; await loadPending()
  } catch (e) { ElMessage.error(e.msg || "操作失败") }
}
onMounted(loadPending)
</script>
<style scoped>
.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.page-header h2{font-size:22px;margin:0}
/* Markdown */
:deep(.md-cell),:deep(.md-block){white-space:normal;word-break:break-word;line-height:1.7;font-size:13px;color:#303133}
:deep(.md-cell p),:deep(.md-block p){margin:0 0 6px}
:deep(.md-cell h2),:deep(.md-block h2){font-size:14px;font-weight:700;color:#1a1a2e;margin:10px 0 6px}
:deep(.md-cell h3),:deep(.md-block h3){font-size:13px;font-weight:700;color:#1a1a2e;margin:8px 0 4px}
:deep(.md-cell h4),:deep(.md-block h4){font-size:13px;font-weight:600;margin:6px 0 4px}
:deep(.md-cell ul),:deep(.md-block ul),:deep(.md-cell ol),:deep(.md-block ol){padding-left:20px;margin:4px 0 6px}
:deep(.md-cell li),:deep(.md-block li){margin:2px 0}
:deep(.md-cell strong),:deep(.md-block strong){font-weight:600;color:#1a1a2e}
:deep(.md-cell code),:deep(.md-block code){background:#f5f7fa;padding:1px 5px;border-radius:3px;font-size:12px;color:#e6a23c}
</style>
