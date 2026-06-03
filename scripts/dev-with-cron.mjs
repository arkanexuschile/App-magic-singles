import { spawn } from "node:child_process";

const appUrl =
  process.env.APP_URL?.trim() ||
  process.env.SHOPIFY_APP_URL?.trim() ||
  process.env.APP_BASE_URL?.trim() ||
  "http://localhost:3000";

const sharedEnv = {
  ...process.env,
  APP_BASE_URL: appUrl,
  SHOPIFY_APP_URL: appUrl,
};

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];

function log(message, extra) {
  if (extra !== undefined) {
    console.log(`[dev-with-cron] ${message}`, extra);
    return;
  }
  console.log(`[dev-with-cron] ${message}`);
}

function startProcess(name, args, env) {
  const child = spawn(npmCmd, args, {
    env,
    stdio: "inherit",
    shell: false,
  });

  child.on("exit", (code, signal) => {
    log(`${name} exited`, { code, signal });
    if (name === "dev") {
      shutdown();
    }
  });

  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore shutdown errors from already-exited processes.
      }
    }
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

log("starting processes", { appUrl });
startProcess("dev", ["run", "dev"], sharedEnv);

setTimeout(() => {
  startProcess("cron:dev", ["run", "cron:dev"], sharedEnv);
}, 4000);

