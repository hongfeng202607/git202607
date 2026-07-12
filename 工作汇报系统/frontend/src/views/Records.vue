<template>
  <div class="page-container">
    <div class="page-header"><h2>工作记录</h2>
      <div class="header-actions">
        <el-button type="primary" @click="showAddDialog=true"><el-icon><Plus /></el-icon> 新增记录</el-button>
        <el-dropdown trigger="click">
          <el-button><el-icon><Download /></el-icon> 导出<el-icon><ArrowDown /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="exportExcel">导出 Excel</el-dropdown-item>
              <el-dropdown-item @click="exportJSON">导出 JSON</el-dropdown-item>
              <el-dropdown-item @click="showImportDialog=true">导入备份</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>
    <p style="color:#909399;margin-bottom:16px">管理工作日记录，支持草稿保存、提交和导出。</p>
    <el-card class="mb-3">
      <el-form :inline="true" :model="filter">
        <el-form-item label="日期"><el-date-picker v-model="filter.dateRange" type="daterange" range-separator="~" start-placeholder="开始日期" end-placeholder="结束日期" value-format="YYYY-MM-DD" style="width:320px" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="filter.status" clearable placeholder="全部" style="width:120px"><el-option label="草稿" :value="0" /><el-option label="已提交" :value="1" /></el-select></el-form-item>
        <el-form-item><el-button type="primary" @click="loadRecords">查询</el-button><el-button @click="filter.dateRange=null;filter.status='';loadRecords()">重置</el-button></el-form-item>
      </el-form>
    </el-card>
    <el-card>
      <el-table :data="records" stripe v-loading="loading" style="width:100%">
        <el-table-column prop="display_id" label="编号" width="100" />
        <el-table-column prop="record_date" label="日期" width="120" />
        <el-table-column prop="record_content" label="内容" min-width="300" show-overflow-tooltip />
        <el-table-column prop="record_status" label="状态" width="90"><template #default="{row}"><el-tag :type="row.record_status===1?'success':'info'" size="small">{{ row.record_status===1?'已提交':'草稿' }}</el-tag></template></el-table-column>
        <el-table-column label="提交时间" width="170"><template #default="{row}">{{ formatDate(row.submit_time) }}</template></el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{row}">
            <el-button v-if="row.record_status===0&&!row.cycle_report_status" text type="primary" size="small" @click="editRecord(row)">编辑</el-button>
            <el-tooltip v-if="row.record_status===0&&row.cycle_report_status" content="周期汇报审批中，不可编辑" placement="top"><el-button text type="info" size="small" disabled>编辑</el-button></el-tooltip>
            <el-button v-if="row.record_status===0&&!row.cycle_report_status" text type="success" size="small" @click="submitRecord(row)">提交</el-button>
            <el-button v-if="row.record_status===1&&!row.cycle_report_status" text type="warning" size="small" @click="recallRecord(row)">撤回</el-button>
            <el-tooltip v-if="row.record_status===1&&row.cycle_report_status" content="周期汇报审批中，不可撤回" placement="top"><el-button text type="info" size="small" disabled>撤回</el-button></el-tooltip>
            <el-button v-if="row.record_status===0&&!row.cycle_report_status" text type="danger" size="small" @click="deleteRecord(row)">删除</el-button>
            <el-tooltip v-if="row.record_status===0&&row.cycle_report_status" content="周期汇报审批中，不可删除" placement="top"><el-button text type="info" size="small" disabled>删除</el-button></el-tooltip>
          </template>
        </el-table-column>
      </el-table>
      <div class="pagination-wrapper">
        <div class="pagination-left">
          <el-button :disabled="currentPage===1" size="small" @click="currentPage=1;loadRecords()">首页</el-button>
          <el-pagination
            v-model:current-page="currentPage"
            v-model:page-size="pageSize"
            :total="total"
            :page-sizes="[10, 20, 50, 100]"
            layout="prev, pager, next"
            @current-change="onPageChange"
            @size-change="onPageSizeChange"
            background
          />
        </div>
        <div class="pagination-info">
          <span class="page-total">共 {{ totalPages }} 页</span>
          <el-select v-model="pageSize" style="width:120px;margin-left:8px" @change="onPageSizeChange">
            <el-option label="每页 10 条" :value="10" />
            <el-option label="每页 20 条" :value="20" />
            <el-option label="每页 50 条" :value="50" />
            <el-option label="每页 100 条" :value="100" />
          </el-select>
        </div>
      </div>
    </el-card>
    <el-dialog v-model="showAddDialog" :title="editingRecord?'编辑记录':'新增记录'" width="600px">
      <el-form :model="recordForm" :rules="recordRules" ref="recordFormRef" label-width="80px">
        <el-form-item label="日期" prop="record_date"><el-date-picker v-model="recordForm.record_date" type="date" placeholder="选择日期" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
        <el-form-item label="内容" prop="record_content"><el-input v-model="recordForm.record_content" type="textarea" :rows="6" placeholder="请输入工作内容..." /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog=false">取消</el-button>
        <el-button @click="saveDraft">保存草稿</el-button>
        <el-button type="primary" @click="submitDirectly">保存并提交</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="showImportDialog" title="导入备份" width="500px">
      <p style="margin-bottom:12px;color:#909399">选择 JSON 备份文件导入到当前账号。</p>
      <input type="file" accept=".json" @change="handleImport" ref="fileInput" />
      <template #footer><el-button @click="showImportDialog=false">取消</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, onMounted, computed } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import api from "../api"
import * as XLSX from "xlsx"
import { formatDate } from "../utils/format"

const loading = ref(false); const records = ref([])
const showAddDialog = ref(false); const showImportDialog = ref(false); const editingRecord = ref(null); const recordFormRef = ref(null)

const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)
const totalPages = computed(() => Math.ceil(total.value / pageSize.value) || 1)

function onPageChange(p) { currentPage.value = p; loadRecords() }
function onPageSizeChange(s) { pageSize.value = s; currentPage.value = 1; loadRecords() }

const filter = reactive({ dateRange: null, status: "" })
const recordForm = reactive({ record_id: null, record_date: "", record_content: "" })
const recordRules = { record_date: [{required:true,message:"请选择日期",trigger:"change"}], record_content: [{required:true,message:"请输入内容",trigger:"blur"}] }

async function loadRecords() {
  loading.value=true
  try {
    const params={page:currentPage.value,pageSize:pageSize.value}
    if(filter.dateRange){params.start_date=filter.dateRange[0];params.end_date=filter.dateRange[1]}
    if (filter.status === 0 || filter.status === 1) params.status = filter.status
    const r=await api.get("/records",{params})
    records.value=(r.data||[]).map(x=>({...x}))
    total.value=r.total||0
  } catch(e){ ElMessage.error("加载失败") } finally { loading.value=false }
}

async function saveDraft() {
  if(!await recordFormRef.value.validate().catch(()=>false))return
  try {
    const payload={record_date:recordForm.record_date,record_content:recordForm.record_content,save_as_draft:true}
    if (recordForm.record_id) payload.record_id = recordForm.record_id
    await api.post("/records/submit", payload)
    ElMessage.success("草稿已保存")
    showAddDialog.value=false;resetForm();await loadRecords()
  } catch(e){ElMessage.error(e.msg||"保存失败")}
}

async function submitDirectly() {
  if(!await recordFormRef.value.validate().catch(()=>false))return
  try {
    const payload={record_date:recordForm.record_date,record_content:recordForm.record_content}
    if (recordForm.record_id) payload.record_id = recordForm.record_id
    await api.post("/records/submit", payload)
    ElMessage.success("提交成功")
    showAddDialog.value=false;resetForm();await loadRecords()
  } catch(e){ElMessage.error(e.msg||"提交失败");showAddDialog.value=false;resetForm();await loadRecords()}
}

function editRecord(row){
  if(row.record_status===1){ElMessage.warning("请先撤回记录再编辑");return}
  Object.assign(recordForm,{record_id:row.record_id,record_date:row.record_date,record_content:row.record_content})
  editingRecord.value=row;showAddDialog.value=true
}

async function submitRecord(row){
  try{
    await api.post("/records/submit",{record_id:row.record_id,record_date:row.record_date,record_content:row.record_content})
    ElMessage.success("提交成功");await loadRecords()
  }catch(err){ElMessage.error(err.msg||"提交失败")}
}

async function deleteRecord(row){
  ElMessageBox.confirm("确认删除此记录？","确认",{confirmButtonText:'确定',cancelButtonText:'取消',type:'warning'}).then(async()=>{
    try{await api.delete("/records/"+row.record_id);ElMessage.success("已删除");await loadRecords()}
    catch(err){ElMessage.error(err.msg||"删除失败")}
  }).catch(()=>{})
}

async function recallRecord(row){
  try{
    await ElMessageBox.confirm("撤回后记录变为草稿，可重新编辑再提交。确认撤回？","撤回确认",{type:"warning",confirmButtonText:'确定',cancelButtonText:'取消'})
    await api.post("/records/recall",{record_id:row.record_id})
    ElMessage.success("已撤回为草稿");await loadRecords()
  }catch(e){if(e!=="cancel")ElMessage.error(e.msg||"撤回失败")}
}

function exportExcel(){
  const data=records.value.map(r=>({"编号":r.display_id,"日期":r.record_date,"内容":r.record_content,"状态":r.record_status===1?"已提交":"草稿","提交时间":formatDate(r.submit_time)}))
  const ws=XLSX.utils.json_to_sheet(data),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"工作记录");XLSX.writeFile(wb,"工作记录_"+new Date().toISOString().slice(0,10)+".xlsx");ElMessage.success("导出成功")
}

async function exportJSON(){
  try {
    const r=await api.get("/records",{params:{pageSize:10000}})
    const d=JSON.stringify(r.data||[],null,2),b=new Blob([d],{type:"application/json"}),u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download="工作记录备份_"+new Date().toISOString().slice(0,10)+".json";a.click();URL.revokeObjectURL(u);ElMessage.success("备份已导出")
  } catch(e){ElMessage.error("导出失败")}
}

async function handleImport(e){
  const f=e.target.files[0];if(!f)return;const fileReader=new FileReader()
  fileReader.onload=async ev=>{
    try{
      const data=JSON.parse(ev.target.result)
      if (!Array.isArray(data)){ElMessage.error("文件格式不正确，需要数组格式");return}
      const result=await api.post("/records/batch-import",{records:data})
      ElMessage.success(result.msg||"导入成功");showImportDialog.value=false;await loadRecords()
    }catch(err){ElMessage.error(err.msg||"导入失败")}
  }
  fileReader.readAsText(f)
}

function resetForm(){Object.assign(recordForm,{record_id:null,record_date:"",record_content:""});editingRecord.value=null}
onMounted(loadRecords)
</script>
<style scoped>
.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.page-header h2{font-size:22px;margin:0}
.header-actions{display:flex;gap:8px;align-items:center}
.mb-3{margin-bottom:12px}
.pagination-wrapper{display:flex;justify-content:space-between;align-items:center;padding:12px 0 4px;flex-wrap:wrap;gap:8px}
.pagination-left{display:flex;align-items:center;gap:6px}
.pagination-info{display:flex;align-items:center;font-size:13px;color:#606266}
</style>
