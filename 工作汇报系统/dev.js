/**
 * Work Report System - Dev Launcher
 * Single window, colored logs with [Backend] / [Frontend] prefix
 * Auto-kills lingering processes on ports 8902/5173 before starting
 */
const { spawn, exec } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = __dirname;
const BACKEND = path.join(ROOT, 'backend');
const FRONTEND = path.join(ROOT, 'frontend');

// Colors
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let children = [];
let exiting = false;

function cleanup() {
  if (exiting) return;
  exiting = true;
  console.log(`\n${YELLOW}Stopping all services...${RESET}`);
  children.forEach(c => {
    try { c.kill('SIGTERM'); } catch (_) {}
  });
  setTimeout(() => {
    children.forEach(c => {
      try { c.kill('SIGKILL'); } catch (_) {}
    });
    process.exit(0);
  }, 3000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Kill process occupying a port (Windows)
 * Uses netstat to find PID, then taskkill
 */
function killPort(port) {
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr :${port} | findstr LISTENING`, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(false); return; }
      const parts = stdout.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1]);
      if (pid && pid > 0 && !isNaN(pid)) {
        exec(`taskkill /F /PID ${pid}`, () => { setTimeout(() => resolve(true), 1000); });
      } else {
        resolve(false);
      }
    });
  });
}

function startService(name, color, cwd, command, args) {
  const prefix = `${color}[${name}]${RESET} `;
  const shellNeeded = (name === 'Frontend');  // npx is a .cmd file on Windows
  const child = spawn(command, args, {
    cwd,
    shell: shellNeeded,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' }
  });

  child.on('error', (err) => {
    console.log(`${RED}[${name}] Failed to start: ${err.message}${RESET}`);
  });

  child.stdout.on('data', (data) => {
    const lines = data.toString().replace(/\n$/, '').split('\n');
    lines.forEach(line => {
      if (line.trim()) console.log(prefix + line);
    });
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().replace(/\n$/, '').split('\n');
    lines.forEach(line => {
      if (line.trim()) console.log(prefix + line);
    });
  });

  child.on('close', (code) => {
    if (!exiting) {
      if (code === 0) {
        console.log(`${GRAY}[${name}] Exited${RESET}`);
      } else {
        console.log(`${RED}[${name}] Crashed, exit code: ${code}${RESET}`);
      }
      // Don't kill other services - let them keep running
    }
  });

  children.push(child);
  return child;
}

async function killAllNode() {
  await killPort(8902);
  await killPort(5173);
}

function buildFrontend() {
  return new Promise((resolve) => {
    console.log(`${YELLOW}  Building frontend...${RESET}`);
    const child = spawn('npx', ['vite', 'build'], { cwd: FRONTEND, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => process.stdout.write(d));
    child.stderr.on('data', d => process.stdout.write(d));
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`${GREEN}  Frontend build done${RESET}`);
        resolve(true);
      } else {
        console.log(`${RED}  Frontend build failed (exit: ${code})${RESET}`);
        resolve(false);
      }
    });
  });
}

async function main() {
  console.log('');
  console.log(`${BOLD}============================================${RESET}`);
  console.log(`${BOLD}  Work Report System - Dev Mode${RESET}`);
  console.log(`${BOLD}============================================${RESET}`);
  console.log('');

  // Step 1: Kill all old node processes
  console.log(`${YELLOW}  Killing old processes...${RESET}`);
  await killAllNode();
  console.log(`${GREEN}  Old processes cleared${RESET}`);
  console.log('');

  // Step 2: Build frontend
  const built = await buildFrontend();
  if (!built) {
    console.log(`${RED}  Build failed, aborting${RESET}`);
    return;
  }
  console.log('');

  console.log(`  Backend:  ${CYAN}http://localhost:8902${RESET}`);
  console.log(`  Frontend: ${CYAN}http://localhost:5173${RESET}`);
  console.log(`  Login:    ${GREEN}admin / admin123${RESET}`);
  console.log('');
  console.log(`${GRAY}Ctrl+C to stop | Colleagues visit http://YOUR_IP:8902${RESET}`);
  console.log(`${GRAY}If services keep running after closing window, double-click stop.bat${RESET}`);
  console.log('');

  // Start backend
  startService('Backend', CYAN, BACKEND, process.execPath, ['app.js']);

  // Start frontend dev server
  setTimeout(() => {
    startService('Frontend', GREEN, FRONTEND, 'npx', ['vite', '--host', '127.0.0.1', '--port', '5173']);
  }, 1500);
}

main().catch(err => {
  console.error(`${RED}Failed to start: ${err.message}${RESET}`);
});
