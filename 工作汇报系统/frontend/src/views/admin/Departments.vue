<template>
  <div class="page-container">
    <div class="page-header"><h2>部门管理</h2>
      <el-button type="primary" @click="addRoot"><el-icon><Plus /></el-icon> 新建部门</el-button>
    </div>
    <el-card>
      <el-table :data="treeData" row-key="dept_id" default-expand-all stripe v-loading="loading" style="width:100%" :tree-props="{ children: 'children' }">
        <el-table-column prop="dept_name" label="部门名称" min-width="250" />
        <el-table-column prop="dept_id" label="ID" width="80" />
        <el-table-column label="排序" width="80"><template #default="{row}">{{ row.sort_order }}</template></el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{row}">
            <el-button text type="primary" size="small" @click="addChild(row)">添加子部门</el-button>
            <el-button text type="warning" size="small" @click="editDept(row)">编辑</el-button>
            <el-button text type="danger" size="small" @click="deleteDept(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && treeData.length===0" description="暂无部门" />
    </el-card>
    <el-dialog v-model="showDialog" :title="dialogTitle" width="500px">
      <el-form :model="form" label-width="100px">
        <el-form-item label="部门名称"><el-input v-model="form.dept_name" maxlength="50" /></el-form-item>
        <el-form-item label="上级部门">
          <el-tree-select v-model="form.parent_id" :data="flatTree" :props="{ label: 'dept_name', value: 'dept_id' }" placeholder="无（顶级部门）" clearable filterable check-strictly />
        </el-form-item>
        <el-form-item label="排序"><el-input-number v-model="form.sort_order" :min="0" style="width:100%" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showDialog=false">取消</el-button>
        <el-button type="primary" @click="confirmSave">{{ isEditing ? '保存' : '创建' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, onMounted } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import api from "../../api"
const loading = ref(false); const showDialog = ref(false); const isEditing = ref(false); const dialogTitle = ref("")
const deptList = ref([]); const editingId = ref(null)
const form = reactive({ dept_name: "", parent_id: null, sort_order: 0 })

// 构建树形结构
const treeData = ref([])
const flatTree = ref([])
function buildTree(list, parentId = null) {
  return list.filter(d => d.parent_id === parentId).map(d => ({
    ...d,
    children: buildTree(list, d.dept_id)
  })).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
}

async function loadDepts() {
  loading.value = true
  try {
    const r = await api.get("/departments"); deptList.value = r.data || []
    treeData.value = buildTree(deptList.value)
    flatTree.value = deptList.value
  } catch (e) {} finally { loading.value = false }
}

function addRoot() { isEditing.value = false; dialogTitle.value = "新建顶级部门"; form.dept_name = ""; form.parent_id = null; form.sort_order = 0; showDialog.value = true }
function addChild(row) { isEditing.value = false; dialogTitle.value = "新建子部门 - " + row.dept_name; form.dept_name = ""; form.parent_id = row.dept_id; form.sort_order = 0; showDialog.value = true }
function editDept(row) { isEditing.value = true; editingId.value = row.dept_id; dialogTitle.value = "编辑部门"; form.dept_name = row.dept_name; form.parent_id = row.parent_id; form.sort_order = row.sort_order; showDialog.value = true }
async function confirmSave() {
  if (!form.dept_name.trim()) { ElMessage.warning("部门名称不能为空"); return }
  try {
    if (isEditing.value) {
      await api.put("/departments/" + editingId.value, { dept_name: form.dept_name, parent_id: form.parent_id, sort_order: form.sort_order })
      ElMessage.success("更新成功")
    } else {
      await api.post("/departments", { dept_name: form.dept_name, parent_id: form.parent_id, sort_order: form.sort_order })
      ElMessage.success("创建成功")
    }
    showDialog.value = false; await loadDepts()
  } catch (e) { ElMessage.error(e.msg || "操作失败") }
}
async function deleteDept(row) {
  try {
    await ElMessageBox.confirm("确认删除「" + row.dept_name + "」？删除后不可恢复。", "删除确认", { type: "warning", confirmButtonText: '确定', cancelButtonText: '取消' })
    await api.delete("/departments/" + row.dept_id); ElMessage.success("已删除"); await loadDepts()
  } catch (e) { if (e !== "cancel") ElMessage.error(e.msg || "删除失败") }
}
onMounted(loadDepts)
</script>
<style scoped>
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.page-header h2 { font-size: 22px; margin: 0; }
</style>
