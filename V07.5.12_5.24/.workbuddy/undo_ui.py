"""Undo UI美化 (方案A) — 还原 style.css 和 app.js 中的 CSS 变量为原始值"""
import re

# ============ 还原 style.css ============
with open('static/style.css', 'r', encoding='utf-8') as f:
    css = f.read()

# 1. 删除 @import 行和 :root 定义块
css = re.sub(
    r"@import url\('https://fonts\.googleapis\.com/css2\?family=.*?display=swap'\);\n\n:root \{[^}]+\}\n\n",
    "",
    css
)

# 2. 恢复 font-family
css = css.replace("font-family:var(--font)", "font-family:Microsoft YaHei,sans-serif")

# 3. 恢复毛玻璃（把 backdrop-filter 去掉）
css = css.replace(
    ".modal{display:none;position:fixed;left:0;top:0;width:100%;height:100%;z-index:999;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}",
    ".modal{display:none;position:fixed;left:0;top:0;width:100%;height:100%;z-index:999;background:rgba(0,0,0,0.5)}"
)

# 4. 删除暗色模式块
css = re.sub(
    r"\n/\* ===== 暗色模式（跟随系统） ===== \*/[^}]+}[^}]+}",
    "",
    css
)

# 5. 替换 CSS 变量回原始值
var_map = {
    "var(--primary)": "#165DFF",
    "var(--primary-hover)": "#0E42D2",
    "var(--primary-light)": "#e8f4ff",
    "var(--danger)": "#f53f3f",
    "var(--success)": "#00b42a",
    "var(--warning)": "#ff7d00",
    "var(--text-primary)": "#1d2129",
    "var(--text-secondary)": "#86909c",
    "var(--text-muted)": "#999",
    "var(--border)": "#dcdfe6",
    "var(--border-hover)": "#165DFF",
    "var(--bg-card)": "#fff",
    "var(--bg-page)": "#f0f4f8",
    "var(--bg-item)": "#f7f8fa",
    "var(--bg-hover)": "#eef0f5",
    "var(--radius)": "8px",
    "var(--radius-lg)": "12px",
    "var(--radius-xl)": "16px",
    "var(--font)": "Microsoft YaHei,sans-serif",
    "rgba(var(--primary-rgb), 0.08)": "rgba(22,93,255,0.08)",
    "rgba(var(--primary-rgb), 0.12)": "rgba(22,93,255,0.12)",
    "rgba(var(--primary-rgb), 0.15)": "rgba(22,93,255,0.15)",
    "rgba(var(--primary-rgb), 0.1)": "rgba(22,93,255,0.1)",
    "rgba(var(--primary-rgb), 0.45)": "rgba(22,93,255,0.45)",
    "rgba(var(--primary-rgb), 0.55)": "rgba(22,93,255,0.55)",
    "rgba(var(--primary-rgb), 0.4)": "rgba(22,93,255,0.4)",
    "rgba(var(--primary-rgb), 0.2)": "rgba(22,93,255,0.2)",
    "rgba(var(--primary-rgb), 0.3)": "rgba(22,93,255,0.3)",
    "rgba(var(--primary-rgb), 0.25)": "rgba(22,93,255,0.25)",
}

for var_val, orig in var_map.items():
    css = css.replace(var_val, orig)

# 6. 清理残余的 :root 相关
css = css.replace(":root{", "")

with open('static/style.css', 'w', encoding='utf-8') as f:
    f.write(css)

print("style.css 还原完成")

# ============ 还原 app.js ============
with open('static/app.js', 'r', encoding='utf-8') as f:
    js = f.read()

js_var_map = {
    "var(--primary)": "#165DFF",
    "var(--primary-hover)": "#0E42D2",
    "var(--border)": "#dcdfe6",
    "var(--primary-light)": "#e8f4ff",
}

for var_val, orig in js_var_map.items():
    js = js.replace(var_val, orig)

with open('static/app.js', 'w', encoding='utf-8') as f:
    f.write(js)

print("app.js 还原完成")

# 验证
css_remain = 0
with open('static/style.css', 'r') as f:
    css_remain = f.read().count("var(--primary)")
js_remain = 0
with open('static/app.js', 'r') as f:
    js_remain = f.read().count("var(--primary)")

print(f"验证 — CSS 残余 var(--primary): {css_remain}, JS 残余: {js_remain}")
