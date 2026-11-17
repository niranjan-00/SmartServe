
import { spawn } from "node:child_process";

const appPort = process.env.PORT || "3000";
const workerPort = process.env.WHATSAPP_WORKER_PORT || "3020";

const commonEnv = { ...process.env };

const web = spawn(
  process.execPath,
  [".next/standalone/server.js"],
  {
    env: {
      ...commonEnv,
      PORT: appPort,
      HOSTNAME: "0.0.0.0",
    },
    stdio: "inherit",
  }
);

const worker = spawn(
  process.execPath,
  ["--import", "tsx", "mini-services/baileys-worker/index.ts"],
  {
    env: {
      ...commonEnv,
      WHATSAPP_WORKER_PORT: workerPort,
      NEXT_APP_URL: `http://127.0.0.1:${appPort}`,
    },
    stdio: "inherit",
  }
);

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  web.kill("SIGTERM");
  worker.kill("SIGTERM");

  setTimeout(() => process.exit(code), 5000).unref();
}

web.on("exit", (code) => shutdown(code || 1));
worker.on("exit", (code) => shutdown(code || 1));

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

console.log("SmartServe web and Baileys Worker are starting...");
