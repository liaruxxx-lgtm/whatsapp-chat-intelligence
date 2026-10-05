import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { launchAgentPlist } from "../src/runtime/launch-agent.js";

describe("LaunchAgent configuration", () => {
  it("runs the compiled browser-independent worker and only references a local runtime env file", () => {
    const config = loadConfig({
      WCI_DATA_DIR: "/private/tmp/wci-launch-agent-test",
      WCI_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 5).toString("base64")
    });
    const plist = launchAgentPlist("/usr/local/bin/node", "/opt/wci/dist/index.js", config);
    expect(plist).toContain("--env-file-if-exists=/private/tmp/wci-launch-agent-test/runtime.env");
    expect(plist).toContain("/opt/wci/dist/index.js");
    expect(plist).toContain("<string>worker</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).not.toContain(config.encryptionKeyBase64);
    expect(plist).not.toContain("dashboard");
  });
});
