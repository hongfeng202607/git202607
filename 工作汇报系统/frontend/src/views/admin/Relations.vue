<template>
  <div class="page-container">
    <div class="page-header"><h2>汇报关系</h2>
      <el-button type="primary" @click="showDialog=true"><el-icon><Plus /></el-icon> 添加关系</el-button>
    </div>
    <el-card>
      <el-table :data="relationTree" stripe v-loading="loading" style="width:100%">
        <el-table-column label="部门/汇报人" min-width="200">
          <template #default="{row}">
            <span v-if="row._type==='dept'" :style="'margin-left:'+row._padding+'px;font-weight:600;color:#303133'">{{ row._label }}</span>
            <span v-else :style="'margin-left:'+(row._padding*24)+'px'">{{ row.real_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="汇报给" min-width="180">
          <template #default="{row}">
            <template v-if="row._type==='rel'">
              <span style="color:#409EFF">{{ row.receiver_name }}</span>
              <el-tag size="small" type="warning" style="margin-left:6px">{{ row.receiver_role }}</el-tag>
            </template>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{row}">
            <el-button v-if="row._type==='rel'" text type="danger" size="small" @click="deleteRelation(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading&&relationTree.length===0" description="暂无汇报关系" />
    </el-card>
    <el-dialog v-model="showDialog" title="添加汇报关系" width="480px">
      <el-form :model="form" :rules="rules" ref="formRef" label-width="100px">
        <el-form-item label="汇报人" prop="reporter_id"><el-select v-model="form.reporter_id" filterable placeholder="选择员工" style="width:100%"><el-option v-for="u in employees" :key="u.user_id" :label="u.real_name+' ('+u.username+')'" :value="u.user_id" /></el-select></el-form-item>
        <el-form-item label="接收人" prop="receiver_id"><el-select v-model="form.receiver_id" filterable placeholder="选择上级" style="width:100%"><el-option v-for="u in supervisors" :key="u.user_id" :label="u.real_name+' ('+u.username+')'" :value="u.user_id" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="showDialog=false">取消</el-button><el-button type="primary" @click="handleAdd">添加</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, computed, onMounted } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import api from "../../api"
const loading = ref(false); const relations = ref([]); const employees = ref([]); const supervisors = ref([]); const showDialog = ref(false); const formRef = ref(null)
const allUsers = ref([]); const deptList = ref([])
const form = reactive({ reporter_id: null, receiver_id: null })
const rules = { reporter_id: [{required:true,message:"请选择汇报人",trigger:"change"}], receiver_id: [{required:true,message:"请选择接收人",trigger:"change"}] }

// 构建平铺的部门分组汇报关系列表
const relationTree = computed(() => {
  const relMap = {}
  for (const r of relations.value) relMap[r.reporter_id] = r
  const userNameMap = {}
  for (const u of allUsers.value) userNameMap[u.user_id] = u.real_name
  const roleNameMap = { 1: '普通员工', 2: '管理者', 3: '超级管理员' }

  const flat = []
  function addDept(depts, parentId, depth = 0) {
    for (const dept of depts.filter(d => d.parent_id === parentId)) {
      flat.push({ _type: 'dept', _label: dept.dept_name, _padding: depth * 24 })
      for (const u of allUsers.value.filter(x => x.dept_id === dept.dept_id && relMap[x.user_id])) {
        const rel = relMap[u.user_id]
        flat.push({
          _type: 'rel', _padding: depth + 1,
          relation_id: rel.relation_id,
          real_name: u.real_name,
          receiver_name: userNameMap[rel.receiver_id] || '未知',
          receiver_role: roleNameMap[allUsers.value.find(x => x.user_id === rel.receiver_id)?.role_type] || ''
        })
      }
      addDept(depts, dept.dept_id, depth + 1)
    }
  }
  addDept(deptList.value, null)
  return flat
})

async function loadData(){
  loading.value=true
  try{
    const[relRes,userRes,deptRes]=await Promise.all([api.get("/relations"),api.get("/users"),api.get("/departments")])
    relations.value=relRes.data||[]
    allUsers.value=userRes.data||[]
    deptList.value=deptRes.data||[]
    const users=userRes.data||[];employees.value=users.filter(u=>u.role_type!==3);supervisors.value=users.filter(u=>u.role_type>=2)
  }
  catch(e){ElMessage.error(e.msg||"加载失败")}finally{loading.value=false}
}
async function handleAdd(){
  if(!await formRef.value.validate().catch(()=>false))return
  try{await api.post("/relations",form);ElMessage.success("添加成功");showDialog.value=false;form.reporter_id=null;form.receiver_id=null;await loadData()}catch(e){ElMessage.error(e.msg||"操作失败")}
}
function deleteRelation(row){ElMessageBox.confirm("确认删除此汇报关系？","确认",{confirmButtonText:'确定',cancelButtonText:'取消'}).then(async()=>{try{await api.delete("/relations/"+row.relation_id);ElMessage.success("已删除");await loadData()}catch(e){ElMessage.error(e.msg||"删除失败")}}).catch(()=>{})}
onMounted(loadData)
</script>
<style scoped>
.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.page-header h2{font-size:22px;margin:0}
</style>
