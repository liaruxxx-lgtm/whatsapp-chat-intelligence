import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ChatExportDateOrder } from "./adapters/chat-export.js";
import { loadConfig } from "./config.js";
import { startDashboard } from "./dashboard/server.js";
import { installLaunchAgent } from "./runtime/launch-agent.js";
import { ChatIntelligenceApplication } from "./runtime/application.js";

async function run(): Promise<void> {
  const command = process.argv[2] ?? "worker";
  const config = loadConfig();
  const application = new ChatIntelligenceApplication(config);

  if (command === "install-launch-agent") {
    const entryPoint = resolve(process.cwd(), "dist", "index.js");
    if (!existsSync(entryPoint)) {
      application.close();
      throw new Error("Build first with `npm run build`; LaunchAgent runs the compiled worker, never a browser tab.");
    }
    const path = installLaunchAgent(process.execPath, entryPoint, config);
    application.logger.write({ level: "info", event: "launch_agent_written", metadata: { path } });
    application.close();
    return;
  }

  if (command === "export-local") {
    const destination = process.env.WCI_EXPORT_DIR;
    if (!destination) {
      application.close();
      throw new Error("Set WCI_EXPORT_DIR to a new directory outside WCI_DATA_DIR before exporting");
    }
    const path = application.exportLocalData(destination);
    application.logger.write({ level: "info", event: "local_export_created", metadata: { path } });
    application.close();
    return;
  }

  if (command === "erase-local") {
    if (process.env.WCI_CONFIRM_ERASE_LOCAL_INSTANCE !== "true") {
      application.close();
      throw new Error("Set WCI_CONFIRM_ERASE_LOCAL_INSTANCE=true to erase only this configured local instance");
    }
    await application.destroyLocalInstance();
    application.logger.write({ level: "info", event: "local_instance_erased" });
    return;
  }

  if (command === "import-chat-export") {
    const sourcePath = process.env.WCI_CHAT_EXPORT_PATH;
    const chatId = process.env.WCI_CHAT_EXPORT_CHAT_ID;
    if (!sourcePath || !chatId) {
      application.close();
      throw new Error("Set WCI_CHAT_EXPORT_PATH and WCI_CHAT_EXPORT_CHAT_ID before importing a local chat export");
    }
    if (!isAbsolute(sourcePath)) {
      application.close();
      throw new Error("WCI_CHAT_EXPORT_PATH must be an absolute local file path");
    }
    if (process.env.WCI_CONFIRM_CHAT_EXPORT_IMPORT !== "true") {
      application.close();
      throw new Error("Set WCI_CONFIRM_CHAT_EXPORT_IMPORT=true after reviewing the selected local export and allowlisted chat");
    }
    const rawDateOrder = process.env.WCI_CHAT_EXPORT_DATE_ORDER?.trim().toLowerCase() ?? "auto";
    if (rawDateOrder !== "auto" && rawDateOrder !== "dmy" && rawDateOrder !== "mdy") {
      application.close();
      throw new Error("WCI_CHAT_EXPORT_DATE_ORDER must be auto, dmy, or mdy");
    }
    const ownSenderLabel = process.env.WCI_CHAT_EXPORT_SELF_SENDER?.trim();
    await application.importChatExport({
      filePath: sourcePath,
      chatId,
      dateOrder: rawDateOrder as ChatExportDateOrder,
      ...(ownSenderLabel ? { ownSenderLabel } : {})
    });
    application.close();
    return;
  }

  if (command === "dashboard" || command === "personal-setup") {
    const requestedPort = Number.parseInt(process.env.WCI_DASHBOARD_PORT ?? "8787", 10);
    const dashboard = await startDashboard(application, Number.isSafeInteger(requestedPort) ? requestedPort : 8787);
    application.logger.write({ level: "info", event: "dashboard_started", metadata: { port: dashboard.port } });
    if (command === "personal-setup") {
      const startResult = await application.getPersonalLinkedDeviceAdapter().start();
      application.logger.write({ level: startResult.started ? "info" : "warn", event: "personal_setup_start_result", metadata: { started: startResult.started, reason: startResult.reason } });
      if (startResult.started) application.startReminderLoop();
    }
    const shutdown = () => {
      void dashboard.close().finally(() => application.shutdown());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  if (command !== "worker") {
    application.close();
    throw new Error(`Unknown command: ${command}`);
  }

  application.startReminderLoop();
  const liveStart = await application.startLivePersonalIngest();
  application.logger.write({
    level: "info",
    event: "worker_started",
    metadata: {
      liveImportEnabled: application.health().liveImportEnabled,
      browserRequired: false,
      personalAdapterStarted: liveStart?.started === true
    }
  });
  const recover = () => { void application.recoverAfterWake(); };
  process.on("SIGCONT", recover);
  const shutdown = () => { void application.shutdown(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void run().catch((error: unknown) => {
  // Do not include configuration or payload values in failure output.
  console.error(error instanceof Error ? error.message : "Worker failed");
  process.exitCode = 1;
});
