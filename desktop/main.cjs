const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const {spawn} = require("node:child_process");
const {setTimeout: delay} = require("node:timers/promises");
const {app, BrowserWindow, shell, dialog} = require("electron");
const {autoUpdater} = require("electron-updater");

const DEFAULT_PORT = Number(process.env.BATCH_UI_PORT || 3210);
const BATCH_UI_HOST = process.env.BATCH_UI_HOST || "127.0.0.1";
const PORT_SCAN_LIMIT = 25;

let mainWindow = null;
let serverProcess = null;
let serverPort = DEFAULT_PORT;
let quitting = false;

const log = (...messages) => {
  console.log("[desktop]", ...messages);
};

const normalizeLine = (chunk) =>
  chunk
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const runCommand = ({command, args, cwd, env}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk) => {
      normalizeLine(chunk).forEach((line) => {
        log(`[bootstrap] ${line}`);
      });
    });

    child.stderr.on("data", (chunk) => {
      normalizeLine(chunk).forEach((line) => {
        log(`[bootstrap:error] ${line}`);
      });
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command ${command} ${args.join(" ")} exited with code ${code}`));
    });
  });

const resolveNpmInstallCommand = () => {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      args: [npmExecPath, "install"],
    };
  }

  if (process.platform === "win32") {
    return {
      command: "npm.cmd",
      args: ["install"],
    };
  }

  return {
    command: "npm",
    args: ["install"],
  };
};

const isPortAvailable = (port) =>
  new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", () => {
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => {
        resolve(true);
      });
    });

    tester.listen(port, BATCH_UI_HOST);
  });

const findAvailablePort = async (startPort, maxScan = PORT_SCAN_LIMIT) => {
  for (let offset = 0; offset < maxScan; offset += 1) {
    const candidate = startPort + offset;
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(candidate);
    if (available) {
      return candidate;
    }
  }

  throw new Error(`Tidak menemukan port kosong dalam rentang ${startPort}-${startPort + maxScan - 1}.`);
};

const probeLocalHealthEndpoint = ({port}) =>
  new Promise((resolve) => {
    const request = http.request(
      {
        hostname: BATCH_UI_HOST,
        port,
        path: "/api/health",
        method: "GET",
        timeout: 1500,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );

    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });

    request.once("error", () => {
      resolve(false);
    });

    request.end();
  });

const waitForServerReady = async ({port, timeoutMs = 25000}) => {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const healthy = await probeLocalHealthEndpoint({port});
    if (healthy) {
      return;
    }

    await delay(250);
  }

  throw new Error("Server Batch UI tidak merespons endpoint health check dalam batas waktu startup.");
};

const killServerProcess = () => {
  if (!serverProcess || !Number.isFinite(serverProcess.pid)) {
    return;
  }

  const pid = serverProcess.pid;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      detached: true,
    });
    killer.unref();
    return;
  }

  serverProcess.kill("SIGTERM");
};

const getAppRoot = () => {
  const appPath = app.getAppPath();
  if (path.basename(appPath).toLowerCase() === "desktop") {
    return path.dirname(appPath);
  }
  return appPath;
};

const copyPath = (sourcePath, targetPath) => {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  fs.rmSync(targetPath, {recursive: true, force: true});
  fs.cpSync(sourcePath, targetPath, {recursive: true, force: true});
};

const copyFile = (sourcePath, targetPath) => {
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), {recursive: true});
  fs.copyFileSync(sourcePath, targetPath);
};

const ensureNodeModulesWorkspaceLink = ({appRoot, workspaceRoot}) => {
  const sourceNodeModules = path.resolve(appRoot, "node_modules");
  const targetNodeModules = path.resolve(workspaceRoot, "node_modules");

  if (!fs.existsSync(sourceNodeModules)) {
    throw new Error(`node_modules tidak ditemukan di ${sourceNodeModules}`);
  }

  if (fs.existsSync(targetNodeModules)) {
    return;
  }

  try {
    fs.symlinkSync(
      sourceNodeModules,
      targetNodeModules,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    // Fallback: copy when symlink/junction is not available in host policy.
    log(`node_modules symlink gagal, fallback copy: ${error instanceof Error ? error.message : String(error)}`);
    fs.cpSync(sourceNodeModules, targetNodeModules, {recursive: true, force: true});
  }
};

const ensureRuntimeWorkspace = (appRoot) => {
  if (!app.isPackaged) {
    return appRoot;
  }

  const workspaceRoot = path.resolve(app.getPath("userData"), "runtime-workspace");
  fs.mkdirSync(workspaceRoot, {recursive: true});

  ensureNodeModulesWorkspaceLink({appRoot, workspaceRoot});

  // Always refresh scripts + configs so bugfixes from new app build are applied.
  copyPath(path.resolve(appRoot, "scripts"), path.resolve(workspaceRoot, "scripts"));
  copyFile(path.resolve(appRoot, "package.json"), path.resolve(workspaceRoot, "package.json"));
  copyFile(path.resolve(appRoot, "remotion.config.ts"), path.resolve(workspaceRoot, "remotion.config.ts"));
  copyFile(path.resolve(appRoot, "tsconfig.json"), path.resolve(workspaceRoot, "tsconfig.json"));
  copyFile(path.resolve(appRoot, ".env.example"), path.resolve(workspaceRoot, ".env.example"));
  copyFile(path.resolve(appRoot, ".env.public.example"), path.resolve(workspaceRoot, ".env.public.example"));

  // Initialize mutable project assets once, then keep user edits.
  const initDirs = ["src", "batch", "public"];
  initDirs.forEach((dirName) => {
    const sourceDir = path.resolve(appRoot, dirName);
    const targetDir = path.resolve(workspaceRoot, dirName);
    if (!fs.existsSync(targetDir) && fs.existsSync(sourceDir)) {
      fs.cpSync(sourceDir, targetDir, {recursive: true, force: true});
    }
  });

  fs.mkdirSync(path.resolve(workspaceRoot, "out", "batch"), {recursive: true});
  return workspaceRoot;
};

const appendEnvCandidatesFromDir = (candidates, startDir, maxDepth = 8) => {
  if (!startDir) {
    return;
  }

  const envNames = [
    ".env.local",
    ".env.public.local",
    ".env.public",
    ".env.public.txt",
    ".env",
  ];

  let current = path.resolve(startDir);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    envNames.forEach((fileName) => {
      candidates.push(path.resolve(current, fileName));
    });

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }
};

const resolveBatchUiEnvFile = (appRoot) => {
  const explicitPath = process.env.BATCH_UI_ENV_FILE?.trim();
  if (explicitPath) {
    const absolute = path.resolve(explicitPath);
    if (fs.existsSync(absolute)) {
      return absolute;
    }
  }

  const candidates = [];
  appendEnvCandidatesFromDir(candidates, process.cwd());
  appendEnvCandidatesFromDir(candidates, appRoot);
  appendEnvCandidatesFromDir(candidates, path.dirname(process.execPath));
  appendEnvCandidatesFromDir(candidates, app.getPath("userData"), 3);
  appendEnvCandidatesFromDir(candidates, app.getPath("appData"), 3);
  appendEnvCandidatesFromDir(candidates, app.getPath("home"), 2);

  const runtimeAppName = path.basename(process.execPath, path.extname(process.execPath)).trim();
  if (runtimeAppName) {
    const appDataEnv = process.env.APPDATA;
    const localAppDataEnv = process.env.LOCALAPPDATA;
    if (appDataEnv) {
      appendEnvCandidatesFromDir(candidates, path.resolve(appDataEnv, runtimeAppName), 1);
    }
    if (localAppDataEnv) {
      appendEnvCandidatesFromDir(candidates, path.resolve(localAppDataEnv, runtimeAppName), 1);
    }
  }

  const uniqueCandidates = [...new Set(candidates)];
  for (const envPath of uniqueCandidates) {
    if (fs.existsSync(envPath)) {
      return envPath;
    }
  }

  return "";
};

const ensureDependenciesInstalled = async (appRoot) => {
  if (app.isPackaged) {
    return;
  }

  const packageLockPath = path.resolve(appRoot, "package-lock.json");
  const nodeModulesPath = path.resolve(appRoot, "node_modules");
  const markerDir = path.resolve(app.getPath("userData"), "bootstrap");
  const markerPath = path.resolve(markerDir, "deps-lock.sha256");

  if (!fs.existsSync(packageLockPath)) {
    log("package-lock.json tidak ditemukan, melewati bootstrap dependency otomatis.");
    return;
  }

  const lockHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(packageLockPath))
    .digest("hex");

  let previousHash = "";
  if (fs.existsSync(markerPath)) {
    previousHash = fs.readFileSync(markerPath, "utf8").trim();
  }

  const nodeModulesReady = fs.existsSync(nodeModulesPath);
  const lockChanged = previousHash !== lockHash;

  if (nodeModulesReady && !lockChanged) {
    return;
  }

  const reason = !nodeModulesReady
    ? "node_modules belum tersedia"
    : "perubahan package-lock terdeteksi";

  log(`Menjalankan bootstrap dependency: ${reason}`);

  const npmInstall = resolveNpmInstallCommand();
  log(`Bootstrap command: ${npmInstall.command} ${npmInstall.args.join(" ")}`);

  try {
    await runCommand({
      command: npmInstall.command,
      args: npmInstall.args,
      cwd: appRoot,
      env: {
        ...process.env,
        npm_config_yes: "true",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Gagal bootstrap dependency otomatis. Pastikan Node.js + npm terpasang dan coba jalankan npm install manual. Detail: ${message}`,
    );
  }

  fs.mkdirSync(markerDir, {recursive: true});
  fs.writeFileSync(markerPath, lockHash, "utf8");
  log("Bootstrap dependency selesai.");
};

const startBatchUiServer = async () => {
  serverPort = await findAvailablePort(DEFAULT_PORT, PORT_SCAN_LIMIT);

  const appRoot = getAppRoot();
  const runtimeRoot = ensureRuntimeWorkspace(appRoot);
  const serverScriptPath = path.resolve(runtimeRoot, "scripts", "batch-ui.mjs");
  const envFile = resolveBatchUiEnvFile(runtimeRoot);

  if (runtimeRoot !== appRoot) {
    log(`Using runtime workspace: ${runtimeRoot}`);
  }

  if (envFile) {
    log(`Using env file: ${envFile}`);
  } else {
    log("No .env file found for Batch UI server process.");
  }

  let markReadyFromLog = null;
  const readyFromLog = new Promise((resolve) => {
    markReadyFromLog = resolve;
  });

  serverProcess = spawn(process.execPath, [serverScriptPath], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BATCH_UI_PORT: String(serverPort),
      BATCH_UI_HOST,
      ...(envFile ? {BATCH_UI_ENV_FILE: envFile} : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProcess.stdout.on("data", (chunk) => {
    normalizeLine(chunk).forEach((line) => {
      log("server:", line);
      if (line.includes("Batch UI running at http://") && typeof markReadyFromLog === "function") {
        markReadyFromLog();
        markReadyFromLog = null;
      }
    });
  });

  serverProcess.stderr.on("data", (chunk) => {
    normalizeLine(chunk).forEach((line) => {
      log("server:error:", line);
    });
  });

  serverProcess.once("exit", (code) => {
    const crashedBeforeQuit = !quitting;
    log(`Server process exited with code ${code}`);

    serverProcess = null;

    if (crashedBeforeQuit) {
      dialog.showErrorBox(
        "Batch UI Server Berhenti",
        "Proses server Batch UI berhenti tiba-tiba. Silakan buka log desktop untuk detail error.",
      );
    }
  });

  await Promise.race([
    waitForServerReady({port: serverPort}),
    readyFromLog,
  ]);
  log(`Batch UI server ready on port ${serverPort}`);
};

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: "Motion Video Batch UI",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.resolve(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webviewTag: false,
      devTools: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url).catch(() => {
        // Ignore external opener errors.
      });
    }

    return {action: "deny"};
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const appUrl = `http://${BATCH_UI_HOST}:${serverPort}/subscription`;
  void mainWindow.loadURL(appUrl);
};

const initializeAutoUpdate = () => {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (error) => {
    log("autoUpdater error:", error?.message || String(error));
  });

  autoUpdater.on("update-available", (info) => {
    log("update available:", info?.version || "unknown");
  });

  autoUpdater.on("update-downloaded", () => {
    log("update downloaded and will be installed on quit");
  });

  void autoUpdater.checkForUpdatesAndNotify();
};

const bootDesktopApp = async () => {
  try {
    const appRoot = getAppRoot();
    await ensureDependenciesInstalled(appRoot);
    await startBatchUiServer();
    createMainWindow();
    initializeAutoUpdate();
  } catch (error) {
    log("Boot error:", error instanceof Error ? error.stack || error.message : String(error));
    dialog.showErrorBox(
      "Gagal Memulai Desktop App",
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootDesktopApp);
}

app.on("before-quit", () => {
  quitting = true;
  killServerProcess();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!mainWindow) {
    createMainWindow();
  }
});
