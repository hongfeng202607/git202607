function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function escapeRegex(str) {
    if (!str) return '';
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
let cateOptions = [];
let allRecords = [];
let totalRecords = 0;
let pageSize = 20;
let currentPage = 1;
let currentRole = "user";
let currentUsername = "";
let currentPermissions = [];
let currentRoleId = null;
let isSadmin = false;
let roleList = [];
let searchDebounceTimer = null;
let recycleCache = null; // 回收站数据缓存（预加载）


// 权限依赖关系：勾选依赖权限时自动勾选前置权限
const PERM_DEPENDS = {
    "knowledge.permanent_del": ["recycle.view"],
    "recycle.restore": ["recycle.view"],
    "knowledge.edit": ["knowledge.view"],
    "knowledge.delete": ["knowledge.view"],
    "attachment.delete": ["attachment.upload"],
};

function togglePermission(labelEl) {
    const cb = labelEl.querySelector('input');
    const wasChecked = cb.checked;
    const code = cb.value;
    cb.checked = !wasChecked;

    if (!wasChecked) {
        // 勾选时：自动勾选前置权限
        if (PERM_DEPENDS[code]) {
            for (const dep of PERM_DEPENDS[code]) {
                const depCb = document.querySelector('#rolePermPanel input[value="' + dep + '"]');
                if (depCb && !depCb.checked) {
                    depCb.checked = true;
                    const depLabel = depCb.parentElement;
                    depLabel.style.background = "#e8f4ff";
                    depLabel.style.borderColor = "#165DFF";
                }
            }
        }
    } else {
        // 取消勾选时：自动取消依赖当前权限的其他权限
        for (const [dependent, prerequisites] of Object.entries(PERM_DEPENDS)) {
            if (prerequisites.includes(code)) {
                const depCb = document.querySelector('#rolePermPanel input[value="' + dependent + '"]');
                if (depCb && depCb.checked) {
                    depCb.checked = false;
                    const depLabel = depCb.parentElement;
                    depLabel.style.background = "#f5f5f5";
                    depLabel.style.borderColor = "#ddd";
                }
            }
        }
    }
    updateCheckboxStyle(cb);
}

const fieldMap = {
    id: 'ID', category: '分类', question: '标题', solution: '核心内容', remark: '补充说明', record_time: '记录时间'
};

// 获取token
function getToken() {
    return localStorage.getItem("kb_token") || "";
}

// 请求头
function getHeaders() {
    return { 
        "Content-Type": "application/json",
        "token": getToken()
    };
}

// 带 401 自动处理的 fetch 封装
function apiFetch(url, options) {
    if (!options) options = {};
    if (!options.headers) options.headers = {};
    options.headers = getHeaders();
    return fetch(url, options).then(function(resp) {
        if (resp.status === 401) {
            showTopMsg("登录已过期，请重新登录", "error");
            logout();
            throw new Error("登录已过期");
        }
        if (!resp.ok) {
            throw new Error("请求失败 (HTTP " + resp.status + ")");
        }
        return resp.json();
    });
}

window.onload = function(){
    // ===== 换肤系统：应用已存主题 =====
    const savedTheme = localStorage.getItem('kb_theme') || '3';
    document.body.classList.add('theme-' + savedTheme);
    initThemeGrid();

    checkLogin();

    let lastUser = localStorage.getItem("kb_last_user");
    let remember = localStorage.getItem("kb_remember_pwd") === "1";
    let savePwd = localStorage.getItem("kb_save_pwd") || "";

    if(lastUser){
        document.getElementById("username").value = lastUser;
    }
    document.getElementById("rememberPwd").checked = remember;

    // ==============================================
    // 关键修复：只有勾选了记住密码，才填密码（Base64 解码）
    if(remember && savePwd){
        try { savePwd = atob(savePwd); } catch(e) {}
        document.getElementById("pwd").value = savePwd;
    } else {
        document.getElementById("pwd").value = "";
    }
    // ==============================================
};

// ===================== 权限校验工具 =====================
function hasPermission(code) {
    return currentPermissions.indexOf(code) !== -1 || isSadmin;
}
// =======================================================

// 登录校验
function checkLogin(){
    let token = getToken();
    let role = localStorage.getItem("kb_role");
    let username = localStorage.getItem("kb_username");
    let permsStr = localStorage.getItem("kb_permissions");
    if(!token){
        goLogin();
        return;
    }
    currentRole = role;
    currentUsername = username;
    currentPermissions = permsStr ? JSON.parse(permsStr) : [];
    currentRoleId = parseInt(localStorage.getItem("kb_role_id")) || null;
    isSadmin = (localStorage.getItem("kb_is_super") === "1");

    // 每次 checkLogin 都强制从服务端同步最新的权限
    refreshPermissions();
}

// 从服务端刷新权限
async function refreshPermissions() {
    try {
        const res = await fetch("/api/permissions/me", { headers: getHeaders() });
        if (res.status === 401) {
            // token 失效（角色被管理员改了 / 账号被禁用）→ 跳转登录
            localStorage.removeItem("kb_permissions");
            currentPermissions = [];
            goLogin();
            return;
        }
        const data = await res.json();
        if (data.status === "success" && data.permissions) {
            currentPermissions = data.permissions;
            localStorage.setItem("kb_permissions", JSON.stringify(data.permissions));
            // 同步刷新 is_super 状态
            if (data.is_super !== undefined) {
                isSadmin = data.is_super === 1 || data.is_super === true;
                localStorage.setItem("kb_is_super", isSadmin ? "1" : "0");
            }
        }
    } catch (e) {
        // 网络异常 → 保留缓存权限，不阻塞界面
        console.warn("权限刷新失败，使用缓存权限", e);
    }
    afterCheckLogin();
}

function afterCheckLogin() {

    let roleLabel = "用户";
    if (isSadmin) roleLabel = "超级管理员";
    else if (currentRole === "admin") roleLabel = "管理员";
    else if (currentRole === "editor") roleLabel = "编辑员";
    else {
        // 如果是自定义角色，尝试友好显示
        let storedRoleLabel = localStorage.getItem("kb_role_label");
        if (storedRoleLabel) roleLabel = storedRoleLabel;
    }
    document.getElementById("triggerName").innerText = currentUsername + " · " + roleLabel;
    // 移动端头像圆：显示用户名首字母
    var triggerAvatar = document.getElementById("triggerAvatar");
    if (triggerAvatar) triggerAvatar.innerText = (currentUsername || "U")[0].toUpperCase();
    // 侧边栏头像圆：显示用户名首字母
    var sidebarAvatar = document.getElementById("sidebarAvatar");
    if (sidebarAvatar) sidebarAvatar.innerText = (currentUsername || "U")[0].toUpperCase();
    document.getElementById("sidebarUsername").innerText = currentUsername;
    document.getElementById("sidebarRole").innerText = roleLabel;
    document.getElementById("loginWrap").style.display = "none";
    document.getElementById("mainContainer").style.display = "block";
    // 更新PC端顶部工具栏用户信息（紫色圆头像+首字母）
    var userInfo = document.getElementById("currentUserInfo");
    if (userInfo) {
        userInfo.setAttribute("data-initial", (currentUsername || "U")[0].toUpperCase());
        userInfo.innerText = currentUsername;
    }

// ===================== 权限驱动 UI =====================
// 清除之前的角色样式
document.body.classList.remove("role-user", "role-editor");

// ---- 顶部工具栏按钮（无权限隐藏，桌面+移动端同步） ----
document.querySelectorAll(".perm-user-mgr").forEach(el => el.style.display =
    hasPermission("user.manage") ? "" : "none");
document.querySelectorAll(".perm-role-mgr").forEach(el => el.style.display =
    hasPermission("user.manage") ? "" : "none");
document.querySelectorAll(".perm-recycle").forEach(el => el.style.display =
    hasPermission("recycle.view") ? "" : "none");
document.querySelectorAll("#cateMgrBtn").forEach(el => el.style.display =
    hasPermission("category.manage") ? "" : "none");
document.querySelectorAll(".perm-settings").forEach(el => el.style.display =
    (hasPermission("settings.dedup") || hasPermission("settings.data_perm") || hasPermission("ai.manage")) ? "" : "none");
document.querySelectorAll("#aiParseBtn").forEach(el => el.style.display =
    hasPermission("ai.use") ? "" : "none");
document.querySelectorAll("#aiHelperBtn").forEach(el => el.style.display =
    hasPermission("ai.use") ? "" : "none");
document.querySelectorAll(".perm-tools").forEach(el => el.style.display =
    isSadmin ? "" : "none");
// "更多"按钮：三个子项都无权限则隐藏
var moreMenu = document.querySelector(".more-menu");
if (moreMenu) moreMenu.style.display =
    (hasPermission("user.manage") || isSadmin) ? "" : "none";
// ======================================================
    
    initApp();
}

// ===================== 系统设置（查重阈值 + AI配置） =====================
function openSettingsModal() {
    if (!hasPermission("settings.dedup") && !hasPermission("settings.data_perm") && !hasPermission("ai.manage")) return;
    // 加载查重模式（单选兼容：旧配置可能存了多个，只取第一个）
    const modes = loadDedupModes();
    const singleMode = modes.length > 0 ? modes[0] : "title";
    const cbTitle = document.getElementById("dedupCbTitle");
    const cbContent = document.getElementById("dedupCbContent");
    if (cbTitle) {
        cbTitle.checked = singleMode === "title";
        const pt = document.getElementById("pillTitle");
        if (pt) pt.classList.toggle("active", cbTitle.checked);
    }
    if (cbContent) {
        cbContent.checked = singleMode === "title_content";
        const pc = document.getElementById("pillContent");
        if (pc) pc.classList.toggle("active", cbContent.checked);
    }
    // 确保写回 localStorage（去掉旧多选数据）
    localStorage.setItem("dedupModes", JSON.stringify([singleMode]));
    // 加载查重阈值
    const saved = localStorage.getItem("dedupThreshold");
    const pct = saved !== null ? parseInt(saved, 10) : 30;
    const slider = document.getElementById("dedupSlider");
    if (slider) {
        slider.value = pct;
        updateDedupLabel(pct);
    }
    // 加载查重开关状态
    const enabled = localStorage.getItem("dedupEnabled");
    const isOn = enabled !== null ? enabled === "true" : true;
    setDedupSwitchState(isOn);
    // 加载数据权限状态
    loadDataPermStatus();
    // 根据权限显示/隐藏AI配置区块（需要 ai.manage 权限）
    const accAi = document.getElementById("accAi");
    if (accAi) {
        accAi.style.display = hasPermission("ai.manage") ? "" : "none";
    }
    // 数据权限区块（需要 settings.data_perm 权限）
    const accDataPerm = document.getElementById("accDataPerm");
    if (accDataPerm) {
        accDataPerm.style.display = hasPermission("settings.data_perm") ? "" : "none";
    }
    // 查重设置区块（需要 settings.dedup 权限）
    const accDedup = document.getElementById("accDedup");
    if (accDedup) {
        accDedup.style.display = hasPermission("settings.dedup") ? "" : "none";
    }
    // 加载AI配置（需要 ai.manage 权限）
    if (hasPermission("ai.manage")) {
        const msgEl = document.getElementById("aiConfigMsg");
        msgEl.innerText = "加载中...";
        fetch("/api/admin/ai_config", { headers: getHeaders() })
            .then(res => res.json())
            .then(data => {
                if (data.status === "success") {
                    document.getElementById("aiCfgUrl").value = data.url || "";
                    document.getElementById("aiCfgModel").value = data.model || "";
                    if (data.key_exists) {
                        document.getElementById("aiKeyHint").innerText = "当前Key：" + data.key + "（前4后4）";
                    } else {
                        document.getElementById("aiKeyHint").innerText = "未配置API Key，AI功能不可用";
                    }
                    document.getElementById("aiCfgKey").value = "";
                    msgEl.innerText = "";
                } else {
                    msgEl.innerText = "读取AI配置失败：" + (data.msg || "无权限");
                }
            })
            .catch(() => { msgEl.innerText = "网络异常，请稍后重试"; });
    }
    // 打开设置弹窗（无论AI配置加载是否成功都打开）
    openModal("settingsModal");
}

// ===== 设置弹窗拖动 =====
let settingsDragData = null;
function initSettingsDrag(e) {
    if (e.button !== 0) return;
    const el = document.querySelector(".settings-content");
    if (!el) return;
    const rect = el.getBoundingClientRect();
    settingsDragData = {
        el, startX: e.clientX, startY: e.clientY,
        origLeft: rect.left, origTop: rect.top
    };
    el.style.transform = "none";
    el.style.left = rect.left + "px";
    el.style.top = rect.top + "px";
    el.style.willChange = "left, top";
    document.addEventListener("mousemove", onSettingsDrag);
    document.addEventListener("mouseup", stopSettingsDrag);
    e.preventDefault();
}
function onSettingsDrag(e) {
    if (!settingsDragData) return;
    const d = settingsDragData;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    d.el.style.left = Math.max(0, d.origLeft + dx) + "px";
    d.el.style.top = Math.max(0, d.origTop + dy) + "px";
}
function stopSettingsDrag() {
    if (!settingsDragData) return;
    document.removeEventListener("mousemove", onSettingsDrag);
    document.removeEventListener("mouseup", stopSettingsDrag);
    settingsDragData.el.style.willChange = "";
    settingsDragData = null;
}

// 手风琴切换（查重 / AI 配置折叠）
function toggleAccordion(id) {
    document.getElementById(id).classList.toggle('open');
}

// 查重滑块更新
function updateDedupLabel(val) {
    const pct = parseInt(val, 10);
    const label = document.getElementById("dedupValueLabel");
    if (label) label.innerText = pct + "%";
    const slider = document.getElementById("dedupSlider");
    if (slider) {
        slider.style.background = `linear-gradient(to right,#165DFF ${pct}%,#dcdfe6 ${pct}%)`;
    }
    localStorage.setItem("dedupThreshold", pct);
}

// 设置查重开关状态（视觉 + 状态文字）
function setDedupSwitchState(on) {
    const sw = document.getElementById("dedupSwitch");
    const status = document.getElementById("dedupStatus");
    if (!sw) return;
    sw.classList.toggle("on", on);
    if (status) {
        status.innerText = on
            ? "新增知识时自动检测重复 · 已开启"
            : "查重校验已关闭，新增知识时不会检测重复";
    }
}

// 切换查重开关（点击调用）
function toggleDedup() {
    const sw = document.getElementById("dedupSwitch");
    if (!sw) return;
    const nowOn = sw.classList.contains("on");
    setDedupSwitchState(!nowOn);
    localStorage.setItem("dedupEnabled", !nowOn);
}

// 读取当前查重阈值（返回小数，如0.30）
function loadDedupThreshold() {
    const saved = localStorage.getItem("dedupThreshold");
    const pct = saved !== null ? parseInt(saved, 10) : 30;
    return pct / 100;
}

// 查重药丸点击联动（单选：点A则取消B）
function togglePill(el) {
    const cb = el.querySelector('input[type="checkbox"]');
    if (!cb) return;
    // 如果点击的是已选中的，不允许取消（最少选一个）
    if (cb.checked) return;
    // 取消另一个
    const sibling = el.id === "pillTitle"
        ? document.getElementById("pillContent")
        : document.getElementById("pillTitle");
    if (sibling) {
        const sb = sibling.querySelector('input[type="checkbox"]');
        if (sb) {
            sb.checked = false;
            sibling.classList.remove("active");
        }
    }
    cb.checked = true;
    el.classList.add("active");
    saveDedupCheckboxes();
}

// 查重复选框保存
function saveDedupCheckboxes() {
    const modes = [];
    const cbTitle = document.getElementById("dedupCbTitle");
    const cbContent = document.getElementById("dedupCbContent");
    if (cbTitle.checked) modes.push("title");
    if (cbContent.checked) modes.push("title_content");
    localStorage.setItem("dedupModes", JSON.stringify(modes));
    // 同步药丸 active 样式
    const pillTitle = document.getElementById("pillTitle");
    const pillContent = document.getElementById("pillContent");
    if (pillTitle) pillTitle.classList.toggle("active", cbTitle.checked);
    if (pillContent) pillContent.classList.toggle("active", cbContent.checked);
}

// 读取查重模式列表（返回数组，空数组=不查重）
function loadDedupModes() {
    // 查重总开关关闭时返回空数组（跳过查重）
    const dedupEnabled = localStorage.getItem("dedupEnabled");
    if (dedupEnabled !== null && dedupEnabled !== "true") {
        return [];
    }
    try {
        const raw = localStorage.getItem("dedupModes");
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return arr;
        }
    } catch (e) {}
    return ["title"]; // 默认仅标题
}

// 测试AI连接
function testAiConnection() {
    const url = document.getElementById("aiCfgUrl").value.trim();
    const key = document.getElementById("aiCfgKey").value.trim();
    const model = document.getElementById("aiCfgModel").value.trim();
    const msgEl = document.getElementById("aiConfigMsg");

    if (!url || !model) {
        msgEl.innerText = "⚠️ API地址和模型名称不能为空";
        msgEl.style.color = "#f53f3f";
        setTimeout(() => msgEl.innerText = "", 3000);
        return;
    }

    msgEl.innerText = "⏳ 测试中...";
    msgEl.style.color = "#165DFF";

    fetch("/api/admin/ai_config/test", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ url, key, model })
    })
    .then(res => res.json())
    .then(data => {
        msgEl.innerText = data.msg || (data.status === "success" ? "✅ 连接成功" : "❌ 测试失败");
        msgEl.style.color = data.status === "success" ? "#00b42a" : "#f53f3f";
        const timeout = data.status === "success" ? 5000 : 15000;
        setTimeout(() => msgEl.innerText = "", timeout);
    })
    .catch(() => {
        msgEl.innerText = "❌ 网络异常";
        msgEl.style.color = "#f53f3f";
        setTimeout(() => msgEl.innerText = "", 3000);
    });
}

function saveAiConfig() {
    const url = document.getElementById("aiCfgUrl").value.trim();
    const key = document.getElementById("aiCfgKey").value.trim();
    const model = document.getElementById("aiCfgModel").value.trim();
    const msgEl = document.getElementById("aiConfigMsg");

    if (!url || !model) {
        msgEl.innerText = "⚠️ API地址和模型名称不能为空";
        msgEl.style.color = "#f53f3f";
        setTimeout(() => msgEl.innerText = "", 3000);
        return;
    }

    fetch("/api/admin/ai_config", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ url, key, model })
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === "success") {
            msgEl.innerText = "✅ 配置已保存";
            msgEl.style.color = "#00b42a";
            setTimeout(() => { closeModal("settingsModal"); msgEl.innerText = ""; }, 1500);
        } else {
            msgEl.innerText = "❌ " + (data.msg || "保存失败");
            msgEl.style.color = "#f53f3f";
            setTimeout(() => msgEl.innerText = "", 3000);
        }
    })
    .catch(() => {
        msgEl.innerText = "❌ 网络异常";
        msgEl.style.color = "#f53f3f";
        setTimeout(() => msgEl.innerText = "", 3000);
    });
}

function goLogin(){
    document.getElementById("loginWrap").style.display = "flex";
    document.getElementById("mainContainer").style.display = "none";
    document.body.classList.remove("sidebar-open");
    // 退出登录立刻清空密码框（未勾选记住密码时）
    var remember = localStorage.getItem("kb_remember_pwd") === "1";
    if(!remember){
        document.getElementById("pwd").value = "";
    }
}

// 切换账号时清空密码
function clearPwdOnUserChange(){
    document.getElementById("pwd").value = "";
    document.getElementById("rememberPwd").checked = false;
}

// 登录（最终版：记住账号 + 记住密码严格受控）
function login(){
    let u = document.getElementById("username").value.trim();
    let p = document.getElementById("pwd").value.trim();
    let remember = document.getElementById("rememberPwd").checked;
    let errDom = document.getElementById("loginErr");
    errDom.classList.remove("fade-out");
    errDom.innerText = "";

    if(!u || !p){
        errDom.innerText = "请输入账号和密码";
        setTimeout(()=>{ errDom.classList.add("fade-out"); }, 3000);
        return;
    }

    fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p })
    })
    .then(res => res.json())
    .then(data => {
        if(data.status === "error"){
            errDom.innerText = data.msg;
            setTimeout(()=>{ errDom.classList.add("fade-out"); }, 3000);
        }else if(data.status === "success"){
            localStorage.setItem("kb_token", data.token);
            localStorage.setItem("kb_username", data.username);
            localStorage.setItem("kb_role", data.role);
            // 保存 role_id 和权限列表
            localStorage.setItem("kb_role_id", data.role_id || "");
            localStorage.setItem("kb_permissions", JSON.stringify(data.permissions || []));
            // 如果是自定义角色，保存角色显示名
            if (data.role && data.role !== "admin" && data.role !== "editor" && data.role !== "user") {
                localStorage.setItem("kb_role_label", data.role);
            } else {
                localStorage.removeItem("kb_role_label");
            }
            localStorage.setItem("kb_is_super", data.is_super || "0");
            // 永远记住账号
            localStorage.setItem("kb_last_user", u);

            // ==============================================
            // 严格控制：只有勾选才记住密码（Base64 编码存储，非明文）
            if(remember){
                localStorage.setItem("kb_save_user", u);
                localStorage.setItem("kb_save_pwd", btoa(p));
                localStorage.setItem("kb_remember_pwd", "1");
            } else {
                // 不勾选 → 清空所有密码记录
                localStorage.removeItem("kb_save_user");
                localStorage.removeItem("kb_save_pwd");
                localStorage.setItem("kb_remember_pwd", "0");
            }
            // ==============================================

            checkLogin();
        }
    })
    .catch(e => {
        errDom.innerText = "网络异常，请确认服务是否运行";
        console.error("登录错误:", e);
        setTimeout(()=>{ errDom.classList.add("fade-out"); }, 3000);
    });
}

// 登出（最终完美版：未勾选记住密码 → 清空密码）
function logout(){
    fetch("/logout", { method:"POST", headers: getHeaders() });

    // 永远保留账号
    localStorage.removeItem("kb_token");
    localStorage.removeItem("kb_username");
    localStorage.removeItem("kb_role");
    localStorage.removeItem("kb_role_id");
    localStorage.removeItem("kb_permissions");
    localStorage.removeItem("kb_role_label");
    localStorage.removeItem("kb_is_super");

    // ==============================================
    // 关键修复：如果没勾选记住密码，退出时清空密码
    let remember = localStorage.getItem("kb_remember_pwd") === "1";
    if (!remember) {
        localStorage.removeItem("kb_save_pwd");
    }
    // ==============================================

    goLogin();
    // 确保登录页完全呈现（body背景 + 移除可能残留的布局）
    document.body.className = '';
    window.location.reload();
}

// 打开账号管理
function openUserModal(){
    if(!hasPermission("user.manage")) return;
    // 先加载角色列表，再打开弹窗
    fetch("/api/roles", { headers: getHeaders() })
    .then(res => res.json())
    .then(data => {
        if (data.status === "success") {
            roleList = data.data || [];
            // 填充角色下拉
            const sel = document.getElementById("newUserRole");
            // 非 sadmin 看不到 admin 角色
            let filteredRoles = roleList;
            if (!isSadmin) {
                filteredRoles = roleList.filter(r => r.name !== "admin");
            }
            sel.innerHTML = filteredRoles.map(r =>
                `<option value="${r.id}">${escapeHtml(r.name)}</option>`
            ).join("");
        }
    })
    .catch(() => {})
    .finally(() => {

        fetch("/user/list", { headers: getHeaders() })
        .then(res => res.json())
        .then(list => {
            let html = "";
            list.forEach(u => {
                let statusTxt = u.status == 1 ? "启用" : "禁用";
                let roleOpts = "";
                let usableRoles = roleList;
                if (!isSadmin) {
                    usableRoles = roleList.filter(r => r.name !== "admin");
                }
                usableRoles.forEach(r => {
                    let selected = (r.id === u.role_id) ? "selected" : "";
                    roleOpts += `<option value="${r.id}" ${selected}>${escapeHtml(r.name)}</option>`;
                });
                html += `
    <tr id="userRow_${u.username}">
        <td>${escapeHtml(u.username)}</td>
        <td>
            <select data-orig="${u.role_id}" onchange="onRoleChange(this)" style="padding:4px 6px;border:1px solid #d9d9d9;border-radius:4px;font-size:13px;">
                ${roleOpts}
            </select>
        </td>
        <td>${statusTxt}</td>
        <td>
            <button onclick="resetUserPwd('${u.username}')" style="background:#165DFF;color:white;">重置密码</button>
            <button onclick="toggleUserStatus('${u.username}',${u.status == 1 ? 0 : 1})" style="background:#ff4a4a;color:white;">
                ${u.status == 1 ? '禁用' : '启用'}
            </button>
            <button onclick="deleteUser('${u.username}')" style="background:#333;color:white;">删除</button>
        </td>
    </tr>`;
            });
            document.getElementById("userTableBody").innerHTML = html;
            // 更新保存按钮状态
            updateRoleSaveBtn();
            openModal("userModal");
        });
    });
}

// 下拉改变时记录脏数据 → 用 data-orig 标记行
function onRoleChange(sel) {
    const row = sel.closest("tr");
    const origVal = parseInt(sel.getAttribute("data-orig"));
    const newVal = parseInt(sel.value);
    if (origVal !== newVal) {
        row.style.background = "#fffbe6";
    } else {
        row.style.background = "";
    }
    updateRoleSaveBtn();
}

// 更新批量保存按钮状态 — 遍历所有 select
function updateRoleSaveBtn() {
    const btn = document.getElementById("batchSaveRoleBtn");
    if (!btn) return;
    const selects = document.querySelectorAll("#userTableBody select[data-orig]");
    let changed = 0;
    selects.forEach(sel => {
        if (parseInt(sel.value) !== parseInt(sel.getAttribute("data-orig"))) changed++;
    });
    btn.textContent = changed > 0 ? `💾 保存角色变更（${changed}）` : "💾 保存角色变更";
    btn.disabled = changed === 0;
    btn.style.opacity = changed > 0 ? "1" : "0.4";
    btn.style.pointerEvents = changed > 0 ? "auto" : "none";
}

// 批量保存角色变更 — 遍历 select 比对 data-orig
function batchSaveRoles() {
    const selects = document.querySelectorAll("#userTableBody select[data-orig]");
    const changes = [];
    selects.forEach(sel => {
        const orig = parseInt(sel.getAttribute("data-orig"));
        const cur = parseInt(sel.value);
        if (orig !== cur) {
            // 从行 id 取 username
            const row = sel.closest("tr");
            const username = row.id.replace("userRow_", "");
            changes.push({ username, roleId: cur });
        }
    });
    if (changes.length === 0) return;

    let completed = 0;
    let failed = [];

    changes.forEach(({ username, roleId }) => {
        fetch("/user/role", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ username, role_id: roleId })
        }).then(r => r.json()).then(d => {
            if (d.status === "success") {
                completed++;
            } else {
                failed.push(username + (d.msg ? "(" + d.msg + ")" : ""));
            }
        }).catch(() => {
            failed.push(username);
        }).finally(() => {
            if (completed + failed.length === changes.length) {
                if (failed.length === 0) {
                    showTopMsg(`成功修改 ${completed} 个用户角色`, "success");
                } else {
                    showTopMsg(`成功 ${completed} 个，失败 ${failed.length} 个：${failed.join(", ")}`, "error");
                }
                openUserModal();
            }
        });
    });
}

// 新增用户
function addUser(){
    let username = document.getElementById("newUserName").value.trim();
    let pwd = document.getElementById("newUserPwd").value.trim() || "123456";
    let roleId = document.getElementById("newUserRole").value;
    if(!username) return showTopMsg("请输入账号", "error");
    fetch("/user/add", {
        method:"POST",
        headers: getHeaders(),
        body: JSON.stringify({ username, password:pwd, role_id: parseInt(roleId) })
    }).then(res => res.json()).then(d => {
        if(d.status === "success"){
            showTopMsg("新增成功", "success");
            document.getElementById("newUserName").value = "";
            document.getElementById("newUserPwd").value = "";
            openUserModal();
        }else{
            showTopMsg(d.msg || "新增失败", "error");
        }
    });
}

// 重置用户密码
async function resetUserPwd(username){
    if (!await showConfirm("确认重置密码为 123456 ？")) return;
    fetch("/user/reset", {
        method:"POST", headers:getHeaders(),
        body:JSON.stringify({ username })
    }).then(() => showTopMsg("已重置为123456", "success"));
}

// 启用/禁用用户
function toggleUserStatus(username, status){
    fetch("/user/status", {
        method:"POST", headers:getHeaders(),
        body:JSON.stringify({ username, status })
    }).then(() => openUserModal());
}

// 删除用户
async function deleteUser(username){
    if (!await showConfirm(`确定彻底删除账号【${username}】？删除后不可恢复！`, true)) return;
    fetch("/user/delete", {
        method:"POST", headers:getHeaders(),
        body:JSON.stringify({ username })
    }).then(res=>res.json()).then(d=>{
        if(d.status==="success"){
            showTopMsg("删除成功", "success");
            openUserModal();
        }else{
            showTopMsg(d.msg||"删除失败", "error");
        }
    });
}

// ===================== 角色管理 =====================
let selectedRoleId = null;
let allPermissionsData = {};

function openRoleModal() {
    if (!hasPermission("user.manage")) return;
    selectedRoleId = null;
    // 同时加载权限和角色列表
    Promise.all([
        fetch("/api/permissions", { headers: getHeaders() }).then(r => r.json()),
        fetch("/api/roles", { headers: getHeaders() }).then(r => r.json())
    ]).then(([permData, roleData]) => {
        if (permData.status === "success") allPermissionsData = permData.data || {};
        if (roleData.status === "success") roleList = roleData.data || [];
        renderRoleList();
        document.getElementById("rolePermPanel").innerHTML =
            `<div style="color:#999;text-align:center;margin-top:60px;">← 请选择左侧角色进行编辑</div>`;
        openModal("roleModal");
    }).catch(() => showTopMsg("加载角色数据失败", "error"));
}

function renderRoleList() {
    const panel = document.getElementById("roleListPanel");
    panel.innerHTML = roleList.map(r => {
        let badge = r.is_system ? '<span style="color:#999;font-size:11px;">🔒 系统</span>' : '';
        let userCnt = r.user_count || 0;
        let canDelete = !r.is_system;
        let isSystemRole = r.is_system;
        // 非 sadmin 不能编辑系统内置角色
        let clickable = !isSystemRole || isSadmin;
        let style = clickable ? '' : 'opacity:0.6;';
        let activeClass = selectedRoleId === r.id && clickable ? 'role-item-active' : '';
        return `<div class="role-item ${activeClass}" onclick="${clickable ? `selectRole(${r.id})` : ''}" style="padding:6px 8px;cursor:${clickable ? 'pointer' : 'default'};border-radius:4px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;${selectedRoleId === r.id ? 'background:#e8f4ff;' : ''}${style}">
            <div>
                <strong>${escapeHtml(r.name)}</strong>
                <div style="font-size:11px;color:#666;">${badge}${!clickable ? ' <span style="color:#f53f3f;">🔑 仅sadmin</span>' : ''} 用户: ${userCnt}</div>
            </div>
            ${canDelete ? `<span onclick="event.stopPropagation();delRole(${r.id})" style="color:#f53f3f;cursor:pointer;font-size:16px;" title="删除">✕</span>` : ''}
        </div>`;
    }).join("");
}

function selectRole(roleId) {
    selectedRoleId = roleId;
    const role = roleList.find(r => r.id === roleId);
    if (!role) return;
    renderRoleList();

    // 渲染权限勾选面板
    const perms = role.permissions || [];
    let html = `<h4 style="margin:0 0 8px 0;">编辑角色：${escapeHtml(role.name)}</h4>`;
    html += `<div style="margin-bottom:8px;">
        <label>角色名称：</label>
        <input id="roleEditName" value="${escapeHtml(role.name)}" style="width:200px;padding:4px 8px;border:1px solid #d9d9d9;border-radius:4px;">
    </div>`;
    html += `<div style="margin-bottom:8px;">
        <label>描述：</label>
        <input id="roleEditDesc" value="${escapeHtml(role.description || '')}" style="width:300px;padding:4px 8px;border:1px solid #d9d9d9;border-radius:4px;">
    </div>`;
    html += `<div style="font-size:13px;color:#666;margin-bottom:8px;">权限设置：</div>`;

    for (const [group, items] of Object.entries(allPermissionsData)) {
        html += `<div style=\"margin-bottom:10px;\">
            <div style=\"font-weight:bold;color:#165DFF;margin-bottom:4px;\">${group}</div>
            <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:4px;\">`;
        items.forEach(p => {
            const checked = perms.indexOf(p.code) !== -1 ? "checked" : "";
            const canAssign = isSadmin || hasPermission(p.code);
            if (canAssign) {
                html += `<label style=\"display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:13px;background:${checked ? '#e8f4ff' : '#f5f5f5'};border:1px solid ${checked ? 'var(--primary)' : 'var(--border)'};line-height:1.6;
                    \" onclick=\"togglePermission(this)\" ondblclick=\"event.preventDefault()\">
                    <input type=\"checkbox\" value=\"${p.code}\" ${checked} onchange=\"updateCheckboxStyle(this)\" style=\"margin:0;width:14px;height:14px;flex-shrink:0;\">
                    <span style=\"user-select:none;\">${p.name}</span>
                </label>`;
            } else {
                html += `<label style=\"display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:4px;font-size:13px;background:#fafafa;border:1px solid #eee;line-height:1.6;opacity:0.45;cursor:not-allowed;pointer-events:none;\" title=\"你没有此权限\">
                    <input type=\"checkbox\" value=\"${p.code}\" ${checked} disabled style=\"margin:0;width:14px;height:14px;flex-shrink:0;\">
                    <span style=\"user-select:none;\">🔒 ${p.name}</span>
                </label>`;
            }
        });
        html += `</div></div>`;
    }
    document.getElementById("rolePermPanel").innerHTML = html;
}

function updateCheckboxStyle(cb) {
    const label = cb.parentElement;
    if (cb.checked) {
        label.style.background = "#e8f4ff";
        label.style.borderColor = "#165DFF";
    } else {
        label.style.background = "#f5f5f5";
        label.style.borderColor = "#ddd";
    }
}

function addCustomRole() {
    showPrompt("请输入新角色名称：", "新建角色", name => {
        if (!name.trim()) return showTopMsg("角色名称不能为空", "error");
        if (roleList.some(r => r.name === name.trim())) {
            return showTopMsg("角色名称已存在", "error");
        }
        fetch("/api/roles/add", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ name: name.trim(), description: "", permissions: [] })
        }).then(r => r.json()).then(data => {
            if (data.status === "success") {
                showTopMsg("角色创建成功", "success");
                openRoleModal();
            } else {
                showTopMsg(data.msg || "创建失败", "error");
            }
        }).catch(() => showTopMsg("网络异常", "error"));
    });
}

function saveRolePerm() {
    if (!selectedRoleId) return;
    const name = document.getElementById("roleEditName").value.trim();
    const description = document.getElementById("roleEditDesc").value.trim();
    if (!name) return showTopMsg("角色名称不能为空", "error");
    // 收集勾选的权限
    const checkboxes = document.querySelectorAll("#rolePermPanel input[type=checkbox]:checked");
    const permissions = Array.from(checkboxes).map(cb => cb.value);
    fetch("/api/roles/update", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ id: selectedRoleId, name, description, permissions })
    }).then(r => r.json()).then(data => {
        if (data.status === "success") {
            showTopMsg("角色权限已保存", "success");
            openRoleModal();
        } else {
            showTopMsg(data.msg || "保存失败", "error");
        }
    }).catch(() => showTopMsg("网络异常", "error"));
}

async function delRole(roleId) {
    if (!await showConfirm("确定删除此角色？", true)) return;
    fetch("/api/roles/del", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ id: roleId })
    }).then(r => r.json()).then(data => {
        if (data.status === "success") {
            showTopMsg("角色已删除", "success");
            openRoleModal();
        } else {
            showTopMsg(data.msg || "删除失败", "error");
        }
    }).catch(() => showTopMsg("网络异常", "error"));
}
// ===================== 角色管理结束 =====================

// ===================== 自定义输入弹窗 =====================
function showPrompt(msg, title, callback) {
    const overlay = document.getElementById("promptOverlay");
    const input = document.getElementById("promptInput");
    const errorEl = document.getElementById("promptError");
    document.getElementById("promptTitle").textContent = title || "请输入";
    document.getElementById("promptOk").textContent = "确定";
    input.value = "";
    input.placeholder = msg;
    errorEl.style.display = "none";
    overlay.style.display = "flex";

    // 移除旧监听器，用新监听
    const okBtn = document.getElementById("promptOk");
    const cancelBtn = document.getElementById("promptCancel");
    const okHandler = () => {
        const val = input.value.trim();
        if (!val) {
            errorEl.textContent = "内容不能为空";
            errorEl.style.display = "block";
            input.focus();
            return;
        }
        overlay.style.display = "none";
        callback(val);
    };
    const cancelHandler = () => {
        overlay.style.display = "none";
    };
    // 先替换旧监听（cloneNode 方式清空）
    const newOk = okBtn.cloneNode(true);
    const newCancel = cancelBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    newOk.addEventListener("click", okHandler);
    newCancel.addEventListener("click", cancelHandler);

    // 回车确认
    const keyHandler = (e) => {
        if (e.key === "Enter") { okHandler(); }
        if (e.key === "Escape") { cancelHandler(); }
    };
    input.addEventListener("keydown", keyHandler);
    // 关掉时清理 keydown
    const cleanup = () => {
        input.removeEventListener("keydown", keyHandler);
    };
    newOk.addEventListener("click", cleanup);
    newCancel.addEventListener("click", cleanup);

    setTimeout(() => input.focus(), 100);
}

// ===================== 自定义确认弹窗 =====================

// 以下为你原有逻辑，全部已适配token
function foldCode(text) {
    if (!text || text.indexOf('\n') === -1) return text;
    // 去掉HTML标签后检测是否像代码
    const clean = text.replace(/<[^>]+>/g, '');
    const isSQL = /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|TABLE|INTO|JOIN|ALTER|DROP|SET|GROUP|ORDER|HAVING|LIMIT|INNER|LEFT|RIGHT|COUNT|SUM|DISTINCT)\b/i.test(clean);
    const isCode = isSQL
        || /\b(function|var|let|const|if|for|while|return|import|export|class|Sub\s|End\s|Dim\s|Private|Public|def\s)\b/i.test(clean)
        || /[{;]/.test(clean);
    if (!isCode) return text; // 普通文本不折叠
    const lang = isSQL ? 'SQL' : '代码';
    const lines = clean.split('\n').length;
    const id = 'code_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
    return `<div class="code-fold-wrap">
    <div class="code-fold-header" onclick="document.getElementById('${id}').classList.toggle('open');this.querySelector('.fold-arrow').style.transform=document.getElementById('${id}').classList.contains('open')?'rotate(90deg)':'rotate(0deg)'">
        <span class="fold-label">
            <span class="fold-arrow">▶</span>
            <span class="fold-lang">${lang}</span>
            <span>${lines} 行</span>
        </span>
        <span class="fold-extra">点击展开</span>
    </div>
    <div class="code-fold-body" id="${id}">${text}</div>
</div>`;
}
function highlightSQL(text) {
    if (!text) return '';
    const keywords = /\b(SELECT|FROM|WHERE|AND|OR|INSERT|UPDATE|DELETE|SET|GROUP BY|ORDER BY|LIMIT|JOIN|LEFT JOIN|INNER JOIN|ON|AS|DISTINCT|COUNT|SUM|AVG|MAX|MIN|CASE|WHEN|THEN|END|LIKE|IN|BETWEEN|NOT|NULL|IS|ASC|DESC)\b/gi;
    return text.replace(keywords, '<span style="color:#0066cc; font-weight:bold;">$1</span>');
}

function initApp(){
    fetch("/get_cate",{method:"GET", headers:getHeaders()})
    .then(res=>res.json())
    .then(data=>{
        cateOptions = data;
        reloadCateSelect();
        setCurrentMonthDate();
        search();
        loadDashboard();
        initDashboardDrag();
        refreshSearchClearBtn();
    });

    const searchInput = document.getElementById("searchKey");
    searchInput.onkeydown = function(e){
        if(e.key === "Enter") {
            document.getElementById("suggestBox").style.display = "none";
            clearTimeout(searchDebounceTimer);
            currentPage = 1;
            search();
            document.getElementById("result").scrollTo({top: 0, behavior: 'smooth'});
        }
    }
    searchInput.addEventListener("input", refreshSearchClearBtn);
    searchInput.addEventListener("change", refreshSearchClearBtn);
    searchInput.addEventListener("focus", refreshSearchClearBtn);
    searchInput.addEventListener("blur", refreshSearchClearBtn);
    // 输入防抖自动搜索（800ms）
    searchInput.addEventListener("input", function() {
        clearTimeout(searchDebounceTimer);
        const val = this.value.trim();
        searchDebounceTimer = setTimeout(() => {
            if (val !== "" || document.getElementById("cateSel").value !== "全部") {
                currentPage = 1;
                search();
            }
        }, 800);
    });
    document.getElementById("searchClearBtn").addEventListener("click", function(){
        searchInput.value = "";
        refreshSearchClearBtn();
        currentPage = 1;
        search();
    });
    
    // 回到顶部：监听结果区域滚动
    let resultBox = document.getElementById("result");
    let backBtn = document.getElementById("backTopBtn");
    resultBox.addEventListener("scroll", function(){
        backBtn.style.display = this.scrollTop > 300 ? "flex" : "none";
    });
    
    // 预加载回收站数据（用户点击时秒开）
    if (hasPermission("recycle.view")) {
        fetch("/get_recycle", { method:"POST", headers:getHeaders() })
            .then(r => r.json())
            .then(list => { recycleCache = list; })
            .catch(() => {});
    }
    
    // 标题逐字拆分，实现逐字 hover 动效
    const titleEl = document.querySelector(".header-title");
    if (titleEl && !titleEl.dataset.split) {
        titleEl.dataset.split = "1";
        titleEl.innerHTML = titleEl.textContent.split('').map(c => `<span>${c}</span>`).join('');
    }
}

// 回到顶部
function scrollSearchTop(){
    document.getElementById("result").scrollTo({top: 0, behavior: 'smooth'});
}

function refreshSearchClearBtn() {
    const searchInput = document.getElementById("searchKey");
    const clearBtn = document.getElementById("searchClearBtn");
    clearBtn.style.display = searchInput.value.trim() ? "block" : "none";
}

function showMsg(text,isError=false){
    let el = document.getElementById("toastOverlay");
    let box = document.getElementById("toastText");
    box.innerText = text;
    box.className = "toast-box" + (isError ? " error" : "");
    el.style.display = "flex";
    el.classList.remove("fade-out");
    setTimeout(() => {
        el.classList.add("fade-out");
        setTimeout(() => { el.style.display = "none"; }, 600);
    }, 1800);
}

// 自定义确认弹窗（替代浏览器confirm）
function showConfirm(msg, danger) {
    return new Promise((resolve) => {
        let el = document.getElementById("confirmOverlay");
        let okBtn = document.getElementById("confirmOk");
        let cancelBtn = document.getElementById("confirmCancel");
        document.getElementById("confirmMsg").innerText = msg;
        if (danger) {
            okBtn.className = "btn-ok btn-del-ok";
            okBtn.innerText = "删除";
        } else {
            okBtn.className = "btn-ok";
            okBtn.innerText = "确定";
        }
        el.style.display = "flex";

        okBtn.onclick = function() {
            el.style.display = "none";
            resolve(true);
        };
        cancelBtn.onclick = function() {
            el.style.display = "none";
            resolve(false);
        };
    });
}

// 顶部通知条（替代浏览器alert）
function showTopMsg(text, type){
    let el = document.getElementById("topNotify");
    let box = document.getElementById("notifyText");
    box.innerText = text;
    box.className = "notify-bar " + (type || "info");
    el.style.display = "block";
    el.classList.remove("fade-out");
    setTimeout(() => {
        el.classList.add("fade-out");
        setTimeout(() => { el.style.display = "none"; }, 300);
    }, 2500);
}

function showCateTip(text) {
    let tip = document.getElementById("cateTip");
    tip.innerText = text;
    tip.className = "";
    setTimeout(() => { tip.classList.add("fade-out"); }, 2000);
}

async function refreshStat(){
    try {
        let cate = document.getElementById("cateSel").value;
        let params = new URLSearchParams();
        if (cate && cate !== "全部") params.set("cate", cate);
        let res = await fetch("/api/stat_counts?" + params.toString(), {method:"GET", headers:getHeaders()});
        let data = await res.json();
        if (data.status === "success") {
            animateNumber("totalCount", data.total);
            animateNumber("weeklyCount", data.weekly);
            animateNumber("monthlyCount", data.monthly);
        }
    } catch(e) {
        document.getElementById("weeklyCount").innerText = "-";
        document.getElementById("monthlyCount").innerText = "-";
    }
}

// ===== 仪表盘数据 =====
const DONUT_COLORS = ['#165DFF','#0fc6c2','#f9ab00','#9f7aea','#f53f3f','#00b42a','#ff7d00','#3491fa','#c9cdd4','#722ed1'];

async function loadDashboard() {
    try {
        let res = await fetch("/api/dashboard", {method:"GET", headers:getHeaders()});
        let data = await res.json();
        if (data.status !== "success") return;

        // 分类分布环形图
        renderDonut(data.categories);

        // 趋势 sparkline
        renderSparkline(data.trend);

        // 星标数
        animateNumber("starCount", data.star_count);

        // 最近动态
        renderRecentActivity(data.recent);
    } catch(e) {
        console.warn('Dashboard load failed', e);
    }
}

function renderDonut(categories) {
    const svg = document.getElementById('cateDonut');
    const legend = document.getElementById('cateLegend');
    if (!svg || !legend) return;

    const total = categories.reduce((s, c) => s + c.count, 0);
    document.getElementById('cateCount').innerText = categories.length + ' 个';

    if (total === 0) {
        svg.innerHTML = '<circle cx="60" cy="60" r="40" fill="none" stroke="#e8ecf2" stroke-width="14"/>';
        legend.innerHTML = '<div style="color:#999;font-size:12px;">暂无分类数据</div>';
        return;
    }

    let paths = '';
    let legendHtml = '';
    let startAngle = -90; // start from top

    categories.slice(0, 8).forEach((cat, i) => {
        const pct = cat.count / total;
        const angle = pct * 360;
        const color = DONUT_COLORS[i % DONUT_COLORS.length];

        // SVG arc
        const startRad = startAngle * Math.PI / 180;
        const endRad = (startAngle + angle) * Math.PI / 180;
        const large = angle > 180 ? 1 : 0;
        const r = 40;
        const x1 = 60 + r * Math.cos(startRad);
        const y1 = 60 + r * Math.sin(startRad);
        const x2 = 60 + r * Math.cos(endRad);
        const y2 = 60 + r * Math.sin(endRad);

        if (pct > 0.001) {
            paths += `<path d="M60 60 L${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
        }

        // Legend
        const pctStr = (pct * 100).toFixed(1);
        legendHtml += `<div class="cate-legend-item"><span class="cate-legend-dot" style="background:${color}"></span><span class="cate-legend-name">${_escHtml(cat.name)}</span><span class="cate-legend-cnt">${cat.count} (${pctStr}%)</span></div>`;

        startAngle += angle;
    });

    // "其他" aggregation
    if (categories.length > 8) {
        const otherCount = categories.slice(8).reduce((s, c) => s + c.count, 0);
        const pct = otherCount / total;
        const angle = pct * 360;
        const startRad = startAngle * Math.PI / 180;
        const endRad = (startAngle + angle) * Math.PI / 180;
        const large = angle > 180 ? 1 : 0;
        const x1 = 60 + 40 * Math.cos(startRad);
        const y1 = 60 + 40 * Math.sin(startRad);
        const x2 = 60 + 40 * Math.cos(endRad);
        const y2 = 60 + 40 * Math.sin(endRad);
        paths += `<path d="M60 60 L${x1.toFixed(2)} ${y1.toFixed(2)} A40 40 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${DONUT_COLORS[9]}" stroke="#fff" stroke-width="1.5"/>`;
        legendHtml += `<div class="cate-legend-item"><span class="cate-legend-dot" style="background:${DONUT_COLORS[9]}"></span><span class="cate-legend-name">其他</span><span class="cate-legend-cnt">${otherCount} (${(pct*100).toFixed(1)}%)</span></div>`;
    }

    // Center hole (white circle for donut)
    svg.innerHTML = paths + '<circle cx="60" cy="60" r="24" fill="#fff"/><text x="60" y="58" text-anchor="middle" fill="#1d2129" font-size="16" font-weight="700">' + total + '</text><text x="60" y="72" text-anchor="middle" fill="#86909c" font-size="9">总计</text>';
    legend.innerHTML = legendHtml;
}

function renderSparkline(trend) {
    const svg = document.getElementById('sparkTotal');
    if (!svg || !trend || trend.length === 0) return;

    const maxVal = Math.max(...trend.map(t => t.count), 1);
    const w = 80, h = 28;
    const step = w / (trend.length - 1);
    let points = '';
    let areaPoints = '';

    trend.forEach((t, i) => {
        const x = i * step;
        const y = h - (t.count / maxVal) * (h - 4) - 2;
        points += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
        areaPoints += x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    });

    // close area path
    const areaPath = 'M0,' + h + ' L' + areaPoints + 'L' + w + ',' + h + ' Z';

    svg.innerHTML = `<path class="spark-area" d="${areaPath}"/><path class="spark-path" d="M${areaPoints.trim()}"/>`;
}

function renderRecentActivity(recent) {
    const container = document.getElementById('recentActivity');
    if (!container) return;

    if (!recent || recent.length === 0) {
        container.innerHTML = '<div class="activity-empty">暂无动态</div>';
        return;
    }

    container.innerHTML = recent.map(r => {
        const timeShort = r.time ? r.time.replace(/^\d{4}-/, '').replace(/^0/g, '') : '';
        const icon = r.action_icon || '●';
        const color = r.action_color || '#86909c';
        return `<div class="activity-item"><span class="act-icon" style="color:${color}">${_escHtml(icon)}</span><span class="act-content">${_escHtml(r.content)}</span><span class="act-time">${_escHtml(timeShort)}</span></div>`;
    }).join('');
}

function animateNumber(elemId, target) {
    const el = document.getElementById(elemId);
    if (!el) return;
    const current = parseInt(el.innerText) || 0;
    if (current === target) return;
    const duration = 300;
    const start = performance.now();
    function step(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        const val = Math.round(current + (target - current) * eased);
        el.innerText = val;
        if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
}

// ===== 仪表盘卡片拖拽排序 =====
const DASHBOARD_ORDER_KEY = 'kb_dashboard_order';

function initDashboardDrag() {
    const box = document.getElementById('dashboardRow');
    if (!box) return;

    // 恢复保存的排序
    restoreDashboardOrder();

    // 给每张卡片绑定拖拽事件
    const cards = box.querySelectorAll('.stat-card');
    cards.forEach(card => {
        card.draggable = true;
        card.style.cursor = 'grab';

        card.addEventListener('dragstart', function(e) {
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', card.id);
        });

        card.addEventListener('dragend', function() {
            card.classList.remove('dragging');
            // 清理所有 drag-over
            box.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
        });

        card.addEventListener('dragover', function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const dragging = box.querySelector('.dragging');
            if (!dragging || dragging === card) return;

            // 清理其他 drag-over
            box.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));

            // 判断插入方向：鼠标在卡片左半边 → 前面，右半边 → 后面
            const rect = card.getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            if (e.clientX < mid) {
                card.classList.add('drag-over');
            } else {
                card.classList.add('drag-over');
            }
        });

        card.addEventListener('dragleave', function() {
            card.classList.remove('drag-over');
        });

        card.addEventListener('drop', function(e) {
            e.preventDefault();
            const draggingId = e.dataTransfer.getData('text/plain');
            const dragging = document.getElementById(draggingId);
            if (!dragging || dragging === card) return;

            const rect = card.getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            if (e.clientX < mid) {
                box.insertBefore(dragging, card);
            } else {
                box.insertBefore(dragging, card.nextSibling);
            }

            // 保存新顺序
            saveDashboardOrder();
        });
    });
}

function saveDashboardOrder() {
    const box = document.getElementById('dashboardRow');
    if (!box) return;
    const ids = Array.from(box.querySelectorAll('.stat-card')).map(c => c.id);
    localStorage.setItem(DASHBOARD_ORDER_KEY, JSON.stringify(ids));
}

function restoreDashboardOrder() {
    try {
        const saved = localStorage.getItem(DASHBOARD_ORDER_KEY);
        if (!saved) return;
        const order = JSON.parse(saved);
        const box = document.getElementById('dashboardRow');
        if (!box) return;
        // 按 saved 顺序重新 append，不存在的跳过
        order.forEach(id => {
            const card = document.getElementById(id);
            if (card) box.appendChild(card);
        });
    } catch(e) {
        // 排版数据损坏则忽略
    }
}

async function toggleStar(id, el) {
    try {
        let res = await fetch(`/api/toggle_star/${id}`, { method: "POST", headers: getHeaders() });
        let data = await res.json();
        if (data.status === "success") {
            el.innerText = data.is_important ? "⭐" : "☆";
            el.classList.toggle("starred", data.is_important === 1);
        }
    } catch(e) {
        showToast("星标操作失败", "error");
    }
}

function copyContent(btn) {
    let parent = btn.parentElement;
    let text = "";
    for (let child of parent.childNodes) {
        if (child.nodeType === 3) { // text node
            text += child.textContent;
        } else if (child.nodeType === 1 && child !== btn && !child.classList.contains("copy-btn") && !child.classList.contains("copy-btn-inner")) {
            // 如果是折叠代码块，只取展开后的代码内容，跳过头部文字
            if (child.classList.contains("code-fold-wrap")) {
                let body = child.querySelector(".code-fold-body");
                if (body) {
                    text += body.textContent;
                } else {
                    text += child.textContent;
                }
            } else {
                text += child.textContent;
            }
        }
    }
    // 去掉按钮emoji和多余文字，每行去除首尾空白，再整体trim
    text = text.replace(/[📋✅]/g, '').split('\n').map(function(l){ return l.trim(); }).join('\n').trim();
    var copied = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function(){ onCopyDone(btn); });
    } else {
        // 兜底：textarea + execCommand
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); copied = true; } catch(e){}
        document.body.removeChild(ta);
        if (copied) onCopyDone(btn); else showToast('复制失败', 'error');
    }
}
function onCopyDone(btn){
    btn.classList.add('copied');
    btn.innerText = '✅';
    setTimeout(function(){ btn.classList.remove('copied'); btn.innerText = '📋'; }, 1500);
}

function reloadCateSelect(){
    let s1 = document.getElementById("cateSel");
    let s2 = document.getElementById("newCate");
    let s3 = document.getElementById("editCate");
    s1.innerHTML = '<option value="全部">全部分类</option>';
    s2.innerHTML = s3.innerHTML = "";
    cateOptions.forEach(c=>{
        s1.innerHTML += `<option value="${c}">${c}</option>`;
        s2.innerHTML += `<option value="${c}">${c}</option>`;
        s3.innerHTML += `<option value="${c}">${c}</option>`;
    });
    refreshStat(); loadDashboard();
}

async function search(){
    let key = document.getElementById("searchKey").value.trim();
    logSearchHistory(key);
    let cate = document.getElementById("cateSel").value;
    let startDate = document.getElementById("startDate").value;
    let endDate = document.getElementById("endDate").value;

    try {
        let r = await fetch("/search",{
            method:"POST",
            headers:getHeaders(),
            body:JSON.stringify({keyword:key,cate:cate,startDate:startDate,endDate:endDate,page:currentPage,pageSize:pageSize})
        });
        let data = await r.json();
        if (!data || !Array.isArray(data.records)) {
            showTopMsg("搜索返回异常：" + JSON.stringify(data).substring(0, 100), "error");
            return;
        }
        allRecords = data.records;
        totalRecords = data.total || 0;
        // 后端已按加权评分排序（标题0.6+内容0.4），前端不再重新排序
        renderListByPage();
        renderPagination(); 
        refreshStat(); loadDashboard();
        document.getElementById("cateCount").innerText = cateOptions.length + " 个";
        refreshSearchClearBtn();
    } catch(e) {
        console.error("搜索异常:", e);
        showTopMsg("搜索请求失败，请检查网络", "error");
    }
}

function high(text,key){
    if(!text) return '';
    let safe = escapeHtml(text);
    if(!key) return safe;
    let escapedKey = escapeRegex(key);
    return safe.replace(new RegExp("("+escapedKey+")","gi"),"<span class='highlight'>$1</span>");
}

function renderListByPage(){
    renderList(allRecords, document.getElementById("searchKey").value.trim());
}

function renderList(list,key){
    let tip = document.getElementById("resultTip");
    let box = document.getElementById("result");
    tip.style.display = "none";
    if(list.length===0){
        box.innerHTML = `<div class="empty-box"><div class="empty-icon">📂</div><div class="empty-text">暂无数据</div></div>`;
        return;
    }
    let html = "";
    list.forEach(i=>{
        let q = high(i.question,key);
        let a = highlightSQL(high(i.solution,key));
        let r = high(i.remark||"",key);
        let s = high(i.submitter||"",key);
        let p = high(i.proposer||"",key);

        html+=`
<div class="item">
    <div class="item-header">
        <span class="item-star ${i.is_important ? 'starred' : ''}" onclick="toggleStar(${i.id}, this)">${i.is_important ? '⭐' : '☆'}</span>
        <span class="item-id">ID:${i.id} <span class="item-time">${i.record_time}</span></span>
    </div>
    <div class="item-cate">${escapeHtml(i.category)}</div>
    <div class="item-submitter" style="font-size:12px;color:#666;margin-bottom:6px;">录入人：${s || "未知"} | 提出人：${p || "无"}</div>
    <div class="item-q" style="font-weight:bold;">${q}</div>
    <div class="solution-wrap"><button class="copy-btn" onclick="copyContent(this)" title="复制内容">📋</button>${foldCode(a)}</div>
    <div class="item-r">补充说明：${r||"无"}</div>
    <div style="margin-top:20px; font-size:13px; color:#165DFF; font-weight:bold;">
        ${i.has_attachment ? '<button class="btn-sm" style="background:#165DFF;border:none;" onclick="viewAttachments(' + i.id + ')">📎 查看附件</button>' : ''}
    </div>
    <div class="item-btn-group">
        ${hasPermission("knowledge.edit") ? `<button class="btn-sm" style="background:#165DFF;" onclick="editRecord(${i.id})">编辑</button>` : ''}
        ${hasPermission("knowledge.delete") ? `<button class="btn-sm btn-del" onclick="delRecord(${i.id})">删除</button>` : ''}
    </div>
</div>`;
    });
    box.innerHTML = html;
    // 滚动到结果顶部
    document.getElementById("result").scrollTo({top: 0, behavior: 'smooth'});
}

function renderPagination(){
    let total = totalRecords;
    let totalPage = Math.ceil(total / pageSize);
    let box = document.getElementById("pagination");
    box.innerHTML = "";
    if (totalPage <= 1) return;
    let first = document.createElement("button");
    first.className = "page-btn";
    first.innerText = "首页";
    first.disabled = currentPage <= 1;
    first.onclick = () => { currentPage = 1; search(); };    box.appendChild(first);
    let prev = document.createElement("button");
    prev.className = "page-btn";
    prev.innerText = "上一页";
    prev.disabled = currentPage <= 1;
    prev.onclick = () => { currentPage--; search(); };    box.appendChild(prev);
    let start = Math.max(1, currentPage - 1);
    let end = Math.min(totalPage, currentPage + 1);
    for (let i = start; i <= end; i++) {
        let btn = document.createElement("button");
        btn.className = "page-btn";
        if (i === currentPage) btn.classList.add("active");
        btn.innerText = i;
        btn.onclick = () => { currentPage = i; search(); };
        box.appendChild(btn);
    }
    let next = document.createElement("button");
    next.className = "page-btn";
    next.innerText = "下一页";
    next.disabled = currentPage >= totalPage;
    next.onclick = () => { currentPage++; search(); };
    box.appendChild(next);
    // 新增：显示共X页
    let pageText = document.createElement("span");
    pageText.style.cssText = "margin-left:10px; font-size:13px; color:#666;";
    pageText.innerText = `共 ${totalPage} 页`;
    box.appendChild(pageText);
    
    // 每页条数选择
    let pageSizeLabel = document.createElement("span");
    pageSizeLabel.style.cssText = "margin-left:10px; font-size:13px; color:#666;";
    pageSizeLabel.innerText = "每页";
    box.appendChild(pageSizeLabel);
    let pageSizeSel = document.createElement("select");
    pageSizeSel.style.cssText = "margin:0 4px; padding:2px 4px; font-size:12px; border:1px solid #dcdfe6; border-radius:4px; outline:none; width:auto; min-width:50px;";
    [10, 20, 50].forEach(n => {
        let opt = document.createElement("option");
        opt.value = n;
        opt.innerText = n;
        if (n === pageSize) opt.selected = true;
        pageSizeSel.appendChild(opt);
    });
    pageSizeSel.onchange = function() {
        pageSize = parseInt(this.value);
        currentPage = 1;
        search();
    };
    box.appendChild(pageSizeSel);
    let pageSizeLabel2 = document.createElement("span");
    pageSizeLabel2.style.cssText = "font-size:13px; color:#666;";
    pageSizeLabel2.innerText = "条";
    box.appendChild(pageSizeLabel2);
}

let newUploadedFiles = [];
let currentUploadXhr = null; // 当前进行中的上传请求（用于取消）

async function add(){
    let proposer = document.getElementById("proposer").value.trim();
    let category = document.getElementById("newCate").value;
    let question = document.getElementById("question").value.trim();
    let solution = document.getElementById("solution").value.trim();
    let remark = document.getElementById("remark").value.trim();
    
    // 显示行内校验提示
    const qHint = document.getElementById("questionHint");
    const sHint = document.getElementById("solutionHint");
    qHint.style.display = question ? "none" : "block";
    sHint.style.display = solution ? "none" : "block";
    if(!question || !solution) {
        if (!question) document.getElementById("question").focus();
        return;
    }
    
    // 查重模式列表（可多选，都不选则跳过查重）
    const modes = loadDedupModes();

    // 先查重（有选中模式时才查）
    if (modes.length > 0) {
        try {
            let dupRes = await fetch("/api/check_duplicate",{
                method:"POST",headers:getHeaders(),
                body:JSON.stringify({question, solution, threshold: loadDedupThreshold(), modes})
            });
            let dupData = await dupRes.json();
            if(dupData.status === "success" && dupData.total_found > 0){
                // 有重复，显示查重弹窗
                showDupModal(dupData);
                return;
            }
        } catch(e) {
            // 查重接口失败不影响继续保存
            console.warn("查重异常", e);
        }
    }
    
    // 无重复或查重失败，直接保存
    await doSave(proposer, category, question, solution, remark);
}

async function doSave(proposer, category, question, solution, remark){
    let res = await fetch("/add",{
        method:"POST",headers:getHeaders(),
        body:JSON.stringify({proposer, cate:category, question,solution,remark})
    });
    let d = await res.json();
    if(d.status==="error") {
        showMsg(d.msg,true);
    } else {
        // 绑定已上传的附件到新记录
        if (newUploadedFiles.length > 0 && d.id) {
            for (let f of newUploadedFiles) {
                const fd = new FormData();
                fd.append("knowledge_id", d.id);
                fd.append("origin_name", f.origin_name);
                fd.append("save_name", f.save_name);
                fd.append("file_ext", f.file_ext);
                await fetch("/bind_attachment", {
                    method: "POST",
                    headers: { token: getToken() },
                    body: fd
                });
            }
            newUploadedFiles = [];
            document.getElementById("newAttachmentList").innerHTML = "";
        }
        showMsg("保存成功");
        document.getElementById("proposer").value = "";
        document.getElementById("question").value = "";
        document.getElementById("solution").value = "";
        document.getElementById("remark").value = "";
        // 清除校验提示
        document.getElementById("questionHint").style.display = "none";
        document.getElementById("solutionHint").style.display = "none";
        search();
    }
}

// 查重弹窗
function showDupModal(dupData){
    let list = document.getElementById("dupList");
    let summary = document.getElementById("dupSummary");
    let icon = document.getElementById("dupWarnIcon");
    let saveBtn = document.getElementById("dupSaveBtn");
    
    let html = "";
    let hasHigh = dupData.high_warning_count > 0;
    let items = dupData.duplicates;
    
    if(hasHigh){
        icon.innerText = "🔴";
        saveBtn.style.background = "#f53f3f";
        saveBtn.onmouseover = function(){this.style.background="#d4380d"};
        saveBtn.onmouseout = function(){this.style.background="#f53f3f"};
    } else {
        icon.innerText = "⚠️";
        saveBtn.style.background = "#ff7d00";
        saveBtn.onmouseover = function(){this.style.background="#d25f00"};
        saveBtn.onmouseout = function(){this.style.background="#ff7d00"};
    }
    
    summary.innerText = `共找到 ${dupData.total_found} 条相似记录` + 
        (hasHigh ? `，其中 ${dupData.high_warning_count} 条相似度 ≥ 80%` : "");
    
    items.forEach(r => {
        let simColor = r.similarity >= 80 ? "#f53f3f" : r.similarity >= 60 ? "#ff7d00" : r.similarity >= 40 ? "#86909c" : "#b0b3b8";
        let qText = escapeHtml(r.question || "(无标题)");
        let sText = escapeHtml(r.solution || "");
        if(sText.length > 80) sText = sText.substring(0,80) + "...";
        
        html += `
        <div style="padding:12px 14px;margin-bottom:8px;border-radius:8px;background:#f7f8fa;border-left:3px solid ${simColor};">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <a href="javascript:void(0)" onclick="searchById(${r.id})" style="color:#165DFF;font-weight:600;font-size:14px;text-decoration:none;cursor:pointer;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">
                    ID: ${r.id}
                </a>
                <span style="font-size:13px;font-weight:600;color:${simColor};">${r.similarity}%</span>
            </div>
            <div style="font-size:13px;color:#1d2129;margin-bottom:4px;font-weight:500;">${qText}</div>
            <div style="font-size:12px;color:#86909c;line-height:1.5;">${sText}</div>
        </div>
        `;
    });
    
    list.innerHTML = html;
    document.getElementById("dupOverlay").style.display = "flex";
}

function dupCancel(){
    document.getElementById("dupOverlay").style.display = "none";
}

async function dupProceed(){
    document.getElementById("dupOverlay").style.display = "none";
    // 从表单实时读取数据（解决弹窗期间用户修改的问题）
    let proposer = document.getElementById("proposer").value.trim();
    let category = document.getElementById("newCate").value;
    let question = document.getElementById("question").value.trim();
    let solution = document.getElementById("solution").value.trim();
    let remark = document.getElementById("remark").value.trim();
    await doSave(proposer, category, question, solution, remark);
}

// 点击ID进行搜索定位
function searchById(id){
    document.getElementById("dupOverlay").style.display = "none";
    document.getElementById("searchKey").value = id;
    currentPage = 1;
    search();
    // 滚动到搜索结果区域
    document.querySelector(".search-card").scrollIntoView({behavior:"smooth", block:"start"});
}

// 新增知识附件上传
function doNewUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const tip = document.getElementById("newAttachTip");
    // 校验必填项
    let question = document.getElementById("question").value.trim();
    let solution = document.getElementById("solution").value.trim();
    if (!question || !solution) {
        tip.innerText = "⚠️ 请将上方信息录入完整";
        tip.style.color = "#f53f3f";
        setTimeout(() => { tip.innerText = ""; tip.style.color = "#666"; }, 3000);
        e.target.value = "";
        return;
    }
    tip.style.color = "#666";
    // 显示取消按钮
    tip.innerHTML = '准备上传... <span id="uploadCancelBtn" style="color:#f53f3f;cursor:pointer;margin-left:8px;font-weight:bold;text-decoration:underline;" onclick="cancelUpload()">取消</span>';
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    currentUploadXhr = xhr;
    xhr.open("POST", "/upload", true);
    xhr.setRequestHeader("token", getToken());
    xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
            tip.innerHTML = `上传中：${Math.floor(e.loaded / e.total * 100)}% <span style="color:#f53f3f;cursor:pointer;margin-left:8px;font-weight:bold;text-decoration:underline;" onclick="cancelUpload()">取消</span>`;
        }
    };
    xhr.onload = function() {
        currentUploadXhr = null;
        if (xhr.status === 200) {
            const d = JSON.parse(xhr.responseText);
            if (d.status === "success") {
                tip.innerHTML = "✅ 上传成功：" + escapeHtml(d.origin_name);
                setTimeout(() => { tip.style.opacity = "0"; setTimeout(() => { tip.innerHTML = ""; tip.style.opacity = "1"; }, 1000); }, 2500);
                newUploadedFiles.push(d);
                let list = document.getElementById("newAttachmentList");
                let item = document.createElement("div");
                item.style.display = "flex";
                item.style.alignItems = "center";
                let span = document.createElement("span");
                span.innerText = "📎 " + d.origin_name;
                span.style.color = "#165DFF";
                let delBtn = document.createElement("span");
                delBtn.innerText = " ✕";
                delBtn.style.color = "#f53f3f";
                delBtn.style.cursor = "pointer";
                delBtn.style.marginLeft = "8px";
                delBtn.onclick = function() {
                    newUploadedFiles = newUploadedFiles.filter(x => x.save_name !== d.save_name);
                    item.remove();
                };
                item.appendChild(span);
                item.appendChild(delBtn);
                list.appendChild(item);
            } else {
                tip.innerText = "❌ 上传失败";
            }
        } else {
            tip.innerText = "❌ 上传异常";
        }
    };
    // aborted 时静默处理
    xhr.onabort = function() {
        currentUploadXhr = null;
        const tip = document.getElementById("newAttachTip");
        tip.innerHTML = "⛔ 已取消上传";
        tip.style.color = "#999";
        setTimeout(() => { tip.innerHTML = ""; tip.style.color = "#666"; }, 2000);
    };
    xhr.onerror = function() {
        currentUploadXhr = null;
    };
    xhr.send(fd);
    e.target.value = "";
}

// 取消当前上传
function cancelUpload() {
    if (currentUploadXhr) {
        currentUploadXhr.abort();
    }
}

// ===================== 【新增】AI智能解析并回填 =====================
function toggleAI() {
    const body = document.getElementById("aiBody");
    const icon = document.getElementById("aiToggleIcon");
    if (body.style.display === "none") {
        body.style.display = "block";
        icon.innerHTML = "▾";
    } else {
        body.style.display = "none";
        icon.innerHTML = "▸";
    }
}

async function aiParse() {
    const btn = document.getElementById("aiParseBtn");
    const aiMsg = document.getElementById("aiMsg");
    const text = document.getElementById("aiInput").value.trim();

    // 空内容校验
    if (!text) {
        aiMsg.innerText = "⚠️ 请先输入要解析的文本";
        aiMsg.style.color = "#f53f3f";
        setTimeout(() => { aiMsg.innerText = ""; }, 3000);
        return;
    }

    // 按钮置灰加载，防重复点击
    btn.disabled = true;
    btn.innerText = "⏳ AI解析中...";
    aiMsg.innerText = "⏳ 正在调用AI分析...";
    aiMsg.style.color = "#666";

    try {
        const res = await fetch("/api/ai_parse", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ text })
        });
        const data = await res.json();

        if (data.status === "error") {
            aiMsg.innerText = "❌ " + data.msg;
            aiMsg.style.color = "#f53f3f";
            setTimeout(() => { aiMsg.innerText = ""; }, 5000);
            return;
        }

        // 自动回填上方原有四个表单字段
        document.getElementById("newCate").value = data.data.category;
        document.getElementById("proposer").value = data.data.proposer || "";
        document.getElementById("question").value = data.data.question;
        document.getElementById("solution").value = data.data.solution;

        aiMsg.innerText = "✅ 解析完成，已自动回填上方表单，请核对后手动提交！";
        aiMsg.style.color = "#00b42a";
        setTimeout(() => { aiMsg.innerText = ""; }, 5000);
    } catch (e) {
        aiMsg.innerText = "❌ 网络异常，请检查网络连接后重试";
        aiMsg.style.color = "#f53f3f";
        setTimeout(() => { aiMsg.innerText = ""; }, 4000);
    } finally {
        btn.disabled = false;
        btn.innerText = "🤖 AI智能解析并回填表单";
    }
}

async function delRecord(id){
    if(!hasPermission("knowledge.delete")) return showTopMsg("无权限", "error");
    if (!await showConfirm("确定放入回收站吗？")) return;
    try {
        let res = await fetch("/del",{
            method:"POST",headers:getHeaders(),
            body:JSON.stringify({id})
        });
        let d = await res.json();
        if (d.status !== "success") {
            showTopMsg(d.msg || "删除失败", "error");
            return;
        }
        showTopMsg("已移入回收站", "success");
    } catch(e) {
        showTopMsg("网络异常，删除失败", "error");
        return;
    }
    search();
}

function editRecord(id){
    if(!hasPermission("knowledge.edit")) return showTopMsg("无权限", "error");
    let r = allRecords.find(x=>x.id==id);
    document.getElementById("editId").value=r.id;
    document.getElementById("editCate").value=r.category;
    document.getElementById("editProposer").value=r.proposer || "";
    document.getElementById("editQ").value=r.question;
    document.getElementById("editA").value=r.solution;
    document.getElementById("editR").value=r.remark;
    openModal('editModal');
    loadAttachments(id);
}

async function saveEdit(){
    let id = document.getElementById("editId").value;
    let category = document.getElementById("editCate").value;
    let proposer = document.getElementById("editProposer").value.trim();
    let question = document.getElementById("editQ").value;
    let solution = document.getElementById("editA").value;
    let remark = document.getElementById("editR").value;
    await fetch("/edit",{
        method:"POST",headers:getHeaders(),
        body:JSON.stringify({id, proposer, cate:category, question,solution,remark})
    });
    closeModal('editModal');
    search();
    showMsg("修改成功");
}

// AI 辅助编辑
async function aiEnhance() {
    var question = document.getElementById("editQ").value.trim();
    var solution = document.getElementById("editA").value.trim();
    var remark = document.getElementById("editR").value.trim();
    if (!question && !solution) {
        showTopMsg("请先填写标题或核心内容", "error");
        return;
    }
    var btn = document.getElementById("aiEnhanceBtn");
    btn.disabled = true; btn.textContent = '⏳ AI优化中...';
    try {
        var resp = await fetch("/api/ai_enhance", {
            method: "POST", headers: getHeaders(),
            body: JSON.stringify({ question: question, solution: solution, remark: remark })
        });
        var data = await resp.json();
        if (data.status === "success") {
            document.getElementById("editQ").value = data.data.title;
            document.getElementById("editA").value = data.data.content;
            if (data.data.remark) document.getElementById("editR").value = data.data.remark;
            showTopMsg("✨ AI优化完成：" + (data.data.reason || ""), "success");
        } else {
            showTopMsg("❌ " + (data.msg || "优化失败"), "error");
        }
    } catch(e) {
        showTopMsg("❌ AI优化失败：" + e.message, "error");
    }
    btn.disabled = false; btn.textContent = '✨ AI优化';
}

function openModal(id){document.getElementById(id).style.display="block";}
function closeModal(id){
    document.getElementById(id).style.display="none";
    
    // ========================
    // 修复：关闭分类弹窗时，重新加载真实分类（取消操作生效）
    // ========================
    if(id === 'cateModal'){
        fetch("/get_cate", { method: "GET", headers: getHeaders() })
        .then(res => res.json())
        .then(data => {
            cateOptions = data;
        });
    }

    // 关闭修改密码弹窗时清空输入框
    if(id === 'selfPwdModal'){
        document.getElementById("self_oldPwd").value = "";
        document.getElementById("self_newPwd").value = "";
        document.getElementById("self_confirmPwd").value = "";
        document.getElementById("selfPwdErr").innerText = "";
    }
}

function openCateModal(){
    if(!hasPermission("category.manage")) return showTopMsg("无权限", "error");
    let box = document.getElementById("cateList");
    box.innerHTML = "";
    cateOptions.forEach((c,i)=>{
        let html = `
        <div class="cate-item">
            <span class="cate-serial">${i+1}</span>
            <button class="btn btn-sm cate-btn" onclick="moveUp(${i})">↑</button>
            <button class="btn btn-sm cate-btn" onclick="moveDown(${i})">↓</button>
            <button class="btn btn-sm cate-btn-wide" onclick="moveToPrompt(${i})" title="移动到指定位置">定位</button>`;
        if(c === '默认分类'){
            html += '<span class="cate-name" data-name="默认分类" style="padding:6px 8px;color:#999;font-style:italic;">默认分类（不可编辑/删除）</span>';
        } else {
            html += '<input value="'+escapeHtml(c)+'" onchange="updateCate('+i+',this.value)"><button class="btn btn-sm btn-del cate-btn" onclick="delCate('+i+')">删除</button>';
        }
        html += '</div>';
        box.innerHTML += html;
    });
    openModal('cateModal');
}

function updateCate(i,v){ cateOptions[i] = v.trim(); }
function addCateItem(){
    let arr = [];
    let inputs = document.querySelectorAll('.cate-item input');
    for(let inp of inputs){ arr.push(inp.value.trim()); }
    if(arr.length > 0 && arr[arr.length-1] === ""){ showCateTip("请先填写完上一个分类"); return; }
    // 检查最后一项是否与已有分类重复
    if(arr.length > 0) {
        let last = arr[arr.length-1];
        let dupIdx = arr.slice(0, -1).findIndex(x => x === last);
        if(dupIdx !== -1) {
            showCateTip(`分类「${last}」已存在，不能重复添加`);
            return;
        }
    }
    cateOptions.push("");
    openCateModal();
    // 滚动到列表底部
    setTimeout(() => {
        let container = document.querySelector('.cate-list-container');
        if(container) container.scrollTop = container.scrollHeight;
    }, 50);
}
function delCate(i){ cateOptions.splice(i,1); openCateModal(); }
function moveUp(i){if(i===0)return;[cateOptions[i],cateOptions[i-1]]=[cateOptions[i-1],cateOptions[i]];openCateModal();}
function moveDown(i){if(i===cateOptions.length-1)return;[cateOptions[i],cateOptions[i+1]]=[cateOptions[i+1],cateOptions[i]];openCateModal();}
let moveFromIndex = -1;
function moveToPrompt(i){
    moveFromIndex = i;
    document.getElementById("posModalInfo").innerText = `将「${cateOptions[i]}」移到第几位？（1 ~ ${cateOptions.length}）`;
    document.getElementById("posInput").value = "";
    document.getElementById("posInput").min = 1;
    document.getElementById("posInput").max = cateOptions.length;
    document.getElementById("posInput").placeholder = `1 ~ ${cateOptions.length}`;
    openModal('posModal');
    setTimeout(() => document.getElementById("posInput").focus(), 100);
}
function confirmMovePos(){
    let i = moveFromIndex;
    if(i === -1) return;
    let pos = document.getElementById("posInput").value.trim();
    if(!pos){ showCateTip("请输入目标位置"); return; }
    let target = parseInt(pos);
    if(isNaN(target) || target < 1 || target > cateOptions.length){ showCateTip("位置无效"); return; }
    let t = cateOptions.splice(i,1)[0];
    cateOptions.splice(target-1, 0, t);
    closeModal('posModal');
    moveFromIndex = -1;
    openCateModal();
}

async function saveCateConfig() {
    let arr = [];
    let items = document.querySelectorAll('.cate-item');
    for (let item of items) {
        let inp = item.querySelector('input');
        if (inp) {
            arr.push(inp.value.trim());
        } else {
            let sp = item.querySelector('span.cate-name');
            if (sp) arr.push((sp.dataset.name || sp.textContent).trim());
        }
    }
    if (arr.some(item => item === "")) {
        showCateTip("分类不允许为空");
        return;
    }

    // ==============================================
    // 【新增】检查是否包含重复分类
    // ==============================================
    let seen = {};
    for (let name of arr) {
        if (seen[name]) {
            showCateTip(`分类「${name}」已存在，请修改后再保存`);
            return;
        }
        seen[name] = true;
    }

    cateOptions = arr;
    let res = await fetch("/save_cate", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ list: cateOptions })
    });
    let d = await res.json();
    if (d.status === "success") {
        reloadCateSelect();
        closeModal('cateModal');
        showMsg("保存成功");
    } else {
        showTopMsg(d.msg || "保存失败", "error");
    }
}

async function openRecycleModal(){
    if(!hasPermission("recycle.view")) return;
    // 有缓存直接用（秒开），同时后台刷新
    if (recycleCache) {
        renderRecycleList(recycleCache);
    } else {
        document.getElementById("recycleList").innerHTML = '<div style="text-align:center;padding:40px;color:#999;">⏳ 加载中...</div>';
        document.getElementById("recycleCount").innerText = "加载中...";
    }
    openModal('recycleModal');
    // 后台刷新缓存
    try {
        let res = await fetch("/get_recycle",{method:"POST",headers:getHeaders()});
        let list = await res.json();
        recycleCache = list;
        renderRecycleList(list);
    } catch(e) {}
}

function renderRecycleList(list) {
    let html = "";
    if(list.length===0) {
        html=`<div class="empty-box"><div class="empty-icon">🗑️</div><div class="empty-text">回收站为空</div></div>`;
    } else {
        list.forEach(x=>{
            html+=`
            <div class="recycle-item">
               <div class="recycle-item-id">ID:${x.id} · ${x.record_time}</div>
                <div class="recycle-item-title">【${escapeHtml(x.category)}】${escapeHtml(x.question)}</div>
                <div class="recycle-btn-group">
                    ${hasPermission("recycle.restore") ? `<button class="restore-btn" onclick="restoreRecord(${x.id})">恢复</button>` : ''}
                    ${hasPermission("knowledge.permanent_del") ? `<button class="permanent-del-btn" onclick="permanentDelRecord(${x.id})">永久删除</button>` : ''}
                </div>
            </div>`;
        });
    }
    document.getElementById("recycleList").innerHTML=html;
    document.getElementById("recycleCount").innerText = `共 ${list.length} 条记录`;
}

async function restoreRecord(id){
    await fetch("/restore_recycle",{method:"POST",headers:getHeaders(),body:JSON.stringify({id})});
    openRecycleModal();search();
}

async function permanentDelRecord(id){
    // 只有拥有永久删除权限才能操作
    if(!hasPermission("knowledge.permanent_del")) {
        showTopMsg("无权限：您没有永久删除的权限", "error");
        return;
    }
    if (!await showConfirm("永久删除不可恢复！确定？", true)) return;
    await fetch("/delete_permanent",{method:"POST",headers:getHeaders(),body:JSON.stringify({id})});
    openRecycleModal();search();
}

// 搜索建议
const searchInput = document.getElementById("searchKey");
const suggestBox = document.getElementById("suggestBox");
let suggestTimer = null;
searchInput.addEventListener("input", function () {
    const q = this.value.trim();
    clearTimeout(suggestTimer);
    if (!q || q.length < 1) {
        suggestBox.style.display = "none";
        return;
    }
    suggestTimer = setTimeout(() => {
        fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { headers:getHeaders() })
            .then(res => res.json())
            .then(list => {
                suggestBox.innerHTML = "";
                if (list.length === 0) {
                    suggestBox.style.display = "none";
                    return;
                }
                list.forEach(item => {
                    const div = document.createElement("div");
                    div.className = "suggest-item";
                    div.textContent = item.question;
                    div.onclick = () => {
                        searchInput.value = item.question;
                        suggestBox.style.display = "none";
                        logSearchHistory(item.question);
                        currentPage = 1;
                        // 直接搜索ID，避免换行符等特殊字符导致搜索失败
                        fetch("/search", {
                            method: "POST",
                            headers: getHeaders(),
                            body: JSON.stringify({keyword: String(item.id), cate: "全部", startDate: "", endDate: "", page: 1, pageSize: pageSize})
                        }).then(res => res.json()).then(data => {
                            allRecords = data.records || [];
                            totalRecords = data.total || 0;
                            renderListByPage();
                            renderPagination();
                            refreshStat(); loadDashboard();
                            refreshSearchClearBtn();
                        });
                    };
                    suggestBox.appendChild(div);
                });
                suggestBox.style.display = "block";
            });
    }, 300);
});
document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !suggestBox.contains(e.target)) {
        suggestBox.style.display = "none";
    }
});

function logSearchHistory(keyword) {
    if (!keyword) return;
    fetch("/api/log_search", {
        method: "POST", headers:getHeaders(),
        body: JSON.stringify({ keyword })
    });
}

function clearDateRange() {
    document.getElementById("startDate").value = "";
    document.getElementById("endDate").value = "";
    currentPage = 1;
    search();
}
function setCurrentMonthDate() {
    document.getElementById("startDate").value = "";
    document.getElementById("endDate").value = "";
}

// 附件
function chooseEditFile(){ document.getElementById("editFileInput").click(); }
function fadeAttachTip(tipEl, delay = 2000) {
    setTimeout(() => {
        tipEl.style.opacity = "0";
        setTimeout(() => { tipEl.innerText = ""; tipEl.style.opacity = "1"; }, 1000);
    }, delay);
}
function doEditUpload(e){
    const file = e.target.files[0];
    if (!file) return;
    const tip = document.getElementById("editAttachTip");
    tip.innerText = "准备上传...";
    const fd = new FormData();
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload", true);
    xhr.setRequestHeader("token", getToken());
    xhr.upload.onprogress = function(e){
        if (e.lengthComputable) {
            const percent = Math.floor((e.loaded / e.total) * 100);
            tip.innerText = `上传中：${percent}%`;
        }
    };
    xhr.onload = function(){
        if (xhr.status === 200) {
            const d = JSON.parse(xhr.responseText);
            if (d.status === "success") {
                tip.innerText = "✅ 上传成功：" + d.origin_name;
                afterUploadSuccess(d.origin_name, d.save_name, d.file_ext);
            } else {
                tip.innerText = "❌ 上传失败";
            }
        } else {
            tip.innerText = "❌ 上传异常";
        }
        fadeAttachTip(tip);
    };
    xhr.send(fd);
    e.target.value = "";
}

let currentEditKnowledgeId = null;
function loadAttachments(knowledgeId) {
    currentEditKnowledgeId = knowledgeId;
    let list = document.getElementById("attachmentList");
    list.innerHTML = "";
    fetch("/get_attachments?knowledge_id=" + knowledgeId, { headers:getHeaders() })
    .then(res => res.json())
    .then(data => {
        data.forEach(att => {
            let item = document.createElement("div");
            item.style.display = "flex";
            item.style.alignItems = "center";
            let a = document.createElement("a");
            a.href = "javascript:void(0)";
            a.onclick = () => {
                // 带 token 请求头下载（解决 401 授权问题）
                fetch(`/download/${att.save_name}?noCache=${Date.now()}`, {
                    method: 'GET',
                    headers: {
                        "token": getToken()
                    }
                })
                .then(res => {
                    if (!res.ok) throw new Error('下载失败，请检查权限');
                    return res.blob();
                })
                .then(blob => {
                    let url = window.URL.createObjectURL(blob);
                    let link = document.createElement('a');
                    link.href = url;
                    link.download = att.origin_name;
                    link.click();
                    window.URL.revokeObjectURL(url);
                })
                .catch(err => {
                    showTopMsg(err.message, "error");
                });
            };
            a.style.color = "#165DFF";
            a.style.cursor = "pointer";
            a.innerText = "📎 " + att.origin_name;
            let delBtn = document.createElement("span");
            delBtn.innerText = "✕";
            delBtn.style.color = "#f53f3f";
            delBtn.style.marginLeft = "8px";
            delBtn.onclick = () => deleteAttachment(att.id);
            delBtn.classList.add("attach-del");
            item.appendChild(a);
            item.appendChild(delBtn);
            list.appendChild(item);
        });
    });
}

async function deleteAttachment(attachId) {
    if (!await showConfirm("确定删除？", true)) return;
    fetch("/del_attachment", {
        method: "POST", headers:getHeaders(),
        body: JSON.stringify({ id: attachId })
    }).then(res => res.json()).then(data => {
        if (data.status === "success") loadAttachments(currentEditKnowledgeId);
    });
}

// 查看附件（支持预览和下载）
function viewAttachments(knowledgeId) {
    let list = document.getElementById("attachViewerList");
    list.innerHTML = "";
    closePreview();
    document.getElementById("attachViewerOverlay").style.display = "flex";
    fetch("/get_attachments?knowledge_id=" + knowledgeId, { headers:getHeaders() })
    .then(res => res.json())
    .then(data => {
        if (data.length === 0) {
            list.innerHTML = '<div class="empty-attach">暂无附件</div>';
            return;
        }
        data.forEach(att => {
            let ext = (att.file_ext || "").toLowerCase();
            let item = document.createElement("div");
            item.className = "attach-file";

            let name = document.createElement("span");
            name.className = "file-name";
            name.innerHTML = `<span class="ext-tag">${ext}</span>${escapeHtml(att.origin_name)}`;
            
            let supportPreview = ["png","jpg","jpeg","gif","txt","html","htm","pdf"].includes(ext);
            
            if (supportPreview) {
                let previewBtn = document.createElement("button");
                previewBtn.className = "btn-preview";
                previewBtn.innerText = "预览";
                previewBtn.onclick = () => previewFile(att);
                item.appendChild(name);
                item.appendChild(previewBtn);
            } else {
                item.appendChild(name);
            }

            let downloadBtn = document.createElement("button");
            downloadBtn.className = "btn-download";
            downloadBtn.innerText = "下载";
            downloadBtn.onclick = () => downloadFile(att);
            item.appendChild(downloadBtn);

            list.appendChild(item);
        });
    });
}

function downloadFile(att) {
    fetch(`/download/${att.save_name}?noCache=${Date.now()}`, {
        method: 'GET',
        headers: { "token": getToken() }
    })
    .then(res => {
        if (!res.ok) throw new Error('下载失败');
        return res.blob();
    })
    .then(blob => {
        let url = window.URL.createObjectURL(blob);
        let link = document.createElement('a');
        link.href = url;
        link.download = att.origin_name;
        link.click();
        window.URL.revokeObjectURL(url);
    })
    .catch(err => {
        showTopMsg(err.message || "下载失败", "error");
    });
}

function previewFile(att) {
    let ext = (att.file_ext || "").toLowerCase();
    let area = document.getElementById("attachPreviewArea");
    let content = document.getElementById("previewContent");
    let fileName = document.getElementById("previewFileName");

    area.style.display = "block";
    fileName.innerText = "📖 " + att.origin_name;
    content.innerHTML = '<div style="color:#999;padding:20px 0;">⏳ 加载中...</div>';

    if (["png","jpg","jpeg","gif"].includes(ext)) {
        // 图片预览
        let img = `<img src="/upload/${att.save_name}" style="max-width:100%;max-height:380px;border-radius:6px;" onerror="imgLoadError(this)">`;
        content.innerHTML = img;
    } else if (["txt"].includes(ext)) {
        // 文本预览 - fetch内容显示
        fetch(`/download/${att.save_name}?noCache=${Date.now()}`, {
            headers: { "token": getToken() }
        })
        .then(res => {
            if (!res.ok) throw new Error();
            return res.text();
        })
        .then(text => {
            content.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
        })
        .catch(() => {
            content.innerHTML = '<div class="no-preview">❌ 文件加载失败</div>';
        });
    } else if (["html","htm"].includes(ext)) {
        // HTML预览 - fetch源代码显示
        fetch(`/download/${att.save_name}?noCache=${Date.now()}`, {
            headers: { "token": getToken() }
        })
        .then(res => {
            if (!res.ok) throw new Error();
            return res.text();
        })
        .then(text => {
            content.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
        })
        .catch(() => {
            content.innerHTML = '<div class="no-preview">❌ 文件加载失败</div>';
        });
    } else if (["pdf"].includes(ext)) {
        // PDF - 用iframe嵌入
        content.innerHTML = `<iframe src="/upload/${att.save_name}" style="width:100%;height:380px;border:none;border-radius:6px;"></iframe>`;
    } else {
        content.innerHTML = '<div class="no-preview">❌ 不支持此格式预览</div>';
    }
}

function closePreview() {
    let area = document.getElementById("attachPreviewArea");
    area.style.display = "none";
    document.getElementById("previewContent").innerHTML = "";
}

function imgLoadError(el) {
    el.outerHTML = '<div class="no-preview">❌ 图片加载失败</div>';
}

function afterUploadSuccess(origin_name, save_name, file_ext) {
    if (!currentEditKnowledgeId) return;
    const formData = new FormData();
    formData.append("knowledge_id", currentEditKnowledgeId);
    formData.append("origin_name", origin_name);
    formData.append("save_name", save_name);
    formData.append("file_ext", file_ext);
    fetch("/bind_attachment", { method: "POST", headers:{ token:getToken() }, body: formData })
    .then(res => res.json())
    .then(data => {
        if (data.status === "success") {
            loadAttachments(currentEditKnowledgeId);
        } else {
            showTopMsg("附件绑定失败：" + (data.msg || "未知错误"), "error");
        }
    }).catch(e => {
        showTopMsg("附件绑定网络异常", "error");
    });
}

// 重置密码（自己）
function openResetModal(){
    document.getElementById("resetModal").style.display = "block";
}
function closeResetModal(){
    document.getElementById("resetModal").style.display = "none";
}
function submitResetPwd(){
    let newPwd = document.getElementById("newPwd").value.trim();
    let confirmPwd = document.getElementById("confirmPwd").value.trim();
    let errDom = document.getElementById("resetErr");
    if(!newPwd || newPwd.length < 6){ errDom.innerText = "密码至少6位"; return; }
    if(newPwd !== confirmPwd){ errDom.innerText = "两次密码不一致"; return; }
    fetch("/reset_pwd", {
        method: "POST", headers:getHeaders(),
        body: JSON.stringify({ new_pwd: newPwd })
    }).then(res => res.json()).then(data => {
        if(data.status === "success"){
            showTopMsg("密码修改成功", "success");
            closeResetModal();
        }else{
            errDom.innerText = data.msg || "失败";
        }
    });
}

// 自己修改密码（最终完美修复版，解决弹窗残留+记住账号）
function changeSelfPwd() {
    let old = document.getElementById("self_oldPwd").value.trim();
    let p1 = document.getElementById("self_newPwd").value.trim();
    let p2 = document.getElementById("self_confirmPwd").value.trim();
    let err = document.getElementById("selfPwdErr");
    
    err.innerText = "";

    if (!old || !p1 || !p2) {
        err.innerText = "请填写完整";
        return;
    }
    if (p1.length < 6) {
        err.innerText = "新密码至少6位";
        return;
    }
    if (p1 !== p2) {
        err.innerText = "两次密码不一致";
        return;
    }

    // 校验原密码
    fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: currentUsername, password: old })
    }).then(res => res.json()).then(d => {
        if (d.status === "error") {
            err.innerText = "原密码错误";
            return;
        }
        // 修改密码
        fetch("/reset_pwd", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({ new_pwd: p1 })
        }).then(res => res.json()).then(ret => {
            if (ret.status === "success") {
                // 1. 关闭弹窗
                closeModal('selfPwdModal');
                showMsg("密码修改成功，请重新登录");
                // 2. 清登录状态
                localStorage.removeItem("kb_token");
                localStorage.removeItem("kb_username");
                localStorage.removeItem("kb_role");
                localStorage.removeItem("kb_role_id");
                localStorage.removeItem("kb_permissions");
                localStorage.removeItem("kb_role_label");
                localStorage.removeItem("kb_is_super");
                // 3. 清空密码栏 + 去除勾选记住密码
                document.getElementById("pwd").value = "";
                document.getElementById("rememberPwd").checked = false;
                localStorage.removeItem("kb_save_pwd");
                localStorage.setItem("kb_remember_pwd", "0");
                goLogin();
            } else {
                err.innerText = ret.msg || "修改失败";
            }
        })
    }).catch(() => {
        err.innerText = "网络异常";
    });
}

// ===================== 智能搜索助手 =====================
let aiHelperSearching = false;
let aiHelperLastQ = "";
function toggleAiHelper() {
    let body = document.body;
    if (body.classList.contains("ai-helper-open")) {
        closeAiHelper();
    } else {
        body.classList.add("ai-helper-open");
        document.getElementById("aiHelperInput").focus();
        let val = document.getElementById("aiHelperInput").value.trim();
        if (val) doAiHelperSearchDb(val);
    }
}
function closeAiHelper() {
    document.body.classList.remove("ai-helper-open");
}
function clearAiHelperInput() {
    let input = document.getElementById("aiHelperInput");
    input.value = "";
    aiHelperLastQ = "";
    document.getElementById("aiHelperClearBtn").style.display = "none";
    document.getElementById("helperAnswer").style.display = "none";
    document.getElementById("helperAnswer").innerHTML = "";
    document.getElementById("helperRecordsLabel").style.display = "none";
    document.getElementById("helperRecords").innerHTML = '<div class="panel-tip">💬 试试问我<br>「某某在哪个部门」<br>「报销审批流程是什么」<br>「会议室怎么预约」<br>「ERP账号怎么申请」<br>「公司有哪些IT系统」</div>';
    document.getElementById("helperAiThinking").style.display = "none";
    document.getElementById("aiHelperStatus").innerText = "";
    input.focus();
}
let aiHelperDebounceTimer = null;
document.addEventListener("DOMContentLoaded", function() {
    const input = document.getElementById("aiHelperInput");
    if (!input) return;
    input.addEventListener("input", function() {
        const q = this.value.trim();
        aiHelperLastQ = q;
        document.getElementById("aiHelperClearBtn").style.display = q ? "flex" : "none";
        if (!q) {
            document.getElementById("helperAnswer").style.display = "none";
            document.getElementById("helperRecordsLabel").style.display = "none";
            document.getElementById("helperRecords").innerHTML = '<div class="panel-tip">💬 试试问我<br>「某某在哪个部门」<br>「报销审批流程是什么」<br>「会议室怎么预约」<br>「ERP账号怎么申请」<br>「公司有哪些IT系统」</div>';
            document.getElementById("helperAiThinking").style.display = "none";
            document.getElementById("aiHelperStatus").innerText = "";
            return;
        }
        // 输入时只做数据库搜索（实时显示匹配记录），不做 AI 调用
        clearTimeout(aiHelperDebounceTimer);
        aiHelperDebounceTimer = setTimeout(() => {
            if (!aiHelperSearching) doAiHelperSearchDb(q);
        }, 200);
    });
    input.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
            clearTimeout(aiHelperDebounceTimer);
            // 强行解锁，避免被防抖触发的DB搜索占住锁导致AI搜索跳过
            aiHelperSearching = false;
            document.getElementById("helperRecords").scrollTop = 0;
            doAiHelperSearch(this.value.trim());
        }
    });
});
// 仅数据库搜索（输入时触发，不做 AI 调用）
async function doAiHelperSearchDb(keyword) {
    if (aiHelperSearching) return;
    aiHelperSearching = true;
    let recordsEl = document.getElementById("helperRecords");
    let statusEl = document.getElementById("aiHelperStatus");
    statusEl.innerText = "⏳ 搜索中...";

    try {
        let res = await fetch("/search", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({keyword, cate: "全部", startDate: "", endDate: "", page: 1, pageSize: 30})
        });
        let data = await res.json();
        let list = data.records || [];

        if (list.length === 0) {
            recordsEl.innerHTML = '<div class="panel-tip">😕 未找到相关内容<br>试试换其他问法</div>';
            statusEl.innerText = "共 0 条结果";
        } else {
            let html = "";
            list.forEach((item, idx) => {
                let snippet = (item.solution || item.remark || "").substring(0, 80);
                let seq = idx + 1;
                html += `
                <div class="helper-item" onclick="jumpToSearch(${item.id})">
                    <div class="hi-cate">${escapeHtml(item.category)}</div>
                    <div class="hi-title">${escapeHtml(item.question)}</div>
                    <div class="hi-snippet">${escapeHtml(snippet)}${snippet.length >= 80 ? '...' : ''}</div>
                    <div class="hi-id">ID: ${item.id} <span class="hi-index">#${seq}</span></div>
                </div>`;
            });
            recordsEl.innerHTML = html;
            statusEl.innerText = `共 ${data.total || list.length} 条结果`;
        }
    } catch(e) {
        recordsEl.innerHTML = '<div class="panel-tip">⚠️ 搜索异常</div>';
        statusEl.innerText = "搜索失败";
    }

    aiHelperSearching = false;
}

// 数据库搜索 + AI 智能问答（按回车时触发）
async function doAiHelperSearch(keyword) {
    if (aiHelperSearching) return;
    aiHelperSearching = true;
    let answerEl = document.getElementById("helperAnswer");
    let recordsEl = document.getElementById("helperRecords");
    let statusEl = document.getElementById("aiHelperStatus");
    let labelEl = document.getElementById("helperRecordsLabel");
    answerEl.style.display = "none";
    labelEl.style.display = "none";
    statusEl.innerText = "⏳ 搜索中...";
    // 立即显示"AI思考中"（不等DB搜索完成）
    document.getElementById("helperAiThinking").style.display = "block";

    try {
        let res = await fetch("/search", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({keyword, cate: "全部", startDate: "", endDate: "", page: 1, pageSize: 30})
        });
        let data = await res.json();
        let list = data.records || [];

        if (list.length === 0) {
            recordsEl.innerHTML = '<div class="panel-tip">😕 未找到相关内容<br>试试换其他问法</div>';
            statusEl.innerText = "共 0 条结果";
        } else {
            let html = "";
            list.forEach((item, idx) => {
                let snippet = (item.solution || item.remark || "").substring(0, 80);
                let seq = idx + 1;
                html += `
                <div class="helper-item" onclick="jumpToSearch(${item.id})">
                    <div class="hi-cate">${escapeHtml(item.category)}</div>
                    <div class="hi-title">${escapeHtml(item.question)}</div>
                    <div class="hi-snippet">${escapeHtml(snippet)}${snippet.length >= 80 ? '...' : ''}</div>
                    <div class="hi-id">ID: ${item.id} <span class="hi-index">#${seq}</span></div>
                </div>`;
            });
            recordsEl.innerHTML = html;
            statusEl.innerText = `共 ${data.total || list.length} 条结果`;
        }
    } catch(e) {
        recordsEl.innerHTML = '<div class="panel-tip">⚠️ 搜索异常</div>';
        statusEl.innerText = "搜索失败";
    }

    // 第二步：调 AI 做智能问答（仅回车触发时才到这里）
    try {
        let res2 = await fetch("/api/semantic_search", {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify({keyword})
        });
        let data2 = await res2.json();

        // 用语义搜索返回的排序结果（加权评分排序）更新参考记录列表
        if (data2.records && data2.records.length > 0) {
            let html = "";
            data2.records.forEach((item, idx) => {
                let snippet = (item.solution || item.remark || "").substring(0, 80);
                let seq = idx + 1;
                html += `
                <div class="helper-item" onclick="jumpToSearch(${item.id})">
                    <div class="hi-cate">${escapeHtml(item.category)}</div>
                    <div class="hi-title">${escapeHtml(item.question)}</div>
                    <div class="hi-snippet">${escapeHtml(snippet)}${snippet.length >= 80 ? '...' : ''}</div>
                    <div class="hi-id">ID: ${item.id} <span class="hi-index">#${seq}</span></div>
                </div>`;
            });
            recordsEl.innerHTML = html;
            statusEl.innerText = `共 ${data2.total || data2.records.length} 条结果`;
        }

        if (data2.answer) {
            answerEl.style.display = "block";
            // 构建 [n] → 记录ID 的映射（取前12条，和传给AI的一致）
            let refMap = {};
            let recordsForRef = data2.records || [];
            for (let i = 0; i < Math.min(recordsForRef.length, 12); i++) {
                refMap[i + 1] = recordsForRef[i].id;
            }
            // 把 [n] 替换为可点击链接，点击跳转到对应记录
            let answerHtml = data2.answer.replace(/\n/g, '<br>');
            answerHtml = answerHtml.replace(/\[(\d+)\]/g, (match, num) => {
                let id = refMap[parseInt(num)];
                if (id) {
                    return `<a href="#" onclick="jumpToSearch(${id});return false;" style="color:#165DFF;font-weight:bold;text-decoration:underline;">[${num}]</a>`;
                }
                return match;
            });
            // 去掉引用序号前连续的 <br>，防止竖向排列
            answerHtml = answerHtml.replace(/(?:<br>\s*)+(?=<a\s)/gi, ' ');
            answerEl.innerHTML = answerHtml;
            labelEl.style.display = "block";
        }
        // AI回答为空时：保持第一步查到的记录，不覆盖也不清空
    } catch(e) {
        // AI失败不影响已有结果
    }
    document.getElementById("helperAiThinking").style.display = "none";

    aiHelperSearching = false;
}
function jumpToSearch(id) {
    // 按ID搜索，直接定位到该记录
    document.getElementById("searchKey").value = String(id);
    currentPage = 1;
    search();
    closeAiHelper();
}

// ===================== 数据权限管理 =====================
let dpUsersCache = [];       // 缓存用户列表
let dpOtherSubmitters = [];  // 缓存"其他"创建人列表
let dpSelectedUserId = null;  // 当前选中的用户ID

function loadDataPermStatus() {
    fetch("/api/data_perm/status", { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            if (data.status === "success") {
                updateDataPermUI(data.enabled);
            }
        })
        .catch(() => {});
}

function updateDataPermUI(enabled) {
    const sw = document.getElementById("dataPermSwitch");
    const st = document.getElementById("dataPermStatus");
    const mgrWrap = document.getElementById("dataPermMgrWrap");
    if (enabled) {
        sw.classList.add("on");
        st.innerText = "按创建人隔离知识记录 · 已开启";
        if (mgrWrap) mgrWrap.style.display = "";
    } else {
        sw.classList.remove("on");
        st.innerText = "按创建人隔离知识记录 · 已关闭";
        if (mgrWrap) mgrWrap.style.display = "none";
    }
}

function toggleDataPerm() {
    const sw = document.getElementById("dataPermSwitch");
    const isOn = sw.classList.contains("on");
    const newVal = !isOn;
    fetch("/api/data_perm/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getHeaders() },
        body: JSON.stringify({ enabled: newVal })
    })
        .then(r => r.json())
        .then(data => {
            if (data.status === "success") {
                updateDataPermUI(data.enabled);
                showTopMsg(data.enabled ? "数据权限已开启" : "数据权限已关闭", "success");
                // 刷新知识列表
                search();
            } else {
                showTopMsg(data.msg || "操作失败", "error");
            }
        })
        .catch(() => showTopMsg("网络异常", "error"));
}

function openDataPermModal() {
    // 加载授权矩阵
    fetch("/api/data_perm/grants", { headers: getHeaders() })
        .then(r => r.json())
        .then(data => {
            if (data.status === "success") {
                dpUsersCache = data.users || [];
                dpOtherSubmitters = data.other_submitters || [];
                dpSelectedUserId = null;
                renderDpUserList();
                renderDpGrantPanel();
                openModal("dataPermModal");
            }
        })
        .catch(() => showTopMsg("加载授权数据失败", "error"));
}

function renderDpUserList() {
    const container = document.getElementById("dpUserList");
    if (!container) return;
    if (dpUsersCache.length === 0) {
        container.innerHTML = '<div style="color:#999;text-align:center;margin-top:20px;">暂无普通用户</div>';
        return;
    }
    let html = '';
    for (const u of dpUsersCache) {
        const isActive = dpSelectedUserId === u.id;
        const badge = u.granted.length > 0 ? `<span class="dp-user-badge">${u.granted.length}人</span>` : '';
        html += `<div class="dp-user-item ${isActive ? 'active' : ''}" onclick="selectDpUser(${u.id})">
            <span class="dp-user-name">${u.username}</span>
            ${badge}
        </div>`;
    }
    container.innerHTML = html;
}

function selectDpUser(userId) {
    dpSelectedUserId = userId;
    renderDpUserList();
    renderDpGrantPanel();
}

function renderDpGrantPanel() {
    const panel = document.getElementById("dpGrantPanel");
    if (!panel) return;
    if (!dpSelectedUserId) {
        panel.innerHTML = '<div style="color:#999;text-align:center;margin-top:60px;">← 请选择左侧用户进行授权</div>';
        return;
    }
    // 找到当前选中的用户
    const currentUser = dpUsersCache.find(u => u.id === dpSelectedUserId);
    if (!currentUser) return;

    const grantedSet = new Set(currentUser.granted || []);
    const grantedUsernameSet = new Set(currentUser.granted_usernames || []);

    let html = `<div style="font-size:13px;color:#555;margin-bottom:10px;">
        <strong>${currentUser.username}</strong> 可查看以下创建人的知识：
    </div>`;

    // 普通用户列表
    for (const u of dpUsersCache) {
        const isSelf = u.id === dpSelectedUserId;
        const checked = grantedSet.has(u.id) ? "checked" : "";
        if (isSelf) {
            // 自己始终可见，不可取消
            html += `<div class="dp-grant-item" style="opacity:0.5;">
                <input type="checkbox" checked disabled>
                <label>${u.username} <span style="font-size:11px;color:#86909c;">（自己，始终可见）</span></label>
            </div>`;
        } else {
            html += `<div class="dp-grant-item">
                <input type="checkbox" id="dpCb_${u.id}" ${checked}>
                <label for="dpCb_${u.id}">${u.username}</label>
            </div>`;
        }
    }

    // "其他"分组
    if (dpOtherSubmitters.length > 0) {
        html += `<div style="font-size:12px;color:#86909c;margin:12px 0 6px;padding-top:8px;border-top:1px dashed #e5e6eb;">其他创建人</div>`;
        for (const name of dpOtherSubmitters) {
            const safeId = "dpCbO_" + name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");
            const checked = grantedUsernameSet.has(name) ? "checked" : "";
            html += `<div class="dp-grant-item">
                <input type="checkbox" id="${safeId}" data-username="${name}" ${checked}>
                <label for="${safeId}">${name}</label>
            </div>`;
        }
    }
    panel.innerHTML = html;
}

function saveDataPermGrant() {
    if (!dpSelectedUserId) {
        showTopMsg("请先选择一个用户", "info");
        return;
    }
    // 收集勾选的普通用户创建人ID（排除自己）
    const grantedIds = [];
    for (const u of dpUsersCache) {
        if (u.id === dpSelectedUserId) continue; // 跳过自己
        const cb = document.getElementById("dpCb_" + u.id);
        if (cb && cb.checked) {
            grantedIds.push(u.id);
        }
    }
    // 收集勾选的"其他"创建人 username
    const grantedUsernames = [];
    document.querySelectorAll("#dpGrantPanel input[data-username]:checked").forEach(cb => {
        grantedUsernames.push(cb.getAttribute("data-username"));
    });
    fetch("/api/data_perm/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getHeaders() },
        body: JSON.stringify({ user_id: dpSelectedUserId, granted_ids: grantedIds, granted_usernames: grantedUsernames })
    })
        .then(r => r.json())
        .then(data => {
            if (data.status === "success") {
                showTopMsg("授权已保存", "success");
                // 刷新缓存
                openDataPermModal();
            } else {
                showTopMsg(data.msg || "保存失败", "error");
            }
        })
        .catch(() => showTopMsg("网络异常", "error"));
}

// ===================== 自定义日历面板 =====================
let calActiveInput = null;
let calActiveId = null;
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

function openCalendar(inputEl, inputId) {
    closeCalendar();
    calActiveInput = inputEl;
    calActiveId = inputId;
    
    let val = inputEl.value.trim();
    if (val) {
        let parts = val.split('-');
        calYear = parseInt(parts[0]);
        calMonth = parseInt(parts[1]) - 1;
    } else {
        let now = new Date();
        calYear = now.getFullYear();
        calMonth = now.getMonth();
    }
    
    renderCalendar();
    
    let panel = document.getElementById('datePickerPanel');
    let rect = inputEl.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = (rect.bottom + 4) + 'px';
    panel.style.left = rect.left + 'px';
    panel.style.display = 'block';
}

function closeCalendar() {
    document.getElementById('datePickerPanel').style.display = 'none';
}

function renderCalendar() {
    let title = document.getElementById('calTitle');
    title.innerText = calYear + '年' + (calMonth + 1) + '月';
    
    let grid = document.getElementById('calDays');
    grid.innerHTML = '';
    
    let firstDay = new Date(calYear, calMonth, 1).getDay();
    let daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    let daysInPrev = new Date(calYear, calMonth, 0).getDate();
    let today = new Date();
    let todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
    
    let selectedVal = calActiveInput ? calActiveInput.value.trim() : '';
    
    // Previous month days
    for (let i = firstDay - 1; i >= 0; i--) {
        let d = daysInPrev - i;
        let span = document.createElement('span');
        span.className = 'day other';
        span.innerText = d;
        let py = calMonth === 0 ? calYear - 1 : calYear;
        let pm = calMonth === 0 ? 11 : calMonth - 1;
        span.onclick = (function(y,m,day){return function(){selectDate(y,m,day);}})(py, pm, d);
        grid.appendChild(span);
    }
    
    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
        let dateStr = calYear + '-' + String(calMonth+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
        let span = document.createElement('span');
        span.className = 'day';
        if (dateStr === todayStr) span.classList.add('today');
        if (dateStr === selectedVal) span.classList.add('selected');
        span.innerText = d;
        span.onclick = (function(y,m,day){return function(){selectDate(y,m,day);}})(calYear, calMonth, d);
        grid.appendChild(span);
    }
    
    // Next month days
    let totalCells = firstDay + daysInMonth;
    let remaining = 42 - totalCells;
    let nextMonth = calMonth + 1 > 11 ? 0 : calMonth + 1;
    let nextYear = calMonth + 1 > 11 ? calYear + 1 : calYear;
    for (let d = 1; d <= remaining; d++) {
        let span = document.createElement('span');
        span.className = 'day other';
        span.innerText = d;
        span.onclick = (function(y,m,day){return function(){selectDate(y,m,day);}})(nextYear, nextMonth, d);
        grid.appendChild(span);
    }
}

function calPrevMonth() {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
}

function calNextMonth() {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
}

function selectDate(year, month, day) {
    let dateStr = year + '-' + String(month+1).padStart(2,'0') + '-' + String(day).padStart(2,'0');
    if (calActiveInput) {
        calActiveInput.value = dateStr;
    }
    closeCalendar();
}

// Close calendar when clicking outside
document.addEventListener('click', function(e) {
    let panel = document.getElementById('datePickerPanel');
    if (panel.style.display === 'block') {
        let isPanel = panel.contains(e.target);
        let isInput = calActiveInput && calActiveInput === e.target;
        if (!isPanel && !isInput) {
            closeCalendar();
        }
    }
});

// ====== 未保存附件离开提醒 ======
window.addEventListener('beforeunload', function(e) {
    if (newUploadedFiles.length > 0) {
        e.preventDefault();
        e.returnValue = '有附件已上传但未保存，确定离开吗？';
    }
});

// ====== 全局初始化 ======
document.addEventListener('DOMContentLoaded', function() {
    // 初始化查重阈值默认值（无 localStorage 时写入 30）
    if (localStorage.getItem("dedupThreshold") === null) {
        localStorage.setItem("dedupThreshold", "30");
    }
    // 初始化查重开关默认值
    if (localStorage.getItem("dedupEnabled") === null) {
        localStorage.setItem("dedupEnabled", "true");
    }
    // 初始化查重模式默认值
    if (localStorage.getItem("dedupModes") === null) {
        localStorage.setItem("dedupModes", '["title"]');
    }
});

// ===================== 数据管理工具函数 =====================
var _toolsBackupFiles = [];
var _toolsBackupExpanded = false;

function openToolsModal() {
    document.getElementById("toolsMsg").style.display = "none";
    openModal("toolsModal");
    toolsRefreshBackupList();
    toolsRefreshIdSeq();
    // 重置日志筛选条件
    document.getElementById('logLevelFilter').value = '';
    document.getElementById('logKeywordInput').value = '';
    _logPage = 1;
    loadLogs();
}
function closeToolsModal() {
    closeModal("toolsModal");
}
function toolsShowMsg(text, type) {
    var el = document.getElementById("toolsMsg");
    el.textContent = text;
    el.className = "msg show msg-" + type;
    el.style.display = "block";
}
function toolsShowProgress(text, pct) {
    var wrap = document.getElementById("toolsProgressWrap");
    wrap.style.display = "block";
    document.getElementById("toolsProgressInner").style.width = pct + "%";
    document.getElementById("toolsProgressText").textContent = text;
}
function toolsHideProgress() {
    document.getElementById("toolsProgressWrap").style.display = "none";
}

// XLSX 库按需加载（按需加载，避免阻塞首屏）
var _xlsxLoaded = false;
function loadXLSX() {
    if (typeof XLSX !== 'undefined') { _xlsxLoaded = true; return Promise.resolve(); }
    if (_xlsxLoaded) return new Promise(function(resolve) {
        var check = setInterval(function() { if (typeof XLSX !== 'undefined') { clearInterval(check); resolve(); } }, 100);
    });
    _xlsxLoaded = true;
    return new Promise(function(resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://cdn.bootcdn.net/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = resolve;
        s.onerror = function() {
            // fallback: 尝试用 jsdelivr
            var s2 = document.createElement('script');
            s2.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
            s2.onload = resolve;
            s2.onerror = reject;
            document.head.appendChild(s2);
        };
        document.head.appendChild(s);
    });
}

// 导出 Excel
async function toolsExport() {
    toolsShowMsg("正在加载导出模块...", "info");
    try {
        await loadXLSX();
    } catch(e) {
        toolsShowMsg("❌ 导出模块加载失败，请检查网络", "error");
        return;
    }
    try {
        var data = await apiFetch("/search", {
            method: "POST",
            body: JSON.stringify({ keyword: "", cate: "全部", page: 1, pageSize: 99999 })
        });
        if (!data.records || data.records.length === 0) {
            toolsShowMsg("没有数据可导出", "info"); return;
        }
        var rows = data.records.map(function(r) {
            return { '分类': r.category||'', '标题': r.question||'', '核心内容': r.solution||'',
                '补充说明': r.remark||'', '创建人': r.submitter||'', '提出人': r.proposer||'', '记录时间': r.record_time||'' };
        });
        var wb = XLSX.utils.book_new();
        var ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{wch:12},{wch:30},{wch:40},{wch:20},{wch:12},{wch:12},{wch:22}];
        XLSX.utils.book_append_sheet(wb, ws, '知识记录');
        var now = new Date();
        var ts = now.getFullYear()+('0'+(now.getMonth()+1)).slice(-2)+('0'+now.getDate()).slice(-2)+'_'+('0'+now.getHours()).slice(-2)+('0'+now.getMinutes()).slice(-2);
        XLSX.writeFile(wb, '知识记录_导出_' + ts + '.xlsx');
        toolsShowMsg("✅ 导出成功！共 " + rows.length + " 条记录", "success");
    } catch(e) { toolsShowMsg("导出失败：" + e.message, "error"); }
}

// 导入 Excel
async function toolsImport(input) {
    var file = input.files[0];
    if (!file) return;
    toolsShowMsg("正在加载导入模块...", "info");
    try {
        await loadXLSX();
    } catch(e) {
        toolsShowMsg("❌ 导入模块加载失败，请检查网络", "error");
        input.value = '';
        return;
    }
    try {
        var buf = await file.arrayBuffer();
        var wb = XLSX.read(buf, { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rawRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        if (rawRows.length === 0) { toolsShowMsg("Excel 中没有数据", "info"); return; }
        var records = rawRows.map(function(r) {
            return {
                category: r['分类']||r['类别']||'',
                question: r['标题']||r['问题描述']||'',
                solution: r['核心内容']||r['处理方法']||'',
                remark: r['补充说明']||r['备注']||'',
                submitter: r['创建人']||'',
                proposer: r['提出人']||'',
                record_time: r['记录时间']||''
            };
        });
        var result = await apiFetch('/api/import_records', {
            method: 'POST', body: JSON.stringify({ records: records })
        });
        if (result.status === 'success') {
            toolsShowMsg("✅ 导入成功！共导入 " + result.success + " 条记录", "success");
            search();
        } else {
            toolsShowMsg("导入失败：" + (result.msg || '未知错误'), "error");
        }
    } catch(e) { toolsShowMsg("导入失败：" + e.message, "error"); }
    input.value = '';
}

// 清空记录
async function toolsClear() {
    if (!confirm('⚠️ 确定要清空所有知识记录吗？此操作将永久删除全部记录，不可恢复！')) return;
    if (!confirm('再次确认：真的要删除所有记录吗？')) return;
    toolsShowMsg("正在清空...", "info");
    try {
        var result = await apiFetch('/api/clear_all', { method: 'POST' });
        if (result.status === 'success') {
            toolsShowMsg("✅ 已清空所有知识记录", "success");
            search();
        } else { toolsShowMsg("清空失败：" + (result.msg || '未知错误'), "error"); }
    } catch(e) { toolsShowMsg("清空失败：" + e.message, "error"); }
}

// 手动备份
async function toolsBackup() {
    toolsShowMsg("正在备份...", "info");
    try {
        var result = await apiFetch('/api/backup/manual', { method: 'POST' });
        if (result.status === 'success') {
            toolsShowMsg("✅ 备份成功！" + (result.file||''), "success");
            toolsRefreshBackupList();
        } else { toolsShowMsg("❌ " + (result.msg || '备份失败'), "error"); }
    } catch(e) { toolsShowMsg("备份失败：" + e.message, "error"); }
}

// 备份列表
async function toolsRefreshBackupList() {
    try {
        var result = await apiFetch('/api/backup/list', { method: 'GET' });
        if (result.status === 'success' && result.files && result.files.length > 0) {
            _toolsBackupFiles = result.files;
            toolsRenderBackupList();
        } else {
            document.getElementById('toolsBackupList').innerHTML = '<div style="text-align:center;padding:16px;color:#999;font-size:13px;">暂无备份文件</div>';
        }
    } catch(e) {}
}
function toolsRenderBackupList() {
    var files = _toolsBackupFiles;
    var listEl = document.getElementById('toolsBackupList');
    var limit = _toolsBackupExpanded ? files.length : 3;
    var html = '<div style="font-size:13px;color:#555;margin-bottom:6px;">可用备份（共' + files.length + '个）';
    if (files.length > 3) {
        html += ' <a href="javascript:void(0)" onclick="toolsToggleBackupList()" style="color:#165DFF;font-size:12px;">' + (_toolsBackupExpanded ? '收起' : '展开全部') + '</a>';
    }
    html += '</div>';
    for (var i = 0; i < Math.min(limit, files.length); i++) {
        var f = files[i];
        var d = new Date(f.mtime * 1000);
        var dateStr = d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)+' '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;background:#f7f8fa;border-radius:6px;margin-bottom:4px;font-size:12px;">' +
            '<div style="flex:1;overflow:hidden;">' +
            '<div style="color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + f.name + '</div>' +
            '<div style="color:#999;font-size:11px;">' + (f.size/1024).toFixed(0) + ' KB · ' + dateStr + '</div></div>' +
            '<div style="display:flex;gap:4px;flex-shrink:0;">' +
            '<button class="btn-sm" style="font-size:11px;padding:4px 10px;background:#165DFF;color:#fff;border:none;border-radius:4px;cursor:pointer;" onclick="toolsRestore(\'' + f.name + '\',this)">恢复</button>' +
            '<button class="btn-sm btn-del" style="font-size:11px;padding:4px 8px;" onclick="toolsDeleteBackup(\'' + f.name + '\',this)">×</button></div></div>';
    }
    listEl.innerHTML = html;
}
function toolsToggleBackupList() {
    _toolsBackupExpanded = !_toolsBackupExpanded;
    toolsRenderBackupList();
}

// 恢复备份
async function toolsRestore(filename, btn) {
    if (!confirm('⚠️ 确定要从备份文件恢复吗？此操作将清空当前所有数据！\n\n文件：' + filename)) return;
    if (!confirm('再次确认：真的要恢复此备份吗？')) return;
    btn.disabled = true; btn.textContent = '恢复中...';
    toolsShowMsg("正在恢复（可能1-2分钟）...", "info");
    try {
        var result = await apiFetch('/api/backup/restore', { method: 'POST', body: JSON.stringify({ filename: filename }) });
        if (result.status === 'success') {
            toolsShowMsg("✅ 恢复成功！系统已重新初始化", "success");
            search();
        } else { toolsShowMsg("❌ " + (result.msg || '恢复失败'), "error"); }
    } catch(e) { toolsShowMsg("恢复失败：" + e.message, "error"); }
    btn.disabled = false; btn.textContent = '恢复';
}

// 删除备份文件
async function toolsDeleteBackup(filename, btn) {
    if (!confirm('确定要删除备份文件吗？\n\n' + filename)) return;
    btn.disabled = true;
    try {
        var result = await apiFetch('/api/backup/delete', { method: 'POST', body: JSON.stringify({ filename: filename }) });
        if (result.status === 'success') {
            toolsRefreshBackupList();
        } else { toolsShowMsg("删除失败：" + (result.msg || ''), "error"); }
    } catch(e) { toolsShowMsg("删除失败：" + e.message, "error"); }
}

// 初始化表结构
async function toolsInitTables() {
    if (!confirm('⚠️ 初始化表结构将创建缺失的数据库表（已有表不会被影响）。适用于误删库后重新建表。')) return;
    toolsShowMsg("正在建表...", "info");
    try {
        var result = await apiFetch('/api/backup/init_tables', { method: 'POST' });
        if (result.status === 'success') {
            toolsShowMsg("✅ " + result.msg, "success");
        } else { toolsShowMsg("❌ " + (result.msg || '建表失败'), "error"); }
    } catch(e) { toolsShowMsg("建表失败：" + e.message, "error"); }
}

// 刷新 ID 流水号状态
async function toolsRefreshIdSeq() {
    try {
        var result = await apiFetch('/api/id_sequence', { method: 'GET' });
        if (result.status === 'success') {
            document.getElementById('toolsIdSeqInfo').innerHTML =
                '当前最大ID：<strong>' + result.max_id + '</strong> &nbsp;|&nbsp; 下条新ID将使用：<strong>' + result.next_id + '</strong>';
            document.getElementById('toolsIdSeqInput').value = result.next_id;
        } else {
            document.getElementById('toolsIdSeqInfo').innerHTML = '获取失败';
        }
    } catch(e) {
        document.getElementById('toolsIdSeqInfo').innerHTML = '获取失败';
    }
}

// 重置 ID 流水号
async function toolsResetIdSeq() {
    var val = parseInt(document.getElementById('toolsIdSeqInput').value);
    if (isNaN(val) || val < 0) { toolsShowMsg("请输入有效的非负整数", "error"); return; }
    if (!confirm('确定要将 ID 流水号起始值重置为 ' + val + ' 吗？\n\n重置后新增记录将从 ' + val + ' 开始编号。')) return;
    toolsShowMsg("正在重置...", "info");
    try {
        var result = await apiFetch('/api/id_sequence', { method: 'POST', body: JSON.stringify({ start_with: val }) });
        if (result.status === 'success') {
            toolsShowMsg("✅ " + result.msg, "success");
            toolsRefreshIdSeq();
        } else {
            toolsShowMsg("❌ " + (result.msg || '重置失败'), "error");
        }
    } catch(e) { toolsShowMsg("重置失败：" + e.message, "error"); }
}

// ===================== 操作日志功能 =====================
var _logPage = 1;
var _logPageSize = 50;
var _logTotal = 0;
var _logSearchTimer = null;

function logSearchDebounce() {
    clearTimeout(_logSearchTimer);
    _logSearchTimer = setTimeout(function() {
        _logPage = 1;
        loadLogs();
    }, 400);
}

function logPrevPage() {
    if (_logPage > 1) { _logPage--; loadLogs(); }
}

function logNextPage() {
    var maxPage = Math.max(1, Math.ceil(_logTotal / _logPageSize));
    if (_logPage < maxPage) { _logPage++; loadLogs(); }
}

async function loadLogs() {
    var keyword = document.getElementById('logKeywordInput').value.trim();
    var level = document.getElementById('logLevelFilter').value;
    var container = document.getElementById('logListContainer');

    container.innerHTML = '<div style="padding:16px;text-align:center;color:#666;">加载中...</div>';

    try {
        var params = 'page=' + _logPage + '&page_size=' + _logPageSize;
        if (keyword) params += '&keyword=' + encodeURIComponent(keyword);
        if (level) params += '&level=' + encodeURIComponent(level);

        var data = await apiFetch('/api/logs?' + params);
        if (!data) {
            container.innerHTML = '<div style="padding:16px;text-align:center;color:#f53f3f;">加载失败：无返回数据，请确认服务已重启</div>';
            return;
        }
        if (data.status !== 'success') {
            container.innerHTML = '<div style="padding:16px;text-align:center;color:#f53f3f;">加载失败：' + (data.msg || '未知错误') + '</div>';
            return;
        }

        _logTotal = data.total || 0;
        var logs = data.logs || [];
        var maxPage = Math.max(1, Math.ceil(_logTotal / _logPageSize));

        // 更新分页信息
        document.getElementById('logTotalInfo').textContent = '共 ' + _logTotal + ' 条';
        document.getElementById('logPageInfo').textContent = _logPage + '/' + maxPage;

        if (logs.length === 0) {
            container.innerHTML = '<div style="padding:16px;text-align:center;color:#666;">暂无日志记录</div>';
            return;
        }

        var html = '';
        for (var i = 0; i < logs.length; i++) {
            var entry = logs[i];
            var levelColor = '#569cd6';
            if (entry.level === 'WARNING') levelColor = '#f9ab00';
            if (entry.level === 'ERROR') levelColor = '#f53f3f';

            var levelBadge = entry.level ? '<span style="color:' + levelColor + ';font-weight:bold;margin-right:6px;">[' + entry.level + ']</span>' : '';
            var userBadge = entry.user ? '<span style="color:#9cdcfe;margin-right:6px;">[' + _escHtml(entry.user) + ']</span>' : '';
            var content = _escHtml(entry.content || entry.raw);

            html += '<div style="padding:5px 10px;border-bottom:1px solid #2a2a3e;' + (i === 0 ? '' : '') + '">';
            html += '<span style="color:#6a9955;margin-right:8px;">' + _escHtml(entry.time) + '</span>';
            html += levelBadge + userBadge;
            html += '<span style="color:#d4d4d4;">' + content + '</span>';
            html += '</div>';
        }
        container.innerHTML = html;
        // 滚到顶部
        container.scrollTop = 0;
    } catch(e) {
        container.innerHTML = '<div style="padding:16px;text-align:center;color:#f53f3f;">加载失败：' + _escHtml(e.message) + '</div>';
    }
}

function _escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function clearLogs() {
    if (!confirm('⚠️ 确定要清空所有操作日志吗？此操作不可恢复！')) return;
    try {
        var data = await apiFetch('/api/logs/clear', { method: 'POST' });
        if (data && data.status === 'success') {
            loadLogs();
        } else {
            alert('清空失败：' + (data && data.msg ? data.msg : '请确认服务已重启加载新路由'));
        }
    } catch(e) {
        alert('清空失败，请确认服务已重启以加载新功能');
    }
}

// ===== 换肤系统 =====
const THEMES = [
    {id:'0', name:'原图背景', css:'background:#f0f4f8;background-image:url(/upload/backgr.png);background-size:cover;background-position:center'},
    {id:'1', name:'彩虹渐变', css:'background:linear-gradient(-45deg,#667eea,#764ba2,#f093fb,#4facfe)'},
    {id:'2', name:'三色呼吸', css:'background:linear-gradient(135deg,#80deea,#9fa8da,#f48fb1)'},
    {id:'3', name:'粒子+渐变', css:'background:linear-gradient(135deg,#80deea,#9fa8da,#f48fb1)'},
    {id:'4', name:'深空星夜', css:'background:#0a0a23'},
    {id:'5', name:'极光漫射', css:'background:linear-gradient(to bottom,#0a0a23,#1a1a3e)'},
    {id:'6', name:'深海气泡', css:'background:linear-gradient(160deg,#0c1445,#0d47a1)'},
    {id:'7', name:'霓虹网格', css:'background:#0a0a1a'},
    {id:'8', name:'日落渐变', css:'background:linear-gradient(to bottom,#1a0533,#c94b4b,#f09819,#ff512f)'},
    {id:'9', name:'浅色气泡', css:'background:linear-gradient(135deg,#e8f5e9,#fce4ec)'},
    {id:'10',name:'矩阵代码', css:'background:#000'},
    {id:'11',name:'海洋波浪', css:'background:linear-gradient(to bottom,#006994,#00b4d8)'},
    {id:'12',name:'素雅米白', css:'background:linear-gradient(135deg,#faf8f5,#e8e2d8)'}
];

function initThemeGrid(){
    var grid = document.getElementById('themeGrid');
    if(!grid) return;
    var current = localStorage.getItem('kb_theme') || '3';
    var html = '';
    for(var i = 0; i < THEMES.length; i++){
        var t = THEMES[i];
        html += '<div class="theme-opt' + (t.id === current ? ' active' : '') + '" data-theme="' + t.id + '" onclick="setTheme(\'' + t.id + '\')">'
             + '<div class="theme-preview" style="' + t.css + '"></div>'
             + '<span>' + t.name + '</span></div>';
    }
    grid.innerHTML = html;
    updateThemeLabel(current);
}

function setTheme(id){
    // 移除旧主题 class
    var classes = document.body.className.split(' ');
    for(var i = classes.length - 1; i >= 0; i--){
        if(classes[i].indexOf('theme-') === 0) classes.splice(i, 1);
    }
    document.body.className = classes.join(' ');
    document.body.classList.add('theme-' + id);
    localStorage.setItem('kb_theme', id);
    // 更新 UI 高亮
    var opts = document.querySelectorAll('.theme-opt');
    for(var i = 0; i < opts.length; i++){
        if(opts[i].getAttribute('data-theme') === id){
            opts[i].classList.add('active');
        } else {
            opts[i].classList.remove('active');
        }
    }
    updateThemeLabel(id);
}

function updateThemeLabel(id){
    var label = document.getElementById('themeLabel');
    if(!label) return;
    for(var i = 0; i < THEMES.length; i++){
        if(THEMES[i].id === id){
            label.textContent = '当前主题：' + THEMES[i].name;
            return;
        }
    }
    label.textContent = '';
}

/* ===== 更多菜单 ===== */
function toggleMoreMenu() {
    var dd = document.getElementById("moreDropdown");
    if(!dd) return;
    dd.classList.toggle("show");
}
// 点击页面其他地方关闭 moreDropdown
document.addEventListener("click", function(e){
    var dd = document.getElementById("moreDropdown");
    if(!dd) return;
    var trigger = document.querySelector(".more-trigger");
    if(!trigger) return;
    if(!dd.contains(e.target) && !trigger.contains(e.target)){
        dd.classList.remove("show");
    }
});

/* ===== 用户功能侧边栏 ===== */
function toggleUserSidebar(){
    document.body.classList.toggle('sidebar-open');
}
function closeUserSidebar(){
    document.body.classList.remove('sidebar-open');
}
// 点击侧边栏外部关闭（overlay 已通过 onclick 处理，此处处理 Escape 键）
document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){
        closeUserSidebar();
    }
});

/* ===== PWA Service Worker 注册 ===== */
if('serviceWorker' in navigator){
    navigator.serviceWorker.register('/static/sw.js').catch(function(){});
}

/* ===== 手机端新增卡片切换 ===== */
var mobileAddOpen = false;
function toggleAddCard(){
    var card = document.getElementById('addCard');
    if(!card) return;
    mobileAddOpen = !mobileAddOpen;
    if(mobileAddOpen){
        card.classList.add('mobile-open');
        document.body.style.overflow = 'hidden';
    } else {
        card.classList.remove('mobile-open');
        document.body.style.overflow = '';
    }
}