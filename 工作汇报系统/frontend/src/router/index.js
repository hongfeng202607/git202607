import { createRouter, createWebHistory } from "vue-router"

const routes = [
  {
    path: "/login",
    name: "Login",
    component: () => import("../views/Login.vue"),
    meta: { requiresAuth: false }
  },
  {
    path: "/",
    component: () => import("../views/Layout.vue"),
    meta: { requiresAuth: true },
    redirect: "/dashboard",
    children: [
      { path: "dashboard", name: "Dashboard", component: () => import("../views/Dashboard.vue"), meta: { title: "Dashboard", icon: "Odometer" } },
      { path: "records", name: "Records", component: () => import("../views/Records.vue"), meta: { title: "Records", icon: "Document" } },
      { path: "reports", name: "Reports", component: () => import("../views/Reports.vue"), meta: { title: "Reports", icon: "TrendCharts" } },
      { path: "audit", name: "Audit", component: () => import("../views/Audit.vue"), meta: { title: "Audit", icon: "Finished", roles: [2, 3] } },
      { path: "admin/users", name: "AdminUsers", component: () => import("../views/admin/Users.vue"), meta: { title: "Users", icon: "User", roles: [3] } },
      { path: "admin/relations", name: "AdminRelations", component: () => import("../views/admin/Relations.vue"), meta: { title: "Relations", icon: "Connection", roles: [3] } },
      { path: "admin/ai-config", name: "AdminAiConfig", component: () => import("../views/admin/AiConfig.vue"), meta: { title: "AI Config", icon: "Setting", roles: [3] } },
      { path: "admin/departments", name: "AdminDepartments", component: () => import("../views/admin/Departments.vue"), meta: { title: "Departments", icon: "OfficeBuilding", roles: [3] } },
      { path: "admin/system", name: "AdminSystem", component: () => import("../views/admin/System.vue"), meta: { title: "System", icon: "Tools", roles: [3] } }
    ]
  }
]

const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem("token")
  if (to.meta.requiresAuth && !token) next("/login")
  else if (to.path === "/login" && token) next("/dashboard")
  else next()
})

export default router
