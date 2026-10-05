import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PAIRING_QR_DISPLAY_WINDOW_MS, startDashboard } from "../src/dashboard/server.js";
import { ChatIntelligenceApplication } from "../src/runtime/application.js";
import { MemoryNotificationAdapter } from "../src/notifications/notification-adapter.js";
import { MemorySafeLogger } from "../src/security/logger.js";

const capability = "rNlkJQG4MM-MZO5IoVy3mbTYbBBdO5mQZeM3cf1LHGc";
const encryptionKey = Buffer.alloc(32, 13).toString("base64");
const disposers: Array<() => Promise<void> | void> = [];

type PairingState = "not_started" | "awaiting_qr" | "finishing_login" | "connected" | "reconnecting";

interface MutablePairingSnapshot {
  qr: string | undefined;
  issuedAt: string | undefined;
  generation: number;
  requiresImmediateDisplay: boolean;
  state: PairingState;
}

interface PairingDashboardOptions {
  readonly snapshot?: Partial<MutablePairingSnapshot>;
  readonly availableChats?: ReadonlyArray<{ id: string; kind: "individual" | "group"; label?: string }>;
  readonly refreshAvailableChats?: () => Promise<{ refreshed: boolean; reason?: string }>;
}

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

async function dashboardFixture(): Promise<{
  app: ChatIntelligenceApplication;
  baseUrl: string;
}> {
  const directory = mkdtempSync(join(tmpdir(), "wci-dashboard-security-"));
  const config = loadConfig({
    WCI_DATA_DIR: directory,
    WCI_ENCRYPTION_KEY_BASE64: encryptionKey,
    WCI_LIVE_IMPORT_ENABLED: "false",
    WCI_KILL_SWITCH: "false"
  });
  const app = new ChatIntelligenceApplication(config, {
    notificationAdapter: new MemoryNotificationAdapter(),
    logger: new MemorySafeLogger()
  });
  const dashboard = await startDashboard(app, 0, { capability });
  disposers.push(async () => {
    await dashboard.close();
    app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, baseUrl: `http://127.0.0.1:${dashboard.port}` };
}

async function pairingDashboardFixture(options: PairingDashboardOptions = {}): Promise<{
  baseUrl: string;
  issuedAt: string;
  snapshot: MutablePairingSnapshot;
}> {
  const pairingSecret = "private-pairing-code-that-must-not-be-json";
  const issuedAt = new Date().toISOString();
  const snapshot: MutablePairingSnapshot = {
    qr: pairingSecret,
    issuedAt,
    generation: 7,
    requiresImmediateDisplay: false,
    state: "awaiting_qr",
    ...options.snapshot
  };
  // The route only needs this narrow read-only presentation surface. Keeping
  // the QR source out of the expected response object verifies that it is
  // encoded directly to the protected image rather than serialized as JSON.
  const application = {
    health: () => ({ status: "ready", adapter: "synthetic", liveImportEnabled: false, allowlistedChatCount: 0 }),
    store: {
      listAllowlistedChats: () => [],
      removeFromAllowlist: () => undefined
    },
    pipeline: { addAllowedChat: () => undefined },
    getAvailableChats: () => options.availableChats ?? [],
    ...(options.refreshAvailableChats === undefined ? {} : { refreshAvailableChats: options.refreshAvailableChats }),
    getPairingQrSnapshot: () => snapshot
  } as unknown as ChatIntelligenceApplication;
  const dashboard = await startDashboard(application, 0, { capability });
  disposers.push(() => dashboard.close());
  return { baseUrl: `http://127.0.0.1:${dashboard.port}`, issuedAt, snapshot };
}

function writeHeaders(origin: string, suppliedCapability?: string, contentType = "application/json"): HeadersInit {
  const headers: Record<string, string> = { origin, "content-type": contentType };
  if (suppliedCapability) headers["x-wci-dashboard-capability"] = suppliedCapability;
  return headers;
}

function requestWithHost(url: string, host: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: { host }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end();
  });
}

function embeddedDashboardScript(page: string): string {
  const match = page.match(/<script>([\s\S]+)<\/script>/);
  if (!match) throw new Error("dashboard script missing");
  return match[1];
}

describe("local dashboard allowlist mutations", () => {
  it("does not allow another origin to frame the capability-bearing local page", async () => {
    const { baseUrl } = await dashboardFixture();
    const page = await fetch(baseUrl);

    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a non-loopback Host header even for a read-only route", async () => {
    const { baseUrl } = await dashboardFixture();
    const response = await requestWithHost(`${baseUrl}/api/health`, "attacker.invalid");

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: "loopback_host_required" });
  });

  it("presents the QR only as a loopback image with local freshness metadata, never as QR source JSON", async () => {
    const { baseUrl, issuedAt, snapshot } = await pairingDashboardFixture();
    const response = await fetch(`${baseUrl}/api/setup/pairing-qr`);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toMatchObject({
      status: "pairing_qr_available",
      issuedAt,
      generation: 7,
      pairingState: "awaiting_qr",
      requiresImmediateDisplay: false,
      displayWindowMs: PAIRING_QR_DISPLAY_WINDOW_MS
    });
    expect(typeof payload.dataUrl).toBe("string");
    expect((payload.dataUrl as string).startsWith("data:image/png;base64,")).toBe(true);
    expect(payload).not.toHaveProperty("qr");
    expect(payload).not.toHaveProperty("expiresAt");
    expect(payload).not.toHaveProperty("whatsAppExpiresAt");
    expect(Date.parse(payload.displayWindowEndsAt as string)).toBe(Date.parse(issuedAt) + PAIRING_QR_DISPLAY_WINDOW_MS);

    snapshot.requiresImmediateDisplay = true;
    const refreshedPayload = await (await fetch(`${baseUrl}/api/setup/pairing-qr`)).json() as Record<string, unknown>;
    expect(refreshedPayload.requiresImmediateDisplay).toBe(true);

    // The endpoint keeps receipt metadata for diagnostics. The browser timer
    // starts when it actually displays the image and buffers early rotations.
    snapshot.issuedAt = new Date(Date.parse(issuedAt) + 11_000).toISOString();
    snapshot.generation = 8;
    snapshot.qr = "different-private-pairing-code";
    const refreshed = await (await fetch(`${baseUrl}/api/setup/pairing-qr`)).json() as Record<string, unknown>;
    expect(refreshed).toMatchObject({ issuedAt: snapshot.issuedAt, generation: 8 });
    expect(Date.parse(refreshed.displayWindowEndsAt as string)).toBe(
      Date.parse(snapshot.issuedAt) + PAIRING_QR_DISPLAY_WINDOW_MS
    );
  });

  it("labels the countdown as a conservative local display window rather than a WhatsApp TTL", async () => {
    const { baseUrl } = await dashboardFixture();
    const page = await (await fetch(baseUrl)).text();

    expect(page).toContain("Lokales 30-Sekunden-Fenster");
    expect(page).toContain("Keine WhatsApp-Gültigkeitsgarantie.");
    expect(page).toContain("ein von WhatsApp verlangter Sicherheitsrefresh erscheint sofort");
    expect(page).toContain("pendingQrPayload");
    expect(page).toContain("countdownColor");
    expect(page).toContain("displayWindowEndsAtMs=Date.now()+displayWindowMs");
    expect(page).not.toContain("displayWindowEndsAtMs=endsAt");
    expect(() => new Function(embeddedDashboardScript(page))).not.toThrow();
    // The app's QR image begins without a source. Its explicit hidden rule
    // prevents the browser from rendering a broken-image icon while setup is
    // still waiting for a real QR generation.
    expect(page).toContain(".qr-frame img[hidden]{display:none}");
    expect(page).toContain("Gerät gekoppelt");
    expect(page).toContain("WhatsApp hat den Scan bestätigt");
  });

  it("buffers an early QR rotation until the visible 30-second window ends", async () => {
    const { baseUrl } = await dashboardFixture();
    const page = await (await fetch(baseUrl)).text();
    // Keep this focused on the QR state machine. Dashboard bootstrap also
    // starts health, summary-provider, and chat-list requests; those require
    // real DOM nodes and are covered by the route/connected-state tests below.
    const script = embeddedDashboardScript(page).replace(/void loadHealth\(\);void loadQr\(\);[\s\S]*$/, "");
    let now = 1_000;
    const elements = new Map<string, {
      hidden: boolean;
      textContent: string;
      src: string;
      dataset: Record<string, string>;
      style: { values: Record<string, string>; setProperty(name: string, value: string): void };
      removeAttribute(name: string): void;
      addEventListener(): void;
    }>();
    const createElement = () => {
      const element = {
        hidden: false,
        textContent: "",
        src: "",
        dataset: {},
        style: {
          values: {},
          setProperty(name: string, value: string): void {
            this.values[name] = value;
          }
        },
        removeAttribute(): void {
          this.src = "";
        },
        addEventListener(): void {
          // No interaction is needed for the countdown state machine.
        }
      };
      return element;
    };
    for (const id of [
      "qr", "qr-empty", "qr-countdown", "qr-generation", "qr-status", "qr-progress", "pairing-qr-flow",
      "pairing-result", "pairing-result-title", "pairing-result-detail", "chats", "chat-status", "chat-list",
      "manual-chat-form", "manual-chat-id", "manual-chat-submit", "manual-chat-feedback", "allowlist-summary",
      "health-status", "health-allowlist", "health-live", "health-gates", "health-summary"
    ]) {
      elements.set(id, createElement());
    }
    const fakeDocument = {
      querySelector(selector: string) {
        return elements.get(selector.slice(1));
      }
    };
    const fakeWindow = { setInterval: () => 0 };
    const fakeFetch = async () => ({ ok: false, json: async () => ({}) });
    const dashboard = new Function("document", "window", "fetch", "Date", `${script}\nreturn { showQrPayload, renderQrCountdown, getState: () => ({ activeQrGeneration, pendingQrPayload, displayWindowEndsAtMs, countdown: qrCountdown.textContent, image: qrImage.src, color: qrProgress.style.values["--progress-color"], status: qrStatus.textContent }) };`)(
      fakeDocument,
      fakeWindow,
      fakeFetch,
      { now: () => now }
    ) as {
      showQrPayload(payload: Record<string, unknown>): void;
      renderQrCountdown(): void;
      getState(): { activeQrGeneration: number; pendingQrPayload: unknown; displayWindowEndsAtMs: number; countdown: string; image: string; color: string; status: string };
    };
    const payload = (generation: number, issuedAt: string, image: string, requiresImmediateDisplay = false) => ({
      pairingState: "awaiting_qr",
      dataUrl: image,
      issuedAt,
      generation,
      requiresImmediateDisplay,
      displayWindowEndsAt: new Date(now + 30_000).toISOString(),
      serverNow: new Date(now).toISOString(),
      displayWindowMs: 30_000
    });

    dashboard.showQrPayload(payload(1, "2026-09-22T10:00:00.000Z", "data:image/png;base64,first"));
    expect(dashboard.getState()).toMatchObject({ countdown: "00:30", activeQrGeneration: 1, image: "data:image/png;base64,first" });

    now = 22_000;
    dashboard.showQrPayload(payload(2, "2026-09-22T10:00:30.000Z", "data:image/png;base64,second"));
    expect(dashboard.getState()).toMatchObject({ countdown: "00:09", activeQrGeneration: 1, image: "data:image/png;base64,first" });
    expect(dashboard.getState().pendingQrPayload).not.toBeNull();

    now = 31_000;
    dashboard.renderQrCountdown();
    expect(dashboard.getState()).toMatchObject({ countdown: "00:30", activeQrGeneration: 2, image: "data:image/png;base64,second", color: "hsl(120 78% 50%)" });
    expect(dashboard.getState().pendingQrPayload).toBeNull();

    now = 32_000;
    dashboard.showQrPayload(payload(3, "2026-09-22T10:01:00.000Z", "data:image/png;base64,refreshed", true));
    expect(dashboard.getState()).toMatchObject({
      countdown: "00:30",
      activeQrGeneration: 3,
      image: "data:image/png;base64,refreshed",
      pendingQrPayload: null,
      status: "WhatsApp hat den QR sicherheitsbedingt erneuert. Bitte scanne jetzt den angezeigten Code."
    });
  });

  it("rejects cross-origin/simple and capability-less writes before they can expand the allowlist", async () => {
    const { app, baseUrl } = await dashboardFixture();
    const chatId = "491700000001@s.whatsapp.net";

    const crossOriginFormStyle = await fetch(`${baseUrl}/api/allowlist`, {
      method: "POST",
      headers: writeHeaders("https://attacker.example", undefined, "text/plain"),
      body: JSON.stringify({ chatId })
    });
    expect(crossOriginFormStyle.status).toBe(403);
    expect(app.store.isAllowlisted(chatId)).toBe(false);

    const noCapability = await fetch(`${baseUrl}/api/allowlist`, {
      method: "POST",
      headers: writeHeaders(baseUrl),
      body: JSON.stringify({ chatId })
    });
    expect(noCapability.status).toBe(403);
    expect(app.store.isAllowlisted(chatId)).toBe(false);

    // Even a caller that knows the capability cannot use it from another
    // browser origin; browser CORS preflight is also absent by design.
    const crossOriginWithCapability = await fetch(`${baseUrl}/api/allowlist`, {
      method: "POST",
      headers: writeHeaders("https://attacker.example", capability),
      body: JSON.stringify({ chatId })
    });
    expect(crossOriginWithCapability.status).toBe(403);
    expect(app.store.isAllowlisted(chatId)).toBe(false);
  });

  it("accepts only same-origin JSON writes with the process capability and protects deletes too", async () => {
    const { app, baseUrl } = await dashboardFixture();
    const chatId = "491700000001@s.whatsapp.net";

    const nonJson = await fetch(`${baseUrl}/api/allowlist`, {
      method: "POST",
      headers: writeHeaders(baseUrl, capability, "text/plain"),
      body: JSON.stringify({ chatId })
    });
    expect(nonJson.status).toBe(415);
    expect(app.store.isAllowlisted(chatId)).toBe(false);

    const accepted = await fetch(`${baseUrl}/api/allowlist`, {
      method: "POST",
      headers: writeHeaders(baseUrl, capability),
      body: JSON.stringify({ chatId })
    });
    expect(accepted.status).toBe(201);
    expect(app.store.isAllowlisted(chatId)).toBe(true);

    const untrustedDelete = await fetch(`${baseUrl}/api/allowlist/${encodeURIComponent(chatId)}`, {
      method: "DELETE",
      headers: writeHeaders("https://attacker.example", capability)
    });
    expect(untrustedDelete.status).toBe(403);
    expect(app.store.isAllowlisted(chatId)).toBe(true);

    const acceptedDelete = await fetch(`${baseUrl}/api/allowlist/${encodeURIComponent(chatId)}`, {
      method: "DELETE",
      headers: writeHeaders(baseUrl, capability)
    });
    expect(acceptedDelete.status).toBe(200);
    expect(app.store.isAllowlisted(chatId)).toBe(false);
  });
});

describe("personal setup flow after pairing", () => {
  it("transitions from a displayed QR through login completion to empty chat selection", async () => {
    const { baseUrl } = await dashboardFixture();
    const page = await (await fetch(baseUrl)).text();
    const script = embeddedDashboardScript(page).replace(/void loadHealth\(\);void loadQr\(\);[\s\S]*$/, "");
    type FakeElement = {
      hidden: boolean;
      textContent: string;
      src: string;
      value: string;
      disabled: boolean;
      dataset: Record<string, string>;
      children: FakeElement[];
      style: { setProperty(name: string, value: string): void };
      removeAttribute(name: string): void;
      addEventListener(): void;
      replaceChildren(...children: FakeElement[]): void;
      appendChild(child: FakeElement): void;
      append(...children: FakeElement[]): void;
    };
    const elements = new Map<string, FakeElement>();
    const createElement = (): FakeElement => ({
      hidden: false,
      textContent: "",
      src: "",
      value: "",
      disabled: false,
      dataset: {},
      children: [],
      style: { setProperty: () => undefined },
      removeAttribute(name) { if (name === "src") this.src = ""; },
      addEventListener: () => undefined,
      replaceChildren(...children) { this.children = [...children]; },
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); }
    });
    const fakeDocument = {
      querySelector(selector: string): FakeElement {
        const id = selector.slice(1);
        let element = elements.get(id);
        if (!element) {
          element = createElement();
          elements.set(id, element);
        }
        return element;
      },
      createElement: () => createElement()
    };
    const emptyListFetch = async (url: string) => ({
      ok: true,
      json: async () => url === "/api/setup/available-chats" ? [] : []
    });
    const fakeWindow = { setInterval: () => 0, prompt: () => null, confirm: () => false };
    const dashboard = new Function(
      "document",
      "window",
      "fetch",
      `${script}\nreturn { renderPairingState, showQrPayload, loadChats, loadAllowlist };`
    )(fakeDocument, fakeWindow, emptyListFetch) as {
      renderPairingState(payload: Record<string, unknown>): void;
      showQrPayload(payload: Record<string, unknown>): void;
      loadChats(): Promise<void>;
      loadAllowlist(): Promise<void>;
    };
    const element = (id: string) => elements.get(id)!;
    element("qr").hidden = true;
    element("pairing-result").hidden = true;
    element("chats").hidden = true;

    dashboard.showQrPayload({
      pairingState: "awaiting_qr",
      dataUrl: "data:image/png;base64,fixture",
      issuedAt: new Date().toISOString(),
      generation: 1,
      requiresImmediateDisplay: false,
      displayWindowEndsAt: new Date(Date.now() + PAIRING_QR_DISPLAY_WINDOW_MS).toISOString(),
      serverNow: new Date().toISOString(),
      displayWindowMs: PAIRING_QR_DISPLAY_WINDOW_MS
    });
    expect(element("pairing-qr-flow").hidden).toBe(false);
    expect(element("qr").hidden).toBe(false);

    dashboard.renderPairingState({ pairingState: "finishing_login", generation: 1 });
    expect(element("pairing-qr-flow").hidden).toBe(true);
    expect(element("qr").hidden).toBe(true);
    expect(element("pairing-result").hidden).toBe(false);
    expect(element("pairing-result-title").textContent).toBe("Kopplung wird abgeschlossen.");
    expect(element("chats").hidden).toBe(true);

    dashboard.renderPairingState({ pairingState: "connected", generation: 1 });
    await Promise.all([dashboard.loadChats(), dashboard.loadAllowlist()]);
    expect(element("pairing-qr-flow").hidden).toBe(true);
    expect(element("qr").hidden).toBe(true);
    expect(element("pairing-result").hidden).toBe(false);
    expect(element("pairing-result-title").textContent).toBe("Gerät gekoppelt – Verbindung steht.");
    expect(element("chats").hidden).toBe(false);
    expect(element("chat-list").children).toHaveLength(0);
    expect(element("chat-status").textContent).toContain("WhatsApp hat noch keine Chatliste geliefert.");
    expect(element("manual-chat-form").hidden).toBe(false);
  });

  it("moves a connected, QR-free setup state to the success and chat-selection UI", async () => {
    const { baseUrl } = await pairingDashboardFixture({
      snapshot: { qr: undefined, issuedAt: undefined, generation: 7, state: "connected" },
      availableChats: []
    });

    const pairingResponse = await fetch(`${baseUrl}/api/setup/pairing-qr`);
    const pairing = await pairingResponse.json() as Record<string, unknown>;
    expect(pairingResponse.status).toBe(404);
    expect(pairing).toMatchObject({
      status: "waiting_for_pairing_qr",
      generation: 7,
      pairingState: "connected"
    });
    expect(pairing).not.toHaveProperty("qr");
    expect(pairing).not.toHaveProperty("dataUrl");

    const availableChats = await (await fetch(`${baseUrl}/api/setup/available-chats`)).json();
    expect(availableChats).toEqual([]);

    const page = await (await fetch(baseUrl)).text();
    const script = embeddedDashboardScript(page);
    expect(page).toContain('id="pairing-qr-flow"');
    expect(page).toContain('id="pairing-result"');
    expect(page).toContain('id="pairing-result-title"');
    expect(page).toContain('id="chats"');
    expect(page).toContain("Gerät gekoppelt – Verbindung steht.");
    expect(page).toContain("Chats auswählen");
    expect(script).toContain("function renderPairingState(payload)");
    expect(script).toMatch(/pairingState\s*===\s*['"]connected['"]/);
    // The connected branch must hide the complete QR flow, including the
    // waiting placeholder, and reveal the next setup step even when the
    // discovery endpoint has not yielded a chat yet.
    expect(script).toMatch(/pairingQrFlow\.hidden\s*=\s*true/);
    expect(script).toMatch(/qrEmpty\.hidden\s*=\s*true/);
    expect(script).toMatch(/pairingResult\.hidden\s*=\s*false/);
    expect(script).toMatch(/chatsSection\.hidden\s*=\s*false/);
    expect(script).toMatch(/loadChats\(\)/);
  });

  it("keeps an empty discovered-chat list empty and presents a deliberate manual JID fallback", async () => {
    const { baseUrl } = await pairingDashboardFixture({
      snapshot: { qr: undefined, issuedAt: undefined, state: "connected" },
      availableChats: []
    });

    const response = await fetch(`${baseUrl}/api/setup/available-chats`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);

    const page = await (await fetch(baseUrl)).text();
    const script = embeddedDashboardScript(page);
    expect(page).toContain('id="chat-status"');
    expect(page).toContain("WhatsApp hat noch keine Chatliste geliefert.");
    expect(page).toContain('id="manual-chat-form"');
    expect(page).toContain('id="manual-chat-id"');
    expect(page).toContain('id="manual-chat-submit"');
    expect(page).toContain("Bekannte Chat-JID manuell eingeben");
    expect(script).toContain("function loadChats()");
    // Empty discovery is an informational state. The client must not turn it
    // into a bulk mutation or fabricate an entry to keep the UI populated.
    expect(script).not.toContain("Alle Chats erlauben");
    expect(script).not.toContain("allowAllChats");
  });

  it("shows a real @g.us group name, keeps the group JID, and refreshes through the protected endpoint", async () => {
    let refreshCalls = 0;
    const group = { id: "120363000000000001@g.us", kind: "group" as const, label: "Familiengruppe" };
    const setup = await pairingDashboardFixture({
      snapshot: { qr: undefined, issuedAt: undefined, state: "connected" },
      availableChats: [group],
      refreshAvailableChats: async () => {
        refreshCalls += 1;
        return { refreshed: true };
      }
    });

    const refresh = await fetch(setup.baseUrl + "/api/setup/available-chats/refresh", {
      method: "POST",
      headers: writeHeaders(setup.baseUrl, capability),
      body: "{}"
    });
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toEqual({ refreshed: true });
    expect(refreshCalls).toBe(1);

    expect(await (await fetch(setup.baseUrl + "/api/setup/available-chats")).json()).toEqual([group]);
    const page = await (await fetch(setup.baseUrl)).text();
    expect(page).toContain("Chatliste aktualisieren");
    expect(page).toContain("Bereits geschriebene Nachrichten einmalig importieren");
    expect(page).toContain("Gruppenname nicht verfügbar");
    expect(page).toContain("/api/history-import");
  });

  it("renders discovered chats as individually allowable and updates only the selected allowlist entry", async () => {
    const firstChat = { id: "491700000101@s.whatsapp.net", kind: "individual" as const, label: "Erster Chat" };
    const secondChat = { id: "491700000102@s.whatsapp.net", kind: "individual" as const, label: "Zweiter Chat" };
    const setup = await pairingDashboardFixture({
      snapshot: { qr: undefined, issuedAt: undefined, state: "connected" },
      availableChats: [firstChat, secondChat]
    });

    const discovered = await (await fetch(`${setup.baseUrl}/api/setup/available-chats`)).json();
    expect(discovered).toEqual([firstChat, secondChat]);

    const page = await (await fetch(setup.baseUrl)).text();
    const script = embeddedDashboardScript(page);
    expect(page).toContain("Diesen Chat erlauben");
    expect(page).toContain('id="allowlist-summary"');
    expect(page).toContain("Die Auswahl aktualisiert die Allowlist.");
    expect(page).toContain("bereit nach Chatauswahl");
    expect(page).toContain("Kopplung ist möglich. Wähle danach mindestens einen Chat einzeln aus");
    expect(page).toContain("noch kein Chat ausgewählt");
    expect(script).toContain("function allowChat(chatId,button)");
    expect(script).toContain("function loadAllowlist()");
    expect(script).not.toContain("Alle Chats erlauben");

    const { app, baseUrl } = await dashboardFixture();
    expect(app.store.listAllowlistedChats()).toEqual([]);

    const selection = await fetch(`${baseUrl}/api/allowlist`, {
      method: "POST",
      headers: writeHeaders(baseUrl, capability),
      body: JSON.stringify({ chatId: firstChat.id })
    });
    expect(selection.status).toBe(201);
    expect(app.store.isAllowlisted(firstChat.id)).toBe(true);
    expect(app.store.isAllowlisted(secondChat.id)).toBe(false);
    expect(await (await fetch(`${baseUrl}/api/allowlist`)).json()).toEqual([{ id: firstChat.id, kind: "individual" }]);

    const health = await (await fetch(`${baseUrl}/api/health`)).json() as Record<string, unknown>;
    expect(health).toMatchObject({ allowlistedChatCount: 1, liveImportEnabled: false });
    expect(health.liveGateReasons).toContain("LIVE_IMPORT_ENABLED is not true");
  });
});
