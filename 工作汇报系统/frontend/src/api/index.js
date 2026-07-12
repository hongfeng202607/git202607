import axios from "axios"

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || "/api",
  timeout: 120000,
})

api.interceptors.request.use(config => {
  const token = localStorage.getItem("token")
  if (token) config.headers.Authorization = "Bearer " + token
  return config
})

api.interceptors.response.use(
  response => response.data,
  error => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem("token"); localStorage.removeItem("user")
      window.location.href = "/login"
    }
    // 超时友好提示
    if (error.code === 'ECONNABORTED') {
      return Promise.reject({ code: 408, msg: '请求超时，数据量较大时请耐心等待' })
    }
    return Promise.reject(error.response ? error.response.data : { code: 500, msg: "Network error" })
  }
)

export default api
