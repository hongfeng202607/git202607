<template>
  <div class="login-container">
    <div class="login-card">
      <h1 class="login-title">慧报空间</h1>
      <el-form :model="form" :rules="rules" ref="formRef" @keyup.enter="handleLogin">
        <el-form-item prop="username">
          <el-input v-model="form.username" placeholder="用户名" size="large" :prefix-icon="User" autocomplete="off" name="username" />
        </el-form-item>
        <el-form-item prop="password">
          <el-input v-model="form.password" type="password" placeholder="密码" size="large" show-password :prefix-icon="Lock" />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="rememberPwd">记住密码</el-checkbox>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" size="large" class="login-btn" :loading="loading" @click="handleLogin">登 录</el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from "vue"
import { useRouter } from "vue-router"
import { ElMessage } from "element-plus"
import { User, Lock } from "@element-plus/icons-vue"
import { useAuthStore } from "../stores/auth"

const router = useRouter()
const authStore = useAuthStore()
const formRef = ref(null)
const loading = ref(false)
const rememberPwd = ref(false)
const form = reactive({ username: "", password: "" })
const rules = {
  username: [{ required: true, message: "请输入用户名", trigger: "blur" }],
  password: [{ required: true, message: "请输入密码", trigger: "blur" }]
}

async function handleLogin() {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    await authStore.login(form.username, form.password)
    // 记住密码
    if (rememberPwd.value) {
      localStorage.setItem('hb_space_remember', '1')
      localStorage.setItem('hb_space_username', form.username)
      localStorage.setItem('hb_space_password', form.password)
    } else {
      localStorage.removeItem('hb_space_remember')
      localStorage.removeItem('hb_space_username')
      localStorage.removeItem('hb_space_password')
    }
    ElMessage.success("登录成功")
    router.push("/dashboard")
  } catch (err) { ElMessage.error(err.msg || "登录失败") }
  finally { loading.value = false }
}

// 加载已保存的密码
onMounted(() => {
  if (localStorage.getItem('hb_space_remember') === '1') {
    rememberPwd.value = true
    form.username = localStorage.getItem('hb_space_username') || ''
    form.password = localStorage.getItem('hb_space_password') || ''
  }
})
</script>

<style scoped>
.login-container { height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
.login-card { width: 420px; padding: 40px; background: #fff; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.15); }
.login-title { text-align: center; font-size: 24px; color: #303133; margin-bottom: 30px; font-weight: 600; }
.login-btn { width: 100%; }
.login-tip { text-align: center; color: #909399; font-size: 13px; margin-top: 16px; }
</style>
