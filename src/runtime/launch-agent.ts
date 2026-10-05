import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../config.js";

const label = "local.whatsapp-chat-intelligence.worker";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function launchAgentPlist(nodePath: string, entryPoint: string, config: RuntimeConfig): string {
  const logsDir = join(config.dataDir, "logs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>--env-file-if-exists=${xml(config.runtimeEnvPath)}</string><string>${xml(entryPoint)}</string><string>worker</string></array>
  <key>WorkingDirectory</key><string>${xml(process.cwd())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logsDir, "worker.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logsDir, "worker.err.log"))}</string>
</dict></plist>`;
}

/** Writes a per-user LaunchAgent; it does not load it, request privileges, or expose secrets. */
export function installLaunchAgent(nodePath: string, entryPoint: string, config: RuntimeConfig): string {
  const launchAgents = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(launchAgents, { recursive: true, mode: 0o700 });
  mkdirSync(join(config.dataDir, "logs"), { recursive: true, mode: 0o700 });
  const path = join(launchAgents, `${label}.plist`);
  writeFileSync(path, launchAgentPlist(nodePath, entryPoint, config), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
