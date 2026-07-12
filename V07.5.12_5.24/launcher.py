"""
智行知识库 - 单窗口启动器
清理旧进程 → 启动Flask → Ctrl+C关闭后自动清理
全程一个黑窗搞定。
"""
import subprocess
import os
import sys
import time
import re
import signal
import atexit

# 修复 Windows 控制台 GBK 编码无法输出 emoji/特殊字符的问题
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def find_pids_on_port(port):
    """查找占用指定端口的进程PID"""
    pids = set()
    try:
        output = subprocess.check_output(
            f'netstat -ano | findstr ":{port}" | findstr "LISTENING"',
            shell=True, text=True, stderr=subprocess.DEVNULL
        )
        for line in output.strip().splitlines():
            m = re.search(r'(\d+)\s*$', line.strip())
            if m:
                pids.add(int(m.group(1)))
    except subprocess.CalledProcessError:
        pass
    return pids


def kill_processes(pids):
    """强制终止多个进程"""
    for pid in pids:
        try:
            subprocess.run(f"taskkill /f /pid {pid}", shell=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass


def cleanup(port):
    """退出时清理：杀掉占用端口的残留进程"""
    print()
    print("正在清理残留进程...")
    time.sleep(1)
    pids = find_pids_on_port(port)
    if pids:
        kill_processes(pids)
        print(f"  ✅ 已清理 {len(pids)} 个残留进程")
    else:
        print("  ✅ 无残留进程")
    print("  可关闭此窗口")
    print()


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    port = 8901

    print("=" * 50)
    print("  智行知识库 V07.5.12  (PostgreSQL)")
    print("=" * 50)
    print()

    # 1. 清理旧进程
    print(f"检查端口 {port} 旧进程...")
    old_pids = find_pids_on_port(port)
    if old_pids:
        print(f"发现 {len(old_pids)} 个旧进程，正在清理...")
        kill_processes(old_pids)
        time.sleep(2)
    else:
        print("端口空闲")

    # 2. 注册退出清理
    atexit.register(cleanup, port)

    # 3. 在本窗口启动Flask（不开新窗口）
    print(f"启动 Flask 服务...")
    print(f"  🌐 访问地址: http://localhost:{port}")
    print(f"  ⏹  按 Ctrl+C 停止服务")
    print("-" * 50)
    sys.stdout.flush()

    try:
        proc = subprocess.run(
            [sys.executable, "app.py"],
            cwd=script_dir
        )
    except KeyboardInterrupt:
        pass

    # 4. Flask退出后触发清理（atexit）
    sys.exit(0)


if __name__ == "__main__":
    main()
