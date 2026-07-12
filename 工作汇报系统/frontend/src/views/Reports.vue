<template>
  <div class="page-container">
    <div class="page-header"><h2>周期汇报</h2>
      <el-button type="primary" @click="openCreateDialog"><el-icon><Plus /></el-icon> 新建汇报</el-button>
    </div>
    <p style="color:#909399;margin-bottom:16px">按周期提交工作汇报，支持 AI 智能生成。</p>
    <div style="margin-bottom:12px">
      <el-radio-group v-model="statusFilter" size="small" @change="loadReports">
        <el-radio-button :value="-1">全部</el-radio-button>
        <el-radio-button :value="0">草稿</el-radio-button>
        <el-radio-button :value="1">进行中</el-radio-button>
        <el-radio-button :value="3">已通过</el-radio-button>
      </el-radio-group>
    </div>
    <el-card>
      <el-table :data="reports" v-loading="loading" stripe style="width:100%">
        <el-table-column label="类型" width="70"><template #default="{row}"><el-tag :type="row.report_type===1?'primary':'success'" size="small">{{ row.report_type===1?'周报':'月报' }}</el-tag></template></el-table-column>
        <el-table-column label="周期" width="240"><template #default="{row}">{{ row.cycle_start }} ~ {{ row.cycle_end }}</template></el-table-column>
        <el-table-column label="内容" min-width="300"><template #default="{row}"><div class="md-cell" v-html="marked(row.report_content||'')"></div></template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{row}"><el-tag :type="row.report_status===1?'success':row.report_status===2?'danger':row.report_status===3?'':'info'" size="small">{{ row.report_status===1?'已提交':row.report_status===2?'已退回':row.report_status===3?'已通过':'草稿' }}</el-tag></template></el-table-column>
        <el-table-column label="审批人" width="100"><template #default="{row}">{{ row.receiver_name||'-' }}</template></el-table-column>
        <el-table-column label="操作" width="260" fixed="right"><template #default="{row}">
          <div class="action-bar">
            <el-button v-if="row.report_status===0||row.report_status===2" text type="primary" size="small" @click="editDraft(row)">编辑</el-button>
            <el-button v-if="row.report_status===0" text type="success" size="small" @click="submitDraft(row)">提交</el-button>
            <el-button v-if="row.report_status===1||row.report_status===3" text type="primary" size="small" @click="viewAuditLogs(row)">审批日志</el-button>
            <el-button v-if="row.report_status===3&&subReports.value.some(s=>s.report_id===row.report_id)" text type="primary" size="small" @click="openEditResubmit(row)">重新提交</el-button>
            <el-button text type="danger" size="small" @click="deleteReport(row)">删除</el-button>
          </div>
        </template></el-table-column>
      </el-table>
      <el-empty v-if="!loading&&reports.length===0" description="暂无汇报" />
    </el-card>

    <!-- 创建汇报弹窗 -->
    <el-dialog v-model="showCreateDialog" title="新建汇报" width="700px">
      <el-form :model="reportForm" :rules="reportRules" ref="createFormRef" label-width="100px">
        <el-form-item label="汇报类型" prop="report_type">
          <el-radio-group v-model="reportForm.report_type"><el-radio-button :value="1">周报</el-radio-button><el-radio-button :value="2">月报</el-radio-button></el-radio-group>
        </el-form-item>
        <el-form-item label="汇报周期" prop="cycleRange"><el-date-picker v-model="reportForm.cycleRange" type="daterange" range-separator="~" start-placeholder="开始日期" end-placeholder="结束日期" value-format="YYYY-MM-DD" style="width:340px" /><div v-if="daysWarning" style="color:#e6a23c;font-size:12px;margin-top:4px">{{ daysWarning }}</div></el-form-item>
        <el-form-item label="关联记录">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <el-button size="small" @click="loadWorkRecords(reportForm.cycleRange?.[0], reportForm.cycleRange?.[1], includeSubReports)">加载工作记录</el-button>
              <el-checkbox v-if="authStore.roleType >= 2" v-model="includeSubReports" @change="loadWorkRecords(reportForm.cycleRange?.[0], reportForm.cycleRange?.[1], includeSubReports)">含下属（周期全覆盖）</el-checkbox>
            </div>
            <div v-if="workRecords.length > 0" class="record-wrapper">
              <el-checkbox v-model="selectAllRecords" @change="toggleAllRecords" style="margin-bottom:6px">全选</el-checkbox>
              <div class="record-group">
                <label v-for="r in (showAllRecords ? workRecords : workRecords.slice(0,5))" :key="r._type==='_sub_report'?'sr_'+r.report_id:'rec_'+r.record_id" class="record-row">
                  <input type="checkbox" :checked="isSelected(r)" @change="toggleItem(r)" class="record-checkbox-input" />
                  <span class="record-row-text" :title="(r.record_content||r.report_content||'')" style="overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important">{{ r._type==='_sub_report' ? '📋 '+r.reporter_name : '' }} {{ r.display_id || '' }} {{ r.record_date || r.cycle_start+'~'+r.cycle_end }}: {{ (r.record_content||r.report_content||'') }}</span>
                </label>
              </div>
              <div v-if="workRecords.length > 5" class="record-more"><el-button text size="small" type="info" @click="showAllRecords = !showAllRecords">{{ showAllRecords ? '收起' : '查看更多（共 ' + workRecords.length + ' 条）' }}</el-button></div>
            </div>
            <div v-else style="color:#909399;font-size:13px"><template v-if="includeSubReports && reportForm.cycleRange">当前日期范围内未找到符合条件（周期需完全包含）的下属汇报</template><template v-else>请先选择汇报周期，再点击"加载工作记录"获取可用记录</template></div>
          </div>
        </el-form-item>
        <el-form-item label="汇报内容" prop="report_content">
          <el-input v-model="reportForm.report_content" type="textarea" :rows="6" placeholder="请编写汇报内容..." />
          <div style="margin-top:8px"><el-button size="small" :loading="aiLoading" @click="aiGenerate(reportForm)" :disabled="!reportForm.cycleRange||!reportForm.report_type"><el-icon><MagicStick /></el-icon> {{ aiLoading ? 'AI 生成中...' : 'AI 生成' }}</el-button></div>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="showCreateDialog=false">取消</el-button><el-button @click="handleSaveReport">保存草稿</el-button><el-button type="primary" @click="handleSubmitReport">提交</el-button></template>
    </el-dialog>

    <!-- 编辑弹窗（草稿/退回/重新提交） -->
    <el-dialog v-model="showEditDialog" :title="editTitle" width="700px">
      <el-form :model="editForm" label-width="100px">
        <el-form-item label="汇报类型">
          <el-radio-group v-model="editForm.report_type" @change="onEditTypeChange">
            <el-radio-button :value="1">周报</el-radio-button>
            <el-radio-button :value="2">月报</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="汇报周期">
          <el-date-picker v-model="editForm.cycleRange" type="daterange" range-separator="~" start-placeholder="开始日期" end-placeholder="结束日期" value-format="YYYY-MM-DD" style="width:340px" @change="onEditCycleChange" />
          <div v-if="daysWarningEdit" style="color:#e6a23c;font-size:12px;margin-top:4px">{{ daysWarningEdit }}</div>
        </el-form-item>
        <el-form-item label="关联记录">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <el-button size="small" @click="loadWorkRecords(editForm.cycleRange?.[0], editForm.cycleRange?.[1], includeSubReportsEdit, 'edit')">加载工作记录</el-button>
              <el-checkbox v-if="authStore.roleType >= 2" v-model="includeSubReportsEdit" @change="loadWorkRecords(editForm.cycleRange?.[0], editForm.cycleRange?.[1], includeSubReportsEdit, 'edit')">含下属（周期全覆盖）</el-checkbox>
            </div>
            <div v-if="editWorkRecords.length > 0" class="record-wrapper">
              <el-checkbox v-model="selectAllRecordsEdit" @change="toggleAllRecordsEdit" style="margin-bottom:6px">全选</el-checkbox>
              <div class="record-group">
                <label v-for="r in (showAllRecordsEdit ? editWorkRecords : editWorkRecords.slice(0,5))" :key="r._type==='_sub_report'?'sr_'+r.report_id:'rec_'+r.record_id" class="record-row">
                  <input type="checkbox" :checked="editIsSelected(r)" @change="editToggleItem(r)" class="record-checkbox-input" />
                  <span class="record-row-text" :title="(r.record_content||r.report_content||'')" style="overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important">{{ r._type==='_sub_report' ? '📋 '+r.reporter_name : '' }} {{ r.display_id || '' }} {{ r.record_date || r.cycle_start+'~'+r.cycle_end }}: {{ (r.record_content||r.report_content||'') }}</span>
                </label>
              </div>
              <div v-if="editWorkRecords.length > 5" class="record-more"><el-button text size="small" type="info" @click="showAllRecordsEdit = !showAllRecordsEdit">{{ showAllRecordsEdit ? '收起' : '查看更多（共 ' + editWorkRecords.length + ' 条）' }}</el-button></div>
            </div>
            <div v-else style="color:#909399;font-size:13px"><template v-if="includeSubReportsEdit && editForm.cycleRange">当前日期范围内未找到符合条件（周期需完全包含）的下属汇报</template><template v-else>请先加载工作记录</template></div>
          </div>
        </el-form-item>
        <el-form-item label="汇报内容" required>
          <el-input v-model="editForm.report_content" type="textarea" :rows="8" placeholder="请修改汇报内容..." :disabled="aiLoading" />
          <div style="margin-top:8px"><el-button size="small" :loading="aiLoading" @click="aiGenerate(editForm)"><el-icon><MagicStick /></el-icon> {{ aiLoading ? 'AI 生成中...' : 'AI 生成' }}</el-button></div>
        </el-form-item>
      </el-form>
      <div v-if="editMode==='draft'" style="text-align:right;padding:12px 0 0"><el-button @click="handleEditSaveDraft">保存草稿</el-button><el-button type="primary" @click="handleEditSubmitDraft">提交</el-button></div>
      <div v-else-if="editMode==='resubmit'" style="text-align:right;padding:12px 0 0"><el-button type="primary" @click="handleEditResubmit">重新提交</el-button></div>
    </el-dialog>

    <!-- 审批日志 -->
    <el-dialog v-model="showLogDialog" title="审批日志" width="600px">
      <el-timeline><el-timeline-item v-for="log in auditLogs" :key="log.log_id" :timestamp="formatDate(log.create_time)"><p><b>{{ log.operator_name }}</b> <el-tag size="small" :type="log.action_type===1?'danger':log.action_type===3?'success':'info'" style="margin-left:8px">{{ log.action_type===1?'退回':log.action_type===3?'通过':'备注' }}</el-tag></p><p>{{ log.action_comment }}</p></el-timeline-item></el-timeline>
      <el-empty v-if="auditLogs.length===0" description="暂无日志" />
    </el-dialog>

    <!-- 下属汇报详情 -->
    <el-dialog v-model="showSubDetail" title="下属汇报详情" width="700px">
      <div class="md-block" v-html="marked(subDetailContent||'')"></div>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, computed, watch, onMounted } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import api from "../api"
import { useAuthStore } from "../stores/auth"
import { formatDate } from "../utils/format"
import { marked } from "marked"
const authStore = useAuthStore()
const loading = ref(false); const reports = ref([]); const subReports = ref([]); const workRecords = ref([]); const editWorkRecords = ref([]); const showAllRecords = ref(false); const showAllRecordsEdit = ref(false)
const includeSubReports = ref(false); const includeSubReportsEdit = ref(false)
const statusFilter = ref(-1)
const showCreateDialog = ref(false); const showEditDialog = ref(false); const showLogDialog = ref(false); const showSubDetail = ref(false)
const subDetailContent = ref("")
const auditLogs = ref([]); const selectedRecordIds = ref([]); const editSelectedRecordIds = ref([]); const selectAllRecords = ref(false); const selectAllRecordsEdit = ref(false)
const editRow = ref(null); const editMode = ref('draft'); const aiLoading = ref(false); const isAiGenerated = ref(false)
const createFormRef = ref(null)
const reportForm = reactive({ report_type: 1, cycleRange: null, report_content: "" })
const editForm = reactive({ report_content: "", report_type: 1, cycleRange: null })
const reportRules = { report_type: [{required:true,message:"请选择类型",trigger:"change"}], cycleRange: [{required:true,message:"请选择周期",trigger:"change"}], report_content: [{required:true,message:"请填写内容",trigger:"blur"}] }

function openCreateDialog() {
  reportForm.report_type = 1; reportForm.cycleRange = null; reportForm.report_content = ""
  workRecords.value = []; selectedRecordIds.value = []; selectAllRecords.value = false
  showAllRecords.value = false; includeSubReports.value = false; isAiGenerated.value = false
  showCreateDialog.value = true
}

function toggleAllRecords(v) { selectedRecordIds.value = v ? workRecords.value.map(r => getItemId(r)) : [] }
function toggleAllRecordsEdit(v) { editSelectedRecordIds.value = v ? editWorkRecords.value.map(r => getItemId(r)) : [] }
function getItemId(r) { return r._type === '_sub_report' ? 'sr_' + r.report_id : r.record_id }
function isSelected(r) { return selectedRecordIds.value.includes(getItemId(r)) }
function toggleItem(r) { const id = getItemId(r); const idx = selectedRecordIds.value.indexOf(id); if (idx >= 0) selectedRecordIds.value.splice(idx, 1); else selectedRecordIds.value.push(id) }
function editIsSelected(r) { return editSelectedRecordIds.value.includes(getItemId(r)) }
function editToggleItem(r) { const id = getItemId(r); const idx = editSelectedRecordIds.value.indexOf(id); if (idx >= 0) editSelectedRecordIds.value.splice(idx, 1); else editSelectedRecordIds.value.push(id) }

const editTitle = computed(() => editMode.value === 'resubmit' ? '重新提交' : '编辑草稿')

const daysWarning = computed(() => {
  if (!reportForm.cycleRange || !reportForm.report_type) return ''
  const start = new Date(reportForm.cycleRange[0])
  const end = new Date(reportForm.cycleRange[1])
  const days = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1
  if (reportForm.report_type === 1 && days > 7) return '⚠ 当前周期共 ' + days + ' 天，超出周报建议的 7 天范围'
  if (reportForm.report_type === 2 && days > 31) return '⚠ 当前周期共 ' + days + ' 天，超出月报建议的 31 天范围'
  return ''
})

const daysWarningEdit = computed(() => {
  if (!editForm.cycleRange || !editForm.report_type) return ''
  const start = new Date(editForm.cycleRange[0])
  const end = new Date(editForm.cycleRange[1])
  const days = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1
  if (editForm.report_type === 1 && days > 7) return '⚠ 当前周期共 ' + days + ' 天，超出周报建议的 7 天范围'
  if (editForm.report_type === 2 && days > 31) return '⚠ 当前周期共 ' + days + ' 天，超出月报建议的 31 天范围'
  return ''
})

async function loadReports() {
  loading.value = true
  try {
    const params = statusFilter.value >= 0 ? { status: statusFilter.value } : {}
    const [r, sr] = await Promise.all([
      api.get("/reports", { params }),
      api.get("/reports/sub-reports").catch(() => ({ data: [] }))
    ])
    reports.value = r.data || []; subReports.value = sr.data || []
  } catch (e) { ElMessage.error(e.msg || "加载失败") }
  finally { loading.value = false }
}

async function loadWorkRecords(startDate, endDate, includeSub, target = 'create') {
  if (!startDate || !endDate) { ElMessage.warning("请先选择汇报周期"); return }
  try {
    const r = await api.get("/reports/work-records", {
      params: { start_date: startDate, end_date: endDate, include_sub_reports: includeSub ? 'true' : 'false' }
    })
    const list = r.data || []
    if (target === 'edit') { editWorkRecords.value = list } else { workRecords.value = list }
  } catch (e) { ElMessage.error(e.msg || "加载失败") }
}

async function handleSaveReport() {
  if (!reportForm.cycleRange || !reportForm.report_type) { ElMessage.warning("请选择类型和周期"); return }
  const recordIds = selectedRecordIds.value.filter(id => !String(id).startsWith('sr_'))
  try {
    const r = await api.post("/reports", { report_type: reportForm.report_type, cycle_start: reportForm.cycleRange[0], cycle_end: reportForm.cycleRange[1], report_content: reportForm.report_content, save_as_draft: true, record_ids: recordIds })
    ElMessage.success("草稿已保存"); showCreateDialog.value = false; await loadReports()
  } catch (e) { ElMessage.error(e.msg || "保存失败") }
}
async function handleSubmitReport() {
  if (!reportForm.cycleRange || !reportForm.report_type) { ElMessage.warning("请选择类型和周期"); return }
  const recordIds = selectedRecordIds.value.filter(id => !String(id).startsWith('sr_'))
  try {
    const r = await api.post("/reports", { report_type: reportForm.report_type, cycle_start: reportForm.cycleRange[0], cycle_end: reportForm.cycleRange[1], report_content: reportForm.report_content, record_ids: recordIds })
    ElMessage.success("已提交给上级"); showCreateDialog.value = false; await loadReports()
  } catch (e) { ElMessage.error(e.msg || "提交失败") }
}
async function aiGenerate(form) {
  if (!form.cycleRange || !form.report_type) { ElMessage.warning("请先选择类型和周期"); return }
  aiLoading.value = true; isAiGenerated.value = false
  // 判断是编辑模式还是新建模式
  const isEdit = form === editForm
  const records = isEdit ? editWorkRecords.value : workRecords.value
  const selectedIds = isEdit ? editSelectedRecordIds.value : selectedRecordIds.value
  try {
    ElMessage.info("正在生成汇报内容，请稍候...")
    const recordIds = selectedIds.filter(id => !String(id).startsWith('sr_'))
    const chosenSubReports = records.filter(r => r._type === '_sub_report' && selectedIds.includes('sr_' + r.report_id))
    const d = await api.post("/reports/ai-generate", {
      type: form.report_type, cycle_start: form.cycleRange[0], cycle_end: form.cycleRange[1], record_ids: recordIds,
      sub_reports: chosenSubReports.concat(subReports.value.filter(sr => !chosenSubReports.find(c => c.report_id === sr.report_id))).map(r => '[' + r.reporter_name + ' 汇报] ' + (r.cycle_start||'') + '~' + (r.cycle_end||'') + ': ' + r.report_content)
    })
    if (d.code === 200 && d.data?.content) { form.report_content = d.data.content; isAiGenerated.value = true; ElMessage.success("AI 生成完成") }
    else { ElMessage.error(d.msg || "AI 返回内容为空") }
  } catch (e) { ElMessage.error(e.msg || "AI 生成失败") }
  finally { aiLoading.value = false }
}
function editDraft(row) { editRow.value = row; editMode.value = 'draft'; editForm.report_content = row.report_content; editForm.report_type = row.report_type; editForm.cycleRange = row.cycle_start && row.cycle_end ? [row.cycle_start, row.cycle_end] : null; editWorkRecords.value = []; editSelectedRecordIds.value = []; showEditDialog.value = true; includeSubReportsEdit.value = false }
function onEditTypeChange() { editWorkRecords.value = []; editSelectedRecordIds.value = [] }
function onEditCycleChange() { editWorkRecords.value = []; editSelectedRecordIds.value = [] }
async function handleEditSaveDraft() {
  if (!editForm.report_content.trim()) { ElMessage.warning("请填写汇报内容"); return }
  try {
    const recordIds = editSelectedRecordIds.value.filter(id => !String(id).startsWith('sr_'))
    await api.post("/reports/edit/" + editRow.value.report_id, {
      report_content: editForm.report_content,
      report_type: editForm.report_type,
      cycle_start: editForm.cycleRange?.[0],
      cycle_end: editForm.cycleRange?.[1],
      record_ids: recordIds
    })
    ElMessage.success("草稿已保存"); showEditDialog.value = false; await loadReports()
  } catch (e) { ElMessage.error(e.msg || "保存失败") }
}
async function handleEditSubmitDraft() {
  if (!editForm.report_content.trim()) { ElMessage.warning("请填写汇报内容"); return }
  try {
    const recordIds = editSelectedRecordIds.value.filter(id => !String(id).startsWith('sr_'))
    await api.post("/reports/edit/" + editRow.value.report_id, {
      report_content: editForm.report_content,
      report_type: editForm.report_type,
      cycle_start: editForm.cycleRange?.[0],
      cycle_end: editForm.cycleRange?.[1],
      record_ids: recordIds
    })
    await api.post("/reports/submit", { report_id: editRow.value.report_id })
    ElMessage.success("已提交给上级"); showEditDialog.value = false; await loadReports()
  } catch (e) { ElMessage.error(e.msg || "提交失败") }
}
function submitDraft(row) {
  ElMessageBox.confirm("确认提交此草稿？", "提交确认", { confirmButtonText: '确定', cancelButtonText: '取消' }).then(async () => {
    try { await api.post("/reports/submit", { report_id: row.report_id }); ElMessage.success("已提交给上级"); await loadReports() }
    catch (e) { ElMessage.error(e.msg || "提交失败") }
  }).catch(() => {})
}
function openEditResubmit(row) {
  editRow.value = row; editMode.value = 'resubmit'; editForm.report_content = row.report_content; editForm.report_type = row.report_type; editForm.cycleRange = row.cycle_start && row.cycle_end ? [row.cycle_start, row.cycle_end] : null; editWorkRecords.value = []; editSelectedRecordIds.value = []; showEditDialog.value = true
}
async function handleEditResubmit() {
  if (!editForm.report_content.trim()) { ElMessage.warning("请填写汇报内容"); return }
  try {
    const recordIds = editSelectedRecordIds.value.filter(id => !String(id).startsWith('sr_'))
    await api.post("/reports/edit/" + editRow.value.report_id, { report_content: editForm.report_content, record_ids: recordIds }); ElMessage.success("已保存"); showEditDialog.value = false; await loadReports()
  }
  catch (e) { ElMessage.error(e.msg || "保存失败") }
}
async function viewAuditLogs(row) {
  try { const r = await api.get("/audit/logs/" + row.report_id); auditLogs.value = r.data || []; showLogDialog.value = true }
  catch (e) { ElMessage.error(e.msg || "加载日志失败") }
}
async function deleteReport(row) {
  try { await ElMessageBox.confirm("确认删除此汇报？删除后不可恢复。", "删除确认", { type: "warning", confirmButtonText: '确定', cancelButtonText: '取消' }); await api.delete("/reports/" + row.report_id); ElMessage.success("已删除"); await loadReports() }
  catch (e) { if (e !== "cancel") ElMessage.error(e.msg || "删除失败") }
}
onMounted(loadReports)
</script>
<style scoped>
.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.page-header h2{font-size:22px;margin:0}
.action-bar{display:inline-flex;align-items:center;gap:2px;min-height:32px;flex-wrap:wrap}
.record-group{width:100%;overflow:hidden}
.record-wrapper{width:100%;max-height:320px;overflow:hidden auto;border:1px solid #e8e8e8;border-radius:6px;padding:8px 12px;box-sizing:border-box}
.record-wrapper::-webkit-scrollbar{width:6px}
.record-wrapper::-webkit-scrollbar-thumb{background:#d0d0d0;border-radius:3px}
.record-more{text-align:center;padding:4px 0 2px;border-top:1px solid #f0f0f0;margin-top:4px}
.record-row{display:grid!important;grid-template-columns:auto 1fr;gap:6px;width:100%;overflow:hidden!important;margin-bottom:4px;cursor:pointer}
.record-checkbox-input{width:14px;height:14px;margin-top:4px;cursor:pointer}
.record-row-text{overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;font-size:13px;line-height:22px}
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
