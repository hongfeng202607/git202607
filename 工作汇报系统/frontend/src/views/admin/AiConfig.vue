<template>
  <div class="page-container">
    <div class="page-header"><h2>AI 配置</h2>
      <el-button type="primary" @click="handleSave" :loading="saving"><el-icon><Check /></el-icon> 保存</el-button>
    </div>
    <el-card>
      <el-alert title="说明" type="info" :closable="false" style="margin-bottom:16px"><p>配置 AI 接口以自动生成汇报。支持所有 OpenAI 兼容的 API，包括国内模型（如智谱 GLM、通义千问、DeepSeek、Kimi 等）。<br>国内模型接口地址示例：<code>https://open.bigmodel.cn/api/paas/v4/chat/completions</code>（智谱）、<code>https://api.deepseek.com/v1/chat/completions</code>（DeepSeek）</p></el-alert>
      <el-form :model="configForm" label-width="120px" v-loading="loading">
        <el-form-item label="接口地址" required><el-input v-model="configForm.api_url" placeholder="http://127.0.0.1:8080/v1/chat/completions" /><div style="font-size:12px;color:#909399;margin-top:4px">OpenAI 兼容接口地址（支持智谱/DeepSeek/通义/Kimi/LM Studio 等）。注意：本地服务请用 127.0.0.1 而非 localhost</div></el-form-item>
        <el-form-item label="模型名称" required><el-input v-model="configForm.model_name" placeholder="glm-4-flash" /></el-form-item>
        <el-form-item label="API 密钥"><el-input v-model="configForm.api_key" placeholder="仅显示前4后4位，修改请点右侧按钮" readonly><template #suffix><el-button text type="primary" size="small" @click="showKeyDialog=true">修改</el-button></template></el-input></el-form-item>
        <el-form-item label="系统提示词"><el-input v-model="configForm.system_prompt" type="textarea" :rows="3" placeholder="AI 系统提示词" /></el-form-item>
        <el-form-item><el-button type="primary" @click="testConnection" :loading="testing"><el-icon><Connection /></el-icon> 测试连接</el-button></el-form-item>
      </el-form>
      <el-alert v-if="testResult" :type="testResult.success?'success':'error'" :title="testResult.message" show-icon :closable="false" style="margin-top:12px" />
    </el-card>
    <el-dialog v-model="showKeyDialog" title="修改 API 密钥" width="480px">
      <el-input v-model="newApiKey" type="password" show-password placeholder="输入完整的新 API 密钥" />
      <div style="font-size:12px;color:#909399;margin-top:6px">输入完整密钥后保存，系统将不再显示原文。</div>
      <template #footer>
        <el-button @click="showKeyDialog=false">取消</el-button>
        <el-button type="primary" @click="confirmUpdateKey">确认修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, reactive, onMounted } from "vue"
import { ElMessage } from "element-plus"
import api from "../../api"
const loading = ref(false); const saving = ref(false); const testing = ref(false); const testResult = ref(null)
const showKeyDialog = ref(false); const newApiKey = ref("")
const defaultPrompt="你是一个工作汇报助手，请根据以下工作记录生成一份简洁的总结报告。请直接输出汇报内容，不要输出思考过程。"
const configForm = reactive({ api_url: "", model_name: "", api_key: "", system_prompt: defaultPrompt })
async function loadConfig(){loading.value=true;try{const r=await api.get("/ai-config");const d=r.data||{};if(d.system_prompt&&!/[\u4e00-\u9fff]/.test(d.system_prompt))d.system_prompt=defaultPrompt;Object.assign(configForm,d)}catch(e){}finally{loading.value=false}}
async function handleSave(){if(!configForm.api_url||!configForm.model_name){ElMessage.warning("接口地址和模型名称为必填项");return};saving.value=true;try{await api.put("/ai-config",{configs:configForm});ElMessage.success("保存成功")}catch(e){ElMessage.error(e.msg||"保存失败")}finally{saving.value=false}}
async function testConnection(){
  if(!configForm.api_url||!configForm.model_name){ElMessage.warning("请先填写接口地址和模型名称");return};testing.value=true;testResult.value=null
  try{const d=await api.post("/ai-proxy/test",{api_url:configForm.api_url,model_name:configForm.model_name});testResult.value=d.code===200?{success:true,message:d.msg||"连接成功"}:{success:false,message:d.msg||"连接失败"}}catch(e){testResult.value={success:false,message:e.msg||e.message||"网络错误"}}finally{testing.value=false}
}
onMounted(loadConfig)
async function confirmUpdateKey() {
  if (!newApiKey.value.trim()) { ElMessage.warning("请输入新的 API 密钥"); return }
  try {
    await api.put("/ai-config", { configs: { api_key: newApiKey.value.trim() } })
    ElMessage.success("密钥已更新")
    showKeyDialog.value = false; newApiKey.value = ""
    await loadConfig()
  } catch (e) { ElMessage.error(e.msg || "更新失败") }
}
</script>
<style scoped>
.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.page-header h2{font-size:22px;margin:0}
</style>
