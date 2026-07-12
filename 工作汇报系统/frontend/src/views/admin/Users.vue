<template>
  <div class="page-container">
    <div class="page-header"><h2>用户管理</h2>
      <el-button type="primary" @click="showDialog=true;dialogTitle='新建用户';resetForm()"><el-icon><Plus /></el-icon> 新建用户</el-button>
    </div>
    <el-card>
      <el-table :data="userTree" stripe v-loading="loading" style="width:100%">
        <el-table-column label="姓名/部门" min-width="200">
          <template #default="{row}">
            <span v-if="row._type==='dept'" :style="'margin-left:'+row._padding+'px;font-weight:600;color:#303133'">{{ row._label }}</span>
            <span v-else :style="'margin-left:'+row._padding+'px'">{{ row.real_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="用户名" width="130"><template #default="{row}">{{ row._type==='user'?row.username:''}}</template></el-table-column>
        <el-table-column label="角色" width="120"><template #default="{row}"><el-tag v-if="row._type==='user'" :type="row.role_type===3?'danger':row.role_type===2?'warning':'info'" size="small">{{ {1:'普通员工',2:'管理者',3:'超级管理员'}[row.role_type] }}</el-tag></template></el-table-column>
        <el-table-column label="创建时间" width="170"><template #default="{row}">{{ row._type==='user'?formatDate(row.create_time):'' }}</template></el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{row}">
            <template v-if="row._type==='user'">
              <el-button text type="primary" size="small" @click="editUser(row)">编辑</el-button>
              <el-button text type="danger" size="small" @click="deleteUser(row)">删除</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
    <el-dialog v-model="showDialog" :title="dialogTitle" width="500px">
      <el-form :model="form" :rules="rules" ref="formRef" label-width="100px">
        <el-form-item label="用户名" prop="username"><el-input v-model="form.username" :disabled="isEditing" /></el-form-item>
        <el-form-item label="姓名" prop="real_name"><el-input v-model="form.real_name" /></el-form-item>
        <el-form-item label="密码" prop="password" v-if="!isEditing"><el-input v-model="form.password" type="password" show-password /></el-form-item>
        <el-form-item label="密码" prop="password" v-else><el-input v-model="form.password" type="password" show-password placeholder="留空则不修改密码" /></el-form-item>
        <el-form-item label="角色" prop="role_type"><el-select v-model="form.role_type" style="width:100%"><el-option label="普通员工" :value="1" /><el-option label="管理者" :value="2" /></el-select></el-form-item>
        <el-form-item label="部门"><el-tree-select v-model="form.dept_id" :data="deptTree" :props="{label:'dept_name',value:'dept_id',children:'children'}" placeholder="请选择部门" clearable filterable check-strictly style="width:100%" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="showDialog=false">取消</el-button><el-button type="primary" @click="handleSave">{{ isEditing?'更新':'创建' }}</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, onMounted, computed } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import api from "../../api"
import { formatDate } from "../../utils/format"
const loading = ref(false); const users = ref([]); const showDialog = ref(false); const dialogTitle = ref("新建用户"); const isEditing = ref(false); const formRef = ref(null); const editingId = ref(null)
const form = reactive({ username: "", real_name: "", password: "", role_type: 1, dept_id: null })
const rules = computed(() => ({
  username: [{required:true,message:"请输入用户名",trigger:"blur"}],
  real_name: [{required:true,message:"请输入姓名",trigger:"blur"}],
  password: isEditing.value ? [{min:6,message:"密码长度不能少于6位",trigger:"blur"}] : [{required:true,message:"请输入密码",trigger:"blur"},{min:6,message:"密码长度不能少于6位",trigger:"blur"}]
}))
const deptList = ref([]); const deptTree = ref([]); const deptMap = ref({})
function buildTree(list, parentId = null) {
  return list.filter(d => d.parent_id === parentId).map(d => ({ ...d, children: buildTree(list, d.dept_id) })).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
}
// 构建平铺的部门分组用户列表（不用 el-table 树形模式）
const userTree = computed(() => {
  const flat = []
  function addDept(depts, parentId, depth = 0) {
    for (const dept of depts.filter(d => d.parent_id === parentId)) {
      // 部门标题行
      flat.push({ _type: 'dept', _label: dept.dept_name, _padding: depth * 20 })
      // 该部门的用户
      for (const u of users.value.filter(x => x.dept_id === dept.dept_id)) {
        flat.push({ _type: 'user', _padding: (depth + 1) * 20, ...u })
      }
      // 子部门
      addDept(depts, dept.dept_id, depth + 1)
    }
  }
  addDept(deptList.value, null)
  // 无部门的用户
  const noDept = users.value.filter(u => !u.dept_id)
  if (noDept.length > 0) {
    flat.push({ _type: 'dept', _label: '未分配部门', _padding: 0 })
    for (const u of noDept) {
      flat.push({ _type: 'user', _padding: 20, ...u })
    }
  }
  return flat
})
async function loadUsers() {
  loading.value = true
  try {
    const [u, d] = await Promise.all([api.get("/users"), api.get("/departments")])
    users.value = u.data || []; deptList.value = d.data || []
    deptTree.value = buildTree(deptList.value)
    const m = {}; deptList.value.forEach(d => { m[d.dept_id] = d.dept_name }); deptMap.value = m
  } catch(e) { ElMessage.error(e.msg||"加载失败") } finally { loading.value = false }
}
function editUser(row){isEditing.value=true;editingId.value=row.user_id;dialogTitle.value="编辑用户";form.username=row.username;form.real_name=row.real_name;form.password="";form.role_type=row.role_type;form.dept_id=row.dept_id;showDialog.value=true}
function resetForm(){form.username="";form.real_name="";form.password="";form.role_type=1;form.dept_id=null;editingId.value=null;isEditing.value=false;dialogTitle.value="新建用户"}
async function handleSave(){
  if(!await formRef.value.validate().catch(()=>false))return
  try{if(isEditing.value){const payload={real_name:form.real_name,role_type:form.role_type,dept_id:form.dept_id||null};if(form.password)payload.password=form.password;await api.put("/users/"+editingId.value,payload);ElMessage.success("更新成功")}else{const { dept_id, ...createData } = form; createData.dept_id = dept_id || null; await api.post("/users",createData);ElMessage.success("创建成功")};showDialog.value=false;resetForm();await loadUsers()}catch(e){ElMessage.error(e.msg||"操作失败")}
}
function deleteUser(row){ElMessageBox.confirm("确认删除用户 "+row.real_name+"？","确认",{confirmButtonText:'确定',cancelButtonText:'取消'}).then(async()=>{try{await api.delete("/users/"+row.user_id);ElMessage.success("已删除");await loadUsers()}catch(e){ElMessage.error(e.msg||"删除失败")}}).catch(()=>{})}
onMounted(loadUsers)
</script>
<style scoped>
.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.page-header h2{font-size:22px;margin:0}
</style>
