import net from "node:net";
import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, delimiter } from "node:path";
import { homedir, platform } from "node:os";
import { hasEffortFlag, parseClaudexArgs } from "./cli-args.ts";
import { startProxy, type ProxyOptions } from "./proxy.ts";
import {
  loadRuntimeConfig,
  type RuntimeConfig,
} from "./runtime-config.ts";
import { readConfig } from "./config.ts";
import type { AuthState } from "./upstream.ts";

const rawArgs = process.argv.slice(2);
const parsedArgs = parseClaudexArgs(rawArgs);
const args = parsedArgs.claudeArgs;
const hasSettingsArg = parsedArgs.hasSettingsArg;
const preserveClientEffort = hasEffortFlag(args);
const defaultReasoningEffort =
  process.env.CLAUDEX_EFFORT || readConfig().effort || "high";
const isWin = platform() === "win32";
const claudeSubcommands = new Set([
  "agents",
  "auth",
  "doctor",
  "install",
  "mcp",
  "open",
  "plugin",
  "server",
  "setup-token",
  "update",
  "upgrade",
  "remote-control",
  "rc",
]);

function fail(message: string): never {
  console.error(`claudex: ${message}`);
  process.exit(1);
}

function whichSync(name: string): string | null {
  const extensions = isWin ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) {
        try {
          accessSync(candidate, isWin ? constants.R_OK : constants.X_OK);
          return candidate;
        } catch {
          /* skip */
        }
      }
    }
  }
  return null;
}

function buildWorkspaceSummary(rootDir: string): string | undefined {
  try {
    const ignored = new Set([
      ".git",
      "node_modules",
      "dist",
      ".DS_Store",
      ".idea",
      ".vscode",
    ]);
    const topEntries = readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => !ignored.has(entry.name))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );

    const dirs = topEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const files = topEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const lines = [
      `cwd: ${rootDir}`,
      `top-level dirs: ${dirs.slice(0, 20).join(", ") || "(none)"}`,
      `top-level files: ${files.slice(0, 30).join(", ") || "(none)"}`,
    ];

    for (const dirName of ["src", "tests", "scripts"]) {
      const dirPath = join(rootDir, dirName);
      if (!existsSync(dirPath)) continue;
      try {
        const children = readdirSync(dirPath, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        lines.push(
          `${dirName}/ files: ${children.slice(0, 30).join(", ") || "(none)"}`,
        );
      } catch {
        /* skip */
      }
    }

    const readmePath = join(rootDir, "README.md");
    if (existsSync(readmePath)) {
      try {
        const preview = readFileSync(readmePath, "utf8")
          .split("\n")
          .slice(0, 24)
          .join("\n");
        if (preview.trim()) {
          lines.push("README.md preview:", preview);
        }
      } catch {
        /* skip */
      }
    }

    return lines.join("\n");
  } catch {
    return undefined;
  }
}

function resolveClaudeBinary(): string {
  const arg1 = process.argv[1];
  let scriptDir = process.cwd();
  try {
    if (arg1 && !arg1.startsWith("-")) scriptDir = dirname(realpathSync(arg1));
    else scriptDir = dirname(realpathSync(process.execPath));
  } catch {
    /* use cwd */
  }

  const reverseDir = join(scriptDir, "reverse");
  if (existsSync(reverseDir)) {
    const candidates = readdirSync(reverseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith("claude-"))
      .map((entry) => join(reverseDir, entry.name))
      .filter((candidate) => {
        try {
          accessSync(candidate, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
      );
    if (candidates.length > 0) return candidates[0];
  }

  const found = whichSync("claude");
  if (found) return found;

  if (isWin) {
    const home = homedir();
    for (const candidate of [
      join(home, ".local", "bin", "claude.exe"),
      join(home, "AppData", "Local", "Programs", "claude", "claude.exe"),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }

  fail("Claude binary not found. Set CLAUDEX_CLAUDE_BIN.");
}

function pickFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to get listen port"));
        return;
      }
      const port = addr.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function createProxyOptions(
  runtime: RuntimeConfig,
  workspaceSummary?: string,
): ProxyOptions {
  return {
    forcedModel: runtime.forcedModel,
    availableModels: runtime.availableModels,
    modelEffortMap: runtime.modelEffortMap,
    defaultReasoningEffort,
    preserveClientEffort,
    workspaceSummary,
  };
}


function buildInjectedClaudeArgs(): string[] {
  const injectedArgs = [...args];
  const isSubcommand =
    injectedArgs.length > 0 &&
    !injectedArgs[0].startsWith("-") &&
    claudeSubcommands.has(injectedArgs[0]);
  if (!isSubcommand && !hasSettingsArg) {
    injectedArgs.push(
      "--settings",
      JSON.stringify({ availableModels: [], forceLoginMethod: "console" }),
    );
  }
  return injectedArgs;
}

function buildClaudeChildEnv(
  runtime: RuntimeConfig,
  proxyUrl: string,
): NodeJS.ProcessEnv {
  const mapping = runtime.modelMapping;
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: proxyUrl,
    ANTHROPIC_API_KEY: runtime.upstreamBearerToken,
    ANTHROPIC_MODEL: runtime.forcedModel,
    ANTHROPIC_SMALL_FAST_MODEL: mapping.small,
    ANTHROPIC_DEFAULT_OPUS_MODEL: mapping.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: mapping.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: mapping.haiku,
    CLAUDE_CODE_SUBAGENT_MODEL: mapping.subagent,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

async function main(): Promise<void> {
  const runtime = loadRuntimeConfig();
  const upstreamOrigin = new URL(runtime.upstreamBaseUrl);
  const claudeBinary = resolveClaudeBinary();

  const listenHost = "127.0.0.1";
  const listenPort = await pickFreePort(listenHost);
  const workspaceSummary = buildWorkspaceSummary(process.cwd());

  const authState: AuthState = {
    bearerToken: runtime.upstreamBearerToken,
    extraHeaders: runtime.upstreamExtraHeaders,
    chatgptRefreshConfig: runtime.chatgptRefreshConfig,
  };
  const proxyServer = await startProxy(
    listenHost,
    listenPort,
    upstreamOrigin,
    authState,
    createProxyOptions(runtime, workspaceSummary),
  );

  const proxyUrl = `http://${listenHost}:${listenPort}`;

  const child = spawn(claudeBinary, buildInjectedClaudeArgs(), {
    stdio: "inherit",
    env: buildClaudeChildEnv(runtime, proxyUrl),
  });

  process.on("SIGINT", () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGINT");
  });
  process.on("SIGTERM", () => {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 128 : (code ?? 0)));
  });

  await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  process.exit(exitCode);
}

if (parsedArgs.subcommand === "setting") {
  import("./setting.ts").then((m) => m.runSettingScreen());
} else {
  main().catch((error: unknown) => {
    console.error(`claudex: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
