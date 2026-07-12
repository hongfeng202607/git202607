import { defineStore } from "pinia"
import { ref, computed } from "vue"
import api from "../api"

export const useAuthStore = defineStore("auth", () => {
  const token = ref(localStorage.getItem("token") || "")
  const user = ref(JSON.parse(localStorage.getItem("user") || "null"))
  const isLoggedIn = computed(() => !!token.value)
  const roleType = computed(() => user.value?.role_type || 0)
  const roleName = computed(() => ({ 1: "普通员工", 2: "管理者", 3: "超级管理员" })[roleType.value] || "未知")
  const isAdmin = computed(() => roleType.value === 3)
  const isSupervisor = computed(() => roleType.value >= 2)

  async function login(username, password) {
    const res = await api.post("/auth/login", { username, password })
    token.value = res.data.token; user.value = res.data.user
    localStorage.setItem("token", res.data.token)
    localStorage.setItem("user", JSON.stringify(res.data.user))
    return res
  }

  function logout() {
    token.value = ""; user.value = null
    localStorage.removeItem("token"); localStorage.removeItem("user")
  }

  return { token, user, isLoggedIn, roleType, roleName, isAdmin, isSupervisor, login, logout }
})
