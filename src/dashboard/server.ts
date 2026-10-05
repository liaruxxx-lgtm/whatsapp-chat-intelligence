import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage as HttpIncomingMessage, type ServerResponse } from "node:http";
import QRCode from "qrcode";
import { ChatSummaryError, PersonalHistoryImportError, type ChatIntelligenceApplication, type PairingQrSnapshot } from "../runtime/application.js";

const MAX_BODY_BYTES = 8_192;
const CAPABILITY_HEADER = "x-wci-dashboard-capability";
/**
 * This is deliberately only a short local presentation window. Baileys does
 * not provide a trustworthy WhatsApp QR TTL, so it must never be presented as
 * one or used to force a socket rotation.
 */
export const PAIRING_QR_DISPLAY_WINDOW_MS = 30_000;
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

export interface DashboardOptions {
  /**
   * A local capability intended for controlled embedding/tests. In ordinary
   * operation it is omitted and a fresh, process-local capability is created.
   */
  capability?: string;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: HttpIncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_json");
  return decoded as Record<string, unknown>;
}

function createCapability(configuredCapability: string | undefined): string {
  if (configuredCapability === undefined) return randomBytes(32).toString("base64url");
  const capability = configuredCapability.trim();
  // Restrict configured values to the URL/header-safe format generated above,
  // rather than allowing a value that could escape the HTML script context.
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(capability)) {
    throw new Error("Dashboard capability must be a 32-256 character base64url value");
  }
  return capability;
}

function capabilityMatches(request: HttpIncomingMessage, capability: string): boolean {
  const supplied = request.headers[CAPABILITY_HEADER];
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(capability);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function hasJsonContentType(request: HttpIncomingMessage): boolean {
  const value = request.headers["content-type"];
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function allowedDashboardOrigins(port: number): Set<string> {
  const portSuffix = port === 80 ? "" : `:${port}`;
  // localhost is retained for ordinary local browser use; the server itself is
  // still bound exclusively to the IPv4 loopback address.
  return new Set([`http://127.0.0.1${portSuffix}`, `http://localhost${portSuffix}`]);
}

/** Reject DNS-rebinding/non-loopback Host headers even for read-only QR/status routes. */
function allowedDashboardHosts(port: number): Set<string> {
  const portSuffix = port === 80 ? "" : `:${port}`;
  return new Set([`127.0.0.1${portSuffix}`, `localhost${portSuffix}`]);
}

function hasExpectedDashboardHost(request: HttpIncomingMessage, trustedHosts: ReadonlySet<string>): boolean {
  const host = request.headers.host;
  return typeof host === "string" && trustedHosts.has(host.toLocaleLowerCase("en-US"));
}

function isExpectedSameOrigin(request: HttpIncomingMessage, trustedOrigins: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string" || !trustedOrigins.has(origin)) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function mutationRejection(
  request: HttpIncomingMessage,
  trustedOrigins: ReadonlySet<string>,
  capability: string
): { status: number; error: string } | undefined {
  // A form POST is rejected before body parsing: it lacks the exact Origin,
  // JSON type, and unguessable capability header required by this endpoint.
  if (!isExpectedSameOrigin(request, trustedOrigins)) return { status: 403, error: "same_origin_required" };
  if (!capabilityMatches(request, capability)) return { status: 403, error: "dashboard_capability_required" };
  if (!hasJsonContentType(request)) return { status: 415, error: "application_json_required" };
  return undefined;
}

type PairingQrFreshness = "within_display_window" | "display_window_elapsed";

interface PairingQrPresentationMetadata {
  readonly issuedAt: string;
  readonly generation: number;
  readonly requiresImmediateDisplay: boolean;
  readonly pairingState: PairingQrSnapshot["state"];
  readonly serverNow: string;
  readonly displayWindowMs: number;
  readonly displayWindowEndsAt: string;
  readonly freshness: PairingQrFreshness;
}

function pairingQrPresentationMetadata(
  snapshot: PairingQrSnapshot,
  now = new Date()
): PairingQrPresentationMetadata | undefined {
  if (snapshot.issuedAt === undefined) return undefined;
  const issuedAtMs = Date.parse(snapshot.issuedAt);
  if (!Number.isFinite(issuedAtMs)) return undefined;
  const displayWindowEndsAtMs = issuedAtMs + PAIRING_QR_DISPLAY_WINDOW_MS;
  return {
    issuedAt: snapshot.issuedAt,
    generation: snapshot.generation,
    requiresImmediateDisplay: snapshot.requiresImmediateDisplay,
    pairingState: snapshot.state,
    serverNow: now.toISOString(),
    displayWindowMs: PAIRING_QR_DISPLAY_WINDOW_MS,
    displayWindowEndsAt: new Date(displayWindowEndsAtMs).toISOString(),
    freshness: now.getTime() < displayWindowEndsAtMs ? "within_display_window" : "display_window_elapsed"
  };
}

function dashboardPage(capability: string): string {
  const serializedCapability = JSON.stringify(capability).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="de">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Chat Intelligence</title>
<style>
  :root{color-scheme:light dark;--canvas:#f5f5f7;--surface:rgba(255,255,255,.78);--surface-solid:#fff;--ink:#1d1d1f;--muted:#6e6e73;--line:rgba(60,60,67,.16);--blue:#0a84ff;--green:#34c759;--yellow:#ffd60a;--orange:#ff9f0a;--red:#ff3b30;--track:#d9d9de;--shadow:0 14px 34px rgba(0,0,0,.08),0 2px 6px rgba(0,0,0,.04)}
  @media (prefers-color-scheme:dark){:root{--canvas:#000;--surface:rgba(28,28,30,.78);--surface-solid:#1c1c1e;--ink:#f5f5f7;--muted:#98989f;--line:rgba(235,235,245,.18);--blue:#0a84ff;--green:#30d158;--yellow:#ffd60a;--orange:#ff9f0a;--red:#ff453a;--track:#45454a;--shadow:0 16px 38px rgba(0,0,0,.34),0 1px 2px rgba(255,255,255,.04) inset}}
  *{box-sizing:border-box}body{min-width:320px;margin:0;background:radial-gradient(900px 500px at 50% -150px,rgba(10,132,255,.13),transparent 65%),var(--canvas);color:var(--ink);font:17px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;letter-spacing:-.01em}.app-shell{width:min(760px,calc(100% - 32px));margin:0 auto;padding:56px 0 72px}.eyebrow{margin:0 0 8px;color:var(--blue);font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.title{margin:0;font-size:34px;line-height:1.2;letter-spacing:-.026em}.subtitle{max-width:570px;margin:10px 0 28px;color:var(--muted);font-size:16px;line-height:1.35}.card{margin-top:16px;padding:24px;border:1px solid var(--line);border-radius:24px;background:var(--surface);box-shadow:var(--shadow);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%)}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.section-heading h2{margin:0;font-size:22px;line-height:1.25;letter-spacing:-.018em}.section-heading p{margin:6px 0 0;color:var(--muted);font-size:15px;line-height:1.35}.health-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:18px}.metric{min-width:0;padding:14px;border-radius:16px;background:rgba(120,120,128,.10)}.metric-label{display:block;color:var(--muted);font-size:12px;letter-spacing:.01em}.metric-value{display:block;margin-top:3px;overflow-wrap:anywhere;font-size:17px;font-weight:650;letter-spacing:-.012em}.health-gates{min-height:20px;margin:14px 0 0;color:var(--muted);font-size:13px;line-height:1.4}.pairing-layout{display:grid;grid-template-columns:256px minmax(0,1fr);align-items:center;gap:28px;margin-top:20px}.pairing-layout[hidden],.pairing-result[hidden],.chat-section[hidden]{display:none}.qr-frame{position:relative;display:grid;place-items:center;width:256px;height:256px;padding:12px;border:1px solid var(--line);border-radius:28px;background:var(--surface-solid);box-shadow:0 10px 28px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.04)}.qr-frame img{display:block;width:100%;height:100%;border-radius:18px;image-rendering:auto}.qr-frame img[hidden]{display:none}.qr-empty{padding:20px;color:var(--muted);font-size:15px;line-height:1.35;text-align:center}.timer-row{display:flex;align-items:center;gap:16px}.countdown-ring{--progress:0;--progress-color:var(--green);position:relative;display:grid;place-items:center;width:62px;height:62px;flex:0 0 auto;border-radius:50%;background:conic-gradient(var(--progress-color) calc(var(--progress) * 1%),var(--track) 0)}.countdown-ring::after{position:absolute;inset:6px;border-radius:50%;background:var(--surface-solid);content:""}.countdown-ring span{position:relative;z-index:1;width:8px;height:8px;border-radius:50%;background:var(--progress-color)}.timer-caption{margin:0;color:var(--muted);font-size:13px}.timer-value{display:block;margin-top:1px;font-variant-numeric:tabular-nums;font-size:28px;font-weight:700;letter-spacing:-.024em}.qr-generation{margin:22px 0 4px;font-size:15px;font-weight:650}.qr-status{min-height:44px;margin:0;color:var(--muted);font-size:15px;line-height:1.4}.qr-status[data-state="elapsed"]{color:var(--orange)}.pairing-result{margin-top:20px;padding:18px;border-radius:18px;background:rgba(52,199,89,.13)}.pairing-result strong{display:block;color:var(--green);font-size:17px;letter-spacing:-.012em}.pairing-result p{margin:5px 0 0;color:var(--muted);font-size:15px;line-height:1.4}.disclaimer{margin:18px 0 0;padding:12px 14px;border-radius:15px;background:rgba(10,132,255,.10);color:var(--muted);font-size:13px;line-height:1.4}.disclaimer strong{color:var(--ink)}.chat-status,.allowlist-summary{min-height:22px;margin:16px 0 0;color:var(--muted);font-size:15px;line-height:1.4}.chat-status[data-state="error"]{color:var(--orange)}.chat-list{display:grid;gap:10px;margin-top:16px}.chat-option{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 14px;border:1px solid var(--line);border-radius:16px;background:var(--surface-solid)}.chat-option-label{min-width:0;overflow-wrap:anywhere;font-size:15px;font-weight:600;letter-spacing:-.008em}.chat-button,.manual-chat-submit{min-height:44px;padding:10px 14px;border:1px solid rgba(10,132,255,.45);border-radius:14px;background:rgba(10,132,255,.12);color:var(--blue);font:600 15px/1.3 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;letter-spacing:-.008em;transition:transform .35s cubic-bezier(.25,1,.5,1),background .35s cubic-bezier(.25,1,.5,1),border-color .35s cubic-bezier(.25,1,.5,1)}.chat-button:hover,.manual-chat-submit:hover{border-color:var(--blue);background:rgba(10,132,255,.18)}.chat-button:active,.manual-chat-submit:active{transform:scale(.97)}.chat-button:focus-visible,.manual-chat-submit:focus-visible,.manual-chat-input:focus-visible{outline:3px solid rgba(10,132,255,.45);outline-offset:3px}.chat-button:disabled,.manual-chat-submit:disabled{color:var(--muted);border-color:var(--line);background:rgba(120,120,128,.10)}.manual-chat-form{display:grid;gap:8px;margin-top:20px;padding:16px;border:1px solid var(--line);border-radius:18px;background:rgba(120,120,128,.07)}.manual-chat-label{font-size:15px;font-weight:650;letter-spacing:-.008em}.manual-chat-help{margin:0;color:var(--muted);font-size:13px;line-height:1.4}.manual-chat-controls{display:flex;gap:10px}.manual-chat-input{min-width:0;min-height:44px;flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:var(--surface-solid);color:var(--ink);font:15px/1.3 ui-monospace,"SF Mono",Menlo,Monaco,Consolas,monospace}.manual-chat-feedback{min-height:18px;margin:0;color:var(--muted);font-size:13px;line-height:1.35}@media (max-width:620px){.app-shell{width:min(100% - 24px,760px);padding-top:32px}.title{font-size:28px}.card{padding:20px;border-radius:22px}.health-grid{grid-template-columns:1fr}.pairing-layout{grid-template-columns:1fr;gap:22px}.qr-frame{margin:0 auto}.section-heading{display:block}.chat-option,.manual-chat-controls{align-items:stretch;flex-direction:column}.chat-button,.manual-chat-submit{width:100%}}
</style>
<style>
  .summary-chat-option{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:14px;border:1px solid var(--line);border-radius:16px;background:var(--surface-solid)}
  .summary-chat-option .chat-option-label{min-width:0;overflow-wrap:anywhere;font-size:14px;font-weight:600}
  .summary-panel{grid-column:1/-1;padding-top:12px;border-top:1px solid var(--line);overflow-wrap:anywhere}
  .summary-panel[hidden]{display:none}
  .summary-panel h3{margin:0 0 6px;font-size:17px}
  .summary-panel p{margin:6px 0;font-size:14px;line-height:1.45}
  .summary-panel ul{margin:4px 0 12px;padding-left:20px;font-size:14px}
  .summary-panel li{margin:5px 0}
  .summary-meta,.summary-citations{color:var(--muted);font-size:12px!important}
  .summary-disclosure{margin:14px 0;padding:13px 15px;border-radius:15px;background:rgba(10,132,255,.10);color:var(--muted);font-size:13px;line-height:1.45}
  .summary-disclosure strong{color:var(--ink)}
  .summary-disclosure a{color:var(--blue)}
  @media (max-width:620px){.summary-chat-option{grid-template-columns:1fr}.summary-panel{grid-column:1}}
</style>
<main class="app-shell">
  <header>
    <p class="eyebrow">Privater lokaler Dienst</p>
    <h1 class="title">WhatsApp Chat Intelligence</h1>
    <p class="subtitle">Das Dashboard zeigt den lokalen Zustand. Empfang und Erinnerungen laufen unabhängig von diesem Fenster.</p>
  </header>
  <section class="card" aria-labelledby="health-title">
    <div class="section-heading"><div><h2 id="health-title">Dienststatus</h2><p id="health-summary" aria-live="polite">Status wird geladen…</p></div></div>
    <div class="health-grid"><div class="metric"><span class="metric-label">Status</span><strong id="health-status" class="metric-value">—</strong></div><div class="metric"><span class="metric-label">Allowlist</span><strong id="health-allowlist" class="metric-value">—</strong></div><div class="metric"><span class="metric-label">Live-Import</span><strong id="health-live" class="metric-value">—</strong></div></div>
    <p id="health-gates" class="health-gates"></p>
  </section>
  <section id="pairing" class="card" aria-labelledby="pairing-title">
    <div class="section-heading"><div><h2 id="pairing-title">Persönliches Gerät koppeln</h2><p>Der Code bleibt nur im Speicher dieses lokalen Setup-Prozesses.</p></div></div>
    <div id="pairing-qr-flow" class="pairing-layout">
      <div class="qr-frame"><img id="qr" alt="WhatsApp-Kopplungs-QR" hidden><p id="qr-empty" class="qr-empty">Pairing-Status wird geladen…</p></div>
      <div>
        <div class="timer-row"><div id="qr-progress" class="countdown-ring" style="--progress:0;--progress-color:var(--green)" aria-hidden="true"><span></span></div><div><p class="timer-caption">Lokales 30-Sekunden-Fenster</p><strong id="qr-countdown" class="timer-value">—</strong></div></div>
        <p id="qr-generation" class="qr-generation">Noch keine QR-Generation</p>
        <p id="qr-status" class="qr-status" data-state="waiting" aria-live="polite">Der Timer startet, sobald dieser Browser den QR-Code anzeigt.</p>
        <p class="disclaimer"><strong>Keine WhatsApp-Gültigkeitsgarantie.</strong> Der Timer startet beim Anzeigen im Browser. Regulär rotierte QR-Codes werden bis zum Ablauf des lokalen 30-Sekunden-Fensters zurückgehalten; ein von WhatsApp verlangter Sicherheitsrefresh erscheint sofort, weil der vorherige Code dann ungültig ist. Der Timer selbst fordert keine Rotation an.</p>
      </div>
    </div>
    <div id="pairing-result" class="pairing-result" hidden role="status" aria-live="polite"><strong id="pairing-result-title"></strong><p id="pairing-result-detail"></p></div>
  </section>
  <section id="chats" class="card chat-section" hidden aria-labelledby="chats-title">
    <div class="section-heading"><div><h2 id="chats-title">Chats auswählen</h2><p>Jeder Chat wird einzeln gewählt. Es gibt keinen Vollimport.</p></div><button id="refresh-chats" class="chat-button" type="button">Chatliste aktualisieren</button></div>
    <p id="chat-status" class="chat-status" data-state="loading" aria-live="polite">Verfügbare Chats werden geladen…</p>
    <div id="chat-list" class="chat-list"></div>
    <form id="manual-chat-form" class="manual-chat-form">
      <label class="manual-chat-label" for="manual-chat-id">Bekannte Chat-JID manuell eingeben</label>
      <p class="manual-chat-help">Falls WhatsApp noch keine Chatliste liefert, kannst du nur eine dir bekannte JID bewusst einzeln erlauben. Es werden keine Chats ergänzt oder geraten.</p>
      <div class="manual-chat-controls"><input id="manual-chat-id" class="manual-chat-input" name="chatId" type="text" inputmode="text" autocomplete="off" minlength="3" maxlength="256" required aria-describedby="manual-chat-feedback" placeholder="z. B. 491701234567@s.whatsapp.net"><button id="manual-chat-submit" class="manual-chat-submit" type="submit">Diesen Chat erlauben</button></div>
      <p id="manual-chat-feedback" class="manual-chat-feedback" aria-live="polite"></p>
    </form>
    <p id="allowlist-summary" class="allowlist-summary" aria-live="polite">Allowlist wird geladen…</p>
    <div id="allowlist-list" class="chat-list"></div>
    <p class="disclaimer"><strong>Die Auswahl aktualisiert die Allowlist.</strong> Sind alle übrigen Sicherheitsfreigaben erfüllt, startet der Live-Import unmittelbar und ausschließlich für die einzeln erlaubten Chats.</p>
  </section>
  <section class="card" aria-labelledby="summary-title">
    <div class="section-heading"><div><h2 id="summary-title">Chat-Zusammenfassungen</h2><p>Starte eine Zusammenfassung nur für einen bereits erlaubten Chat.</p></div></div>
    <p id="summary-provider-status" class="chat-status" aria-live="polite">OpenAI-Konfiguration wird geladen…</p>
    <p class="summary-disclosure"><strong>Externer Versand nur nach deiner Bestätigung.</strong> Gesendet werden ausgewählte gespeicherte Textnachrichten und verfügbare Transkripte samt pseudonymen Quellen-IDs, Zeitstempeln und Absenderrolle. Keine Audio-/Mediendateien, Chat-JIDs, QR-Codes, Sitzungsdaten oder Schlüssel. API-Aufrufe können Kosten verursachen. OpenAI verwendet API-Daten standardmäßig nicht zum Modelltraining; Missbrauchsüberwachungsprotokolle können Inhalte bis zu 30 Tage enthalten. <a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer">OpenAI-Datenverarbeitung</a></p>
    <p id="summary-chat-status" class="chat-status" aria-live="polite">Allowlist wird geladen…</p>
    <div id="summary-chat-list" class="chat-list"></div>
  </section>
</main>
<script>
  const dashboardCapability=${serializedCapability};
  const qrImage=document.querySelector('#qr');
  const qrEmpty=document.querySelector('#qr-empty');
  const qrCountdown=document.querySelector('#qr-countdown');
  const qrGeneration=document.querySelector('#qr-generation');
  const qrStatus=document.querySelector('#qr-status');
  const qrProgress=document.querySelector('#qr-progress');
  const pairingQrFlow=document.querySelector('#pairing-qr-flow');
  const pairingResult=document.querySelector('#pairing-result');
  const pairingResultTitle=document.querySelector('#pairing-result-title');
  const pairingResultDetail=document.querySelector('#pairing-result-detail');
  const chatsSection=document.querySelector('#chats');
  const chatStatus=document.querySelector('#chat-status');
  const chatList=document.querySelector('#chat-list');
  const manualChatForm=document.querySelector('#manual-chat-form');
  const manualChatId=document.querySelector('#manual-chat-id');
  const manualChatSubmit=document.querySelector('#manual-chat-submit');
  const manualChatFeedback=document.querySelector('#manual-chat-feedback');
  const allowlistSummary=document.querySelector('#allowlist-summary');
  const allowlistList=document.querySelector('#allowlist-list');
  const refreshChatsButton=document.querySelector('#refresh-chats');
  const summaryProviderStatus=document.querySelector('#summary-provider-status');
  const summaryChatStatus=document.querySelector('#summary-chat-status');
  const summaryChatList=document.querySelector('#summary-chat-list');
  let activeQrKey='';
  let activeQrGeneration=0;
  let activeQrRequiresImmediateDisplay=false;
  let pendingQrPayload=null;
  let latestAppliedQrRequest=0;
  let nextQrRequest=0;
  let displayWindowEndsAtMs=0;
  let displayWindowMs=0;
  let lastQrState='waiting';
  let pairingState='not_started';
  let nextChatRequest=0;
  let latestAppliedChatRequest=0;
  let discoveredChats=new Map();
  let openAiSummariesAvailable=false;

  function safeText(value,fallback){return typeof value==='string'&&value.length?value:fallback;}
  function formatCountdown(milliseconds){const seconds=Math.max(0,Math.ceil(milliseconds/1000));const minutes=Math.floor(seconds/60);return String(minutes).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');}
  function countdownColor(remainingMilliseconds,totalMilliseconds){const ratio=totalMilliseconds>0?Math.max(0,Math.min(1,remainingMilliseconds/totalMilliseconds)):0;const hue=Math.round(ratio*120);const lightness=Math.round(42+(ratio*8));return 'hsl('+String(hue)+' 78% '+String(lightness)+'%)';}
  function setQrState(state,message){if(lastQrState===state&&qrStatus.textContent===message)return;lastQrState=state;qrStatus.dataset.state=state;qrStatus.textContent=message;}
  function stopQrCountdown(){displayWindowEndsAtMs=0;displayWindowMs=0;qrProgress.style.setProperty('--progress','0');qrProgress.style.setProperty('--progress-color','var(--green)');}
  function applyQrPayload(payload){activeQrKey=String(payload.generation)+':'+payload.issuedAt;activeQrGeneration=payload.generation;activeQrRequiresImmediateDisplay=payload.requiresImmediateDisplay===true;pendingQrPayload=null;displayWindowMs=payload.displayWindowMs;displayWindowEndsAtMs=Date.now()+displayWindowMs;qrImage.src=payload.dataUrl;qrImage.hidden=false;qrEmpty.hidden=true;qrGeneration.textContent='QR-Generation '+String(payload.generation)+' · angezeigt';lastQrState='';}
  function renderQrCountdown(){if(!displayWindowEndsAtMs||!displayWindowMs)return;let remaining=Math.max(0,displayWindowEndsAtMs-Date.now());if(remaining===0&&pendingQrPayload!==null){applyQrPayload(pendingQrPayload);remaining=Math.max(0,displayWindowEndsAtMs-Date.now());}const progress=Math.max(0,Math.min(1,remaining/displayWindowMs));qrCountdown.textContent=formatCountdown(remaining);qrProgress.style.setProperty('--progress',String(progress*100));qrProgress.style.setProperty('--progress-color',countdownColor(remaining,displayWindowMs));if(remaining>0){if(pendingQrPayload!==null){setQrState('fresh','Ein neuer QR ist bereits eingetroffen und wird nach Ablauf dieses 30-Sekunden-Fensters angezeigt.');}else if(activeQrRequiresImmediateDisplay){setQrState('fresh','WhatsApp hat den QR sicherheitsbedingt erneuert. Bitte scanne jetzt den angezeigten Code.');}else{setQrState('fresh','QR-Code angezeigt. Der Timer läuft unabhängig von der QR-Erzeugung des Setup-Dienstes.');}return;}setQrState('elapsed','Anzeige-Fenster vorbei. Warte auf die nächste QR-Generation vom Setup-Dienst.');}
  function pairingStateFrom(payload){const state=payload&&typeof payload.pairingState==='string'?payload.pairingState:'not_started';return state==='not_started'||state==='awaiting_qr'||state==='finishing_login'||state==='connected'||state==='reconnecting'?state:'not_started';}
  function setQrEmpty(message){qrEmpty.textContent=message;qrEmpty.hidden=false;}
  function clearQrPresentation(){activeQrKey='';activeQrGeneration=0;activeQrRequiresImmediateDisplay=false;pendingQrPayload=null;stopQrCountdown();qrImage.hidden=true;qrImage.removeAttribute('src');qrEmpty.hidden=true;qrCountdown.textContent='—';}
  function showQrFlow(){pairingQrFlow.hidden=false;pairingResult.hidden=true;pairingResultTitle.textContent='';pairingResultDetail.textContent='';}
  function showPairingResult(title,detail){clearQrPresentation();pairingQrFlow.hidden=true;pairingResultTitle.textContent=title;pairingResultDetail.textContent=detail;pairingResult.hidden=false;}
  function setChatStatus(state,message){chatStatus.dataset.state=state;chatStatus.textContent=message;}
  function renderPairingState(payload){const nextState=pairingStateFrom(payload);const stateChanged=pairingState!==nextState;pairingState=nextState;const generation=Number.isSafeInteger(payload&&payload.generation)?payload.generation:0;if(nextState==='connected'){showPairingResult('Gerät gekoppelt – Verbindung steht.','Wähle jetzt gezielt die Chats aus, die in die lokale Allowlist dürfen.');chatsSection.hidden=false;if(stateChanged){setChatStatus('loading','Verfügbare Chats werden geladen…');void loadChats();void loadAllowlist();}return;}chatsSection.hidden=true;if(nextState==='finishing_login'){showPairingResult('Kopplung wird abgeschlossen.','WhatsApp hat den Scan bestätigt. Der lokale Dienst schließt die Anmeldung ab; ein weiterer QR ist nicht nötig.');return;}showQrFlow();if(nextState==='not_started'){clearQrPresentation();qrGeneration.textContent='Pairing-Dienst nicht gestartet';setQrEmpty('Dieses Dashboard zeigt nur den Zustand. Starte den Pairing-Dienst bewusst mit npm run setup:personal.');setQrState('not_started','npm run dashboard startet keinen Pairing-Dienst und fordert keinen QR an.');return;}if(nextState==='reconnecting'){clearQrPresentation();qrGeneration.textContent='Verbindung wird erneuert';setQrEmpty('Verbindung wird erneuert. Warte auf die nächste QR-Generation vom lokalen Setup-Dienst.');setQrState('reconnecting','Ein neuer QR erscheint nur, falls WhatsApp ihn dem Setup-Dienst tatsächlich liefert.');return;}if(!payload||typeof payload.dataUrl!=='string'){clearQrPresentation();qrGeneration.textContent=generation>0?'Letzte QR-Generation beendet':'Noch keine QR-Generation';setQrEmpty('Warte auf einen QR vom lokalen Setup-Dienst…');setQrState('awaiting_qr','Warte auf einen QR vom lokalen Setup-Dienst. Es wird kein QR künstlich erzeugt oder rotiert.');return;}if(!activeQrKey){qrGeneration.textContent=generation>0?'Letzte QR-Generation beendet':'Noch keine QR-Generation';setQrEmpty('Warte auf einen QR vom lokalen Setup-Dienst…');setQrState('awaiting_qr','Warte auf einen QR vom lokalen Setup-Dienst. Es wird kein QR künstlich erzeugt oder rotiert.');}}
  function validQrPayload(payload){return payload&&typeof payload==='object'&&pairingStateFrom(payload)==='awaiting_qr'&&typeof payload.dataUrl==='string'&&payload.dataUrl.startsWith('data:image/png;base64,')&&typeof payload.issuedAt==='string'&&Number.isSafeInteger(payload.generation)&&typeof payload.requiresImmediateDisplay==='boolean'&&typeof payload.displayWindowEndsAt==='string'&&typeof payload.serverNow==='string'&&Number.isSafeInteger(payload.displayWindowMs)&&payload.displayWindowMs>0;}
  function showQrPayload(payload){renderPairingState(payload);if(payload.generation<activeQrGeneration)return;const key=String(payload.generation)+':'+payload.issuedAt;if(activeQrKey===key){renderQrCountdown();return;}if(payload.requiresImmediateDisplay===true){applyQrPayload(payload);renderQrCountdown();return;}if(activeQrKey&&displayWindowEndsAtMs>Date.now()){if(pendingQrPayload===null||payload.generation>=pendingQrPayload.generation)pendingQrPayload=payload;renderQrCountdown();return;}applyQrPayload(payload);renderQrCountdown();}
  async function loadQr(){const requestNumber=++nextQrRequest;try{const response=await fetch('/api/setup/pairing-qr',{cache:'no-store'});const payload=await response.json();if(requestNumber<latestAppliedQrRequest)return;latestAppliedQrRequest=requestNumber;if(!response.ok){renderPairingState(payload);return;}if(!validQrPayload(payload)){renderPairingState(payload);setQrState('awaiting_qr','Der lokale QR-Status ist unvollständig. Warte auf die nächste QR-Generation.');return;}showQrPayload(payload);}catch{if(requestNumber>=latestAppliedQrRequest){latestAppliedQrRequest=requestNumber;renderPairingState({pairingState:'not_started'});setQrState('error','Lokale QR-Statusabfrage nicht erreichbar. Der QR wird nicht erneuert, solange der Dienst nicht antwortet.');}}}
  function localizeGateReason(reason){const labels={'LIVE_IMPORT_ENABLED is not true':'Live-Import nicht ausdrücklich aktiviert','account authorization is not confirmed':'Kontoberechtigung nicht bestätigt','setup confirmation is missing':'Setup nicht bestätigt','timezone confirmation is missing':'Zeitzone nicht bestätigt','retention confirmation is missing':'Aufbewahrung nicht bestätigt','export/deletion confirmation is missing':'Export und Löschung nicht bestätigt','local notification confirmation is missing':'lokale Benachrichtigungen nicht bestätigt','a persistent 32-byte encryption key is required':'dauerhafter Verschlüsselungsschlüssel fehlt','the allowlist is empty':'noch kein Chat ausgewählt','the kill switch is active':'Kill-Switch ist aktiv'};return labels[reason]||reason;}
  async function loadHealth(){try{const response=await fetch('/api/health',{cache:'no-store'});const health=await response.json();document.querySelector('#health-status').textContent=safeText(health.status,'unbekannt');document.querySelector('#health-allowlist').textContent=String(Number.isSafeInteger(health.allowlistedChatCount)?health.allowlistedChatCount:'—');const reasons=Array.isArray(health.liveGateReasons)?health.liveGateReasons.filter(function(reason){return typeof reason==='string';}):[];const onlyChatSelectionMissing=health.liveImportEnabled!==true&&reasons.length===1&&reasons[0]==='the allowlist is empty';document.querySelector('#health-live').textContent=health.liveImportEnabled===true?'freigegeben':onlyChatSelectionMissing?'bereit nach Chatauswahl':'gesperrt';document.querySelector('#health-gates').textContent=health.liveImportEnabled===true?'Alle bekannten Live-Freigaben sind erfüllt.':onlyChatSelectionMissing?'Kopplung ist möglich. Wähle danach mindestens einen Chat einzeln aus; erst dann beginnt der Live-Import.':'Offene Freigaben: '+reasons.map(localizeGateReason).join(', ');const failure=Number.isSafeInteger(health.lastConnectionFailureCode)?' Letzter WhatsApp-Verbindungsfehler: '+String(health.lastConnectionFailureCode)+'.':'';document.querySelector('#health-summary').textContent='Lokaler Dienst ist '+safeText(health.status,'unbekannt')+'.'+failure;}catch{document.querySelector('#health-summary').textContent='Lokaler Dienst nicht erreichbar.';}}
  async function loadAllowlist(){try{const response=await fetch('/api/allowlist',{cache:'no-store'});const allowlisted=await response.json();if(!response.ok||!Array.isArray(allowlisted))throw new Error('allowlist_unavailable');const count=allowlisted.length;allowlistSummary.textContent=count===0?'Allowlist: noch kein Chat erlaubt.':'Allowlist: '+String(count)+' '+(count===1?'Chat ist':'Chats sind')+' gezielt erlaubt.';if(allowlistList){allowlistList.replaceChildren();for(const chat of allowlisted){if(chat&&typeof chat.id==='string'&&chat.id.trim().length>=3)allowlistList.appendChild(createAllowlistedOption(chat));}}}catch{allowlistSummary.textContent='Allowlist konnte gerade nicht aktualisiert werden.';}}
  async function loadSummaryProviderStatus(){try{const response=await fetch('/api/summaries/status',{cache:'no-store'});const status=await response.json();if(!response.ok)throw new Error('summary_status_unavailable');openAiSummariesAvailable=status.available===true;summaryProviderStatus.textContent=openAiSummariesAvailable?'OpenAI-Zusammenfassung ist eingerichtet ('+safeText(status.model,'Modell')+'). Jeder Lauf wird einzeln bestätigt.':status.reason==='api_key_missing'?'OpenAI-Zusammenfassung ist deaktiviert: In der lokalen .env fehlt WCI_OPENAI_API_KEY.':status.reason==='persistent_key_missing'?'OpenAI-Zusammenfassung braucht WCI_ENCRYPTION_KEY_BASE64, damit Snapshots dauerhaft entschlüsselt bleiben.':'OpenAI-Zusammenfassung ist standardmäßig deaktiviert. Aktiviere sie ausdrücklich in der lokalen .env.';}catch{openAiSummariesAvailable=false;summaryProviderStatus.textContent='OpenAI-Konfiguration konnte nicht geladen werden.';}}
  function summaryCitations(ids){return Array.isArray(ids)&&ids.length?'Quellen-ID-Präfixe: '+ids.map(function(id){return typeof id==='string'?id.slice(0,12):'';}).filter(Boolean).join(', '):'Keine Quellen-ID verfügbar.';}
  function appendSummaryList(panel,title,items,format){if(!Array.isArray(items)||items.length===0)return;const heading=document.createElement('h3');heading.textContent=title;const list=document.createElement('ul');for(const item of items){const row=document.createElement('li');const text=document.createElement('span');text.textContent=format(item);row.appendChild(text);const citations=document.createElement('p');citations.className='summary-citations';citations.textContent=summaryCitations(item.sourceMessageIds)+(typeof item.confidence==='number'?' · Vertrauen '+String(Math.round(item.confidence*100))+' %':'');row.appendChild(citations);list.appendChild(row);}panel.append(heading,list);}
  function renderChatSummary(panel,result){panel.replaceChildren();const summary=result&&result.summary;if(!summary||typeof summary.shortSummary!=='string'){panel.textContent='Die Zusammenfassung konnte nicht gelesen werden.';panel.hidden=false;return;}const heading=document.createElement('h3');heading.textContent='Zusammenfassung';const body=document.createElement('p');body.textContent=summary.shortSummary;const meta=document.createElement('p');meta.className='summary-meta';meta.textContent=String(summary.includedMessageCount||0)+' Nachrichten einbezogen · '+String(summary.omittedMessageCount||0)+' ausgelassen · Vertrauen '+String(Math.round(Number(summary.summaryConfidence||0)*100))+' % · '+safeText(summary.modelVersion,'OpenAI')+(typeof result.createdAt==='string'?' · '+new Date(result.createdAt).toLocaleString('de-DE'):'');panel.append(heading,body,meta);appendSummaryList(panel,'Wichtige Punkte',summary.keyPoints,function(item){return item.text;});appendSummaryList(panel,'Entscheidungen',summary.decisions,function(item){return item.text;});appendSummaryList(panel,'Offene Fragen',summary.openQuestions,function(item){return item.text;});appendSummaryList(panel,'Aufgaben',summary.tasks,function(item){return item.title+(item.responsible?' · verantwortlich: '+item.responsible:'')+(item.dueAt?' · Frist: '+item.dueAt:'');});appendSummaryList(panel,'Erkannte Termine',summary.appointments,function(item){return item.title+(item.startsAt?' · '+item.startsAt:'')+' · '+item.status+' · Vertrauen '+String(Math.round(Number(item.confidence||0)*100))+' %';});appendSummaryList(panel,'Änderungen',summary.changes,function(item){return item.text;});appendSummaryList(panel,'Widersprüche',summary.unresolvedContradictions,function(item){return item.text;});if(Array.isArray(summary.dataGaps)&&summary.dataGaps.length){const gaps=document.createElement('p');gaps.textContent='Datenlücken: '+summary.dataGaps.join(' ');panel.appendChild(gaps);}panel.hidden=false;}
  async function loadLatestSummary(chatId,panel){try{const url='/api/summaries/latest?chatId='+encodeURIComponent(chatId);const response=await fetch(url,{cache:'no-store',headers:{'x-wci-dashboard-capability':dashboardCapability}});if(!response.ok)return;const payload=await response.json();if(payload&&payload.result)renderChatSummary(panel,payload.result);}catch{}}
  async function requestChatSummary(chatId,button,panel){if(!openAiSummariesAvailable){summaryChatStatus.textContent='OpenAI-Zusammenfassung ist nicht konfiguriert.';return;}const rawLimit=window.prompt('Wie viele der neuesten gespeicherten Nachrichten sollen einbezogen werden? (1–500)','100');if(rawLimit===null)return;const maxMessages=Number.parseInt(rawLimit,10);if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>500){summaryChatStatus.textContent='Bitte eine Begrenzung zwischen 1 und 500 Nachrichten eingeben.';return;}const confirmation='Die neuesten '+String(maxMessages)+' gespeicherten Nachrichten dieses Allowlist-Chats werden lokal begrenzt; Text und verfügbare Transkripte gehen mit pseudonymen Quellen-IDs, Zeitstempeln und Absenderrolle an die OpenAI API. Keine Audio-/Mediendateien, Chat-JIDs oder Sitzungsdaten. Der Aufruf kann Kosten verursachen. OpenAI nutzt API-Daten standardmäßig nicht fürs Training; Missbrauchsüberwachungsprotokolle können Inhalte bis zu 30 Tage enthalten. Zusammenfassung starten?';if(!window.confirm(confirmation))return;button.disabled=true;button.textContent='Zusammenfassung läuft…';panel.hidden=false;panel.textContent='Nachrichten werden lokal ausgewählt und an OpenAI gesendet…';summaryChatStatus.textContent='Die bestätigte Zusammenfassung läuft.';try{const response=await fetch('/api/summaries',{method:'POST',headers:{'content-type':'application/json','x-wci-dashboard-capability':dashboardCapability},body:JSON.stringify({chatId,confirmed:true,maxMessages})});const result=await response.json();if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'chat_summary_failed');renderChatSummary(panel,result);summaryChatStatus.textContent='Zusammenfassung erstellt und lokal verschlüsselt gespeichert.';}catch(error){const code=error instanceof Error?error.message:'chat_summary_failed';panel.textContent=code==='chat_summary_no_text'?'Für diesen Chat gibt es keine gespeicherten Textnachrichten oder verfügbaren Transkripte.':code==='chat_summary_in_progress'?'Für diesen Chat läuft bereits eine Zusammenfassung.':code==='chat_summary_disabled'||code==='chat_summary_api_key_missing'||code==='chat_summary_persistent_key_missing'?'OpenAI-Zusammenfassung ist lokal nicht aktiviert oder nicht vollständig konfiguriert.':'Zusammenfassung fehlgeschlagen. Prüfe API-Konfiguration und Verbindung; Inhalte wurden nicht protokolliert.';panel.hidden=false;summaryChatStatus.textContent='Die Zusammenfassung konnte nicht erstellt werden.';}finally{button.disabled=false;button.textContent='Per OpenAI zusammenfassen';}}
  function createSummaryChatOption(chat){const option=document.createElement('div');option.className='summary-chat-option';const label=document.createElement('span');label.className='chat-option-label';label.textContent=chat.kind==='group'?'Gruppe · '+chat.id:chat.id;const button=document.createElement('button');button.className='chat-button';button.type='button';button.textContent='Per OpenAI zusammenfassen';button.disabled=!openAiSummariesAvailable;button.setAttribute('aria-label','Chat per OpenAI zusammenfassen: '+label.textContent);const panel=document.createElement('div');panel.className='summary-panel';panel.hidden=true;button.onclick=function(){void requestChatSummary(chat.id,button,panel);};option.append(label,button,panel);void loadLatestSummary(chat.id,panel);return option;}
  async function loadSummaryChats(){try{const response=await fetch('/api/allowlist',{cache:'no-store'});const chats=await response.json();if(!response.ok||!Array.isArray(chats))throw new Error('summary_chat_list_unavailable');summaryChatList.replaceChildren();if(chats.length===0){summaryChatStatus.textContent='Noch kein Chat in der Allowlist. Wähle im verbundenen Setup zuerst einzelne Chats aus.';return;}for(const chat of chats){if(chat&&typeof chat.id==='string'&&chat.id.length>=3&&chat.id.length<=256&&(chat.kind==='group'||chat.kind==='individual'))summaryChatList.appendChild(createSummaryChatOption(chat));}summaryChatStatus.textContent=String(chats.length)+' erlaubte Chats verfügbar. Wähle einen Chat für eine Zusammenfassung.';}catch{summaryChatStatus.textContent='Die Allowlist konnte nicht geladen werden.';}}
  async function allowChat(chatId,button){const normalized=typeof chatId==='string'?chatId.trim():'';if(normalized.length<3||normalized.length>256)throw new Error('invalid_chat_id');button.disabled=true;try{const result=await fetch('/api/allowlist',{method:'POST',headers:{'content-type':'application/json','x-wci-dashboard-capability':dashboardCapability},body:JSON.stringify({chatId:normalized})});if(!result.ok)throw new Error('allowlist_failed');button.textContent='Chat erlaubt';await Promise.all([loadHealth(),loadAllowlist(),loadSummaryChats()]);return normalized;}catch(error){button.disabled=false;throw error;}}
  function chatDisplayLabel(chat){const discovered=discoveredChats.get(chat.id);const label=typeof chat.label==='string'&&chat.label?chat.label:(discovered&&typeof discovered.label==='string'&&discovered.label?discovered.label:'');if(chat.kind==='group')return (label||'Gruppenname nicht verfügbar')+' · '+chat.id;return label||chat.id;}
  function createChatOption(chat){const option=document.createElement('div');option.className='chat-option';const label=document.createElement('span');label.className='chat-option-label';label.textContent=chatDisplayLabel(chat);const button=document.createElement('button');button.className='chat-button';button.type='button';button.textContent='Diesen Chat erlauben';button.setAttribute('aria-label','Diesen Chat erlauben: '+label.textContent);button.onclick=async function(){try{await allowChat(chat.id,button);setChatStatus('selected','Der gewählte Chat wurde zur Allowlist hinzugefügt.');}catch{button.textContent='Erneut versuchen';setChatStatus('error','Der Chat konnte nicht erlaubt werden. Bitte prüfe die lokale Verbindung und versuche es erneut.');}};option.append(label,button);return option;}
  async function importHistory(chatId,button){const rawLimit=window.prompt('Maximale Anzahl historischer Nachrichten (1–1000):','100');if(rawLimit===null)return;const maxMessages=Number.parseInt(rawLimit,10);if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>1000){setChatStatus('error','Der historische Import braucht eine Begrenzung zwischen 1 und 1000 Nachrichten.');return;}if(!window.confirm('Nur der bereits erlaubte Chat '+chatId+' wird historisch abgefragt. Es werden keine anderen Chats importiert. Fortfahren?'))return;button.disabled=true;button.textContent='Import läuft…';setChatStatus('loading','Historische Nachrichten werden für genau diesen Chat angefragt…');try{const response=await fetch('/api/history-import',{method:'POST',headers:{'content-type':'application/json','x-wci-dashboard-capability':dashboardCapability},body:JSON.stringify({chatId,confirmed:true,maxMessages})});const result=await response.json();if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'history_import_failed');if(result.status==='completed'){setChatStatus('selected','Historischer Import abgeschlossen: '+String(result.imported||0)+' Nachrichten verarbeitet.');}else if(result.status==='partial'||result.status==='unavailable'){setChatStatus('error','Die Historie ist nicht vollständig verfügbar. Nutze alternativ den manuellen WhatsApp-Chat-Export.');}else{setChatStatus('error','Der historische Import wurde abgelehnt.');}}catch(error){const code=error instanceof Error?error.message:'history_import_failed';if(code==='history_cursor_unavailable'||code==='history_response_timeout'||code==='history_response_error'||code==='history_api_unavailable'||code==='history_incomplete'){setChatStatus('error','Die Historie ist nicht vollständig verfügbar. Nutze alternativ den manuellen WhatsApp-Chat-Export.');}else if(code==='history_live_gate_blocked'){setChatStatus('error','Der Live-/Historien-Gate ist aktuell gesperrt. Prüfe den Dienststatus.');}else{setChatStatus('error','Der historische Import wurde abgelehnt: '+code+'.');}}finally{button.disabled=false;button.textContent='Bereits geschriebene Nachrichten einmalig importieren';}}
  function createAllowlistedOption(chat){const option=document.createElement('div');option.className='chat-option';const label=document.createElement('span');label.className='chat-option-label';label.textContent=chatDisplayLabel(chat);const button=document.createElement('button');button.className='chat-button';button.type='button';button.textContent='Bereits geschriebene Nachrichten einmalig importieren';button.setAttribute('aria-label','Bereits geschriebene Nachrichten einmalig importieren: '+label.textContent);button.onclick=async function(){await importHistory(chat.id,button);};option.append(label,button);return option;}
  async function loadChats(){if(pairingState!=='connected')return;const requestNumber=++nextChatRequest;const stateAtRequest=pairingState;setChatStatus('loading','Verfügbare Chats werden aktualisiert…');try{const response=await fetch('/api/setup/available-chats',{cache:'no-store'});const responsePayload=await response.json();if(!response.ok||!Array.isArray(responsePayload))throw new Error('available_chats_unavailable');if(requestNumber<latestAppliedChatRequest||pairingState!==stateAtRequest)return;latestAppliedChatRequest=requestNumber;const chats=responsePayload.filter(function(chat){return chat&&typeof chat.id==='string'&&chat.id.trim().length>=3&&chat.id.length<=256&&(chat.kind==='group'||chat.kind==='individual');});discoveredChats=new Map(chats.map(function(chat){return [chat.id,chat];}));chatList.replaceChildren();for(const chat of chats)chatList.appendChild(createChatOption(chat));if(chats.length===0){setChatStatus('empty','WhatsApp hat noch keine Chatliste geliefert. Du kannst eine bekannte JID bewusst manuell eingeben oder die Chatliste aktualisieren.');return;}setChatStatus('ready',String(chats.length)+' '+(chats.length===1?'Chat ist':'Chats sind')+' verfügbar. Wähle jeden Chat einzeln aus.');}catch{if(requestNumber>=latestAppliedChatRequest&&pairingState===stateAtRequest){latestAppliedChatRequest=requestNumber;chatList.replaceChildren();setChatStatus('error','Die Chatliste ist gerade nicht erreichbar. Du kannst eine bekannte JID bewusst manuell eingeben.');}}}
  async function refreshChats(){if(!refreshChatsButton)return;refreshChatsButton.disabled=true;setChatStatus('loading','Chatliste wird ausdrücklich aktualisiert…');try{const response=await fetch('/api/setup/available-chats/refresh',{method:'POST',headers:{'content-type':'application/json','x-wci-dashboard-capability':dashboardCapability},body:'{}'});const result=await response.json();if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'refresh_failed');if(result.refreshed!==true){setChatStatus('error','WhatsApp hat keine sichere Chatlisten-Aktualisierung geliefert. Du kannst eine bekannte JID bewusst manuell eingeben.');return;}await loadChats();}catch{setChatStatus('error','Die Chatliste konnte gerade nicht aktualisiert werden. Prüfe die Verbindung oder nutze den bewussten JID-Fallback.');}finally{refreshChatsButton.disabled=false;}}
  manualChatForm.addEventListener('submit',async function(event){event.preventDefault();const chatId=manualChatId.value.trim();if(chatId.length<3||chatId.length>256){manualChatFeedback.textContent='Bitte gib eine JID mit 3 bis 256 Zeichen ein.';return;}manualChatFeedback.textContent='';try{await allowChat(chatId,manualChatSubmit);manualChatId.value='';manualChatSubmit.disabled=false;manualChatSubmit.textContent='Diesen Chat erlauben';manualChatFeedback.textContent='Die eingegebene JID wurde gezielt zur Allowlist hinzugefügt.';setChatStatus('selected','Die manuell eingegebene JID wurde zur Allowlist hinzugefügt.');}catch{manualChatFeedback.textContent='Die JID konnte nicht erlaubt werden. Bitte prüfe die Eingabe und versuche es erneut.';}});
  if(refreshChatsButton)refreshChatsButton.addEventListener('click',function(){void refreshChats();});
  void loadHealth();void loadQr();void loadSummaryProviderStatus().then(loadSummaryChats);window.setInterval(function(){void loadHealth();void loadQr();void loadChats();if(pairingState==='connected')void loadAllowlist();},2000);window.setInterval(renderQrCountdown,250);
</script>
</html>`;
}

export function startDashboard(
  application: ChatIntelligenceApplication,
  port = 8787,
  options: DashboardOptions = {}
): Promise<{ port: number; close(): Promise<void> }> {
  const capability = createCapability(options.capability);
  const page = dashboardPage(capability);
  let trustedOrigins = new Set<string>();
  let trustedHosts = new Set<string>();
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = requestUrl.pathname;
    try {
      if (!hasExpectedDashboardHost(request, trustedHosts)) {
        return respond(response, 403, { error: "loopback_host_required" });
      }
      if (method === "GET" && path === "/") {
        response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
        response.end(page);
        return;
      }
      if (method === "GET" && path === "/api/health") return respond(response, 200, application.health());
      if (method === "GET" && path === "/api/allowlist") return respond(response, 200, application.store.listAllowlistedChats());
      if (method === "GET" && path === "/api/summaries/status") return respond(response, 200, application.chatSummaryStatus());
      if (method === "GET" && path === "/api/summaries/latest") {
        if (!capabilityMatches(request, capability)) return respond(response, 403, { error: "dashboard_capability_required" });
        const chatId = requestUrl.searchParams.get("chatId")?.trim();
        if (!chatId || chatId.length < 3 || chatId.length > 256) return respond(response, 400, { error: "invalid_chat_id" });
        return respond(response, 200, { result: application.getLatestChatSummary(chatId) ?? null });
      }
      if (method === "GET" && path === "/api/setup/available-chats") return respond(response, 200, application.getAvailableChats());
      if (method === "POST" && path === "/api/setup/available-chats/refresh") {
        const rejection = mutationRejection(request, trustedOrigins, capability);
        if (rejection) return respond(response, rejection.status, { error: rejection.error });
        const result = await application.refreshAvailableChats();
        return respond(response, 200, result);
      }
      if (method === "POST" && path === "/api/history-import") {
        const rejection = mutationRejection(request, trustedOrigins, capability);
        if (rejection) return respond(response, rejection.status, { error: rejection.error });
        const body = await readJson(request);
        if (typeof body.chatId !== "string" || body.chatId.trim().length < 3 || body.chatId.length > 256) {
          return respond(response, 400, { error: "invalid_chat_id" });
        }
        if (body.confirmed !== true) return respond(response, 400, { error: "history_confirmation_required" });
        if (
          body.maxMessages !== undefined
          && (typeof body.maxMessages !== "number" || !Number.isSafeInteger(body.maxMessages))
        ) {
          return respond(response, 400, { error: "history_bound_invalid" });
        }
        if (body.since !== undefined && typeof body.since !== "string") return respond(response, 400, { error: "history_bound_invalid" });
        if (body.until !== undefined && typeof body.until !== "string") return respond(response, 400, { error: "history_bound_invalid" });
        const result = await application.importPersonalChatHistory({
          chatId: body.chatId.trim(),
          confirmed: true,
          ...(body.maxMessages === undefined ? {} : { maxMessages: body.maxMessages }),
          ...(body.since === undefined ? {} : { since: body.since }),
          ...(body.until === undefined ? {} : { until: body.until })
        });
        return respond(response, 200, result);
      }
      if (method === "POST" && path === "/api/summaries") {
        const rejection = mutationRejection(request, trustedOrigins, capability);
        if (rejection) return respond(response, rejection.status, { error: rejection.error });
        const body = await readJson(request);
        if (typeof body.chatId !== "string" || body.chatId.trim().length < 3 || body.chatId.length > 256) {
          return respond(response, 400, { error: "invalid_chat_id" });
        }
        if (body.confirmed !== true) return respond(response, 400, { error: "chat_summary_confirmation_required" });
        if (typeof body.maxMessages !== "number" || !Number.isSafeInteger(body.maxMessages) || body.maxMessages < 1 || body.maxMessages > 500) {
          return respond(response, 400, { error: "chat_summary_limit_invalid" });
        }
        const result = await application.summarizeChat(body.chatId.trim(), body.maxMessages);
        return respond(response, 200, result);
      }
      if (method === "GET" && path === "/api/setup/pairing-qr") {
        const snapshot = application.getPairingQrSnapshot();
        const metadata = pairingQrPresentationMetadata(snapshot);
        if (!snapshot.qr || !metadata) {
          return respond(response, 404, {
            status: "waiting_for_pairing_qr",
            generation: snapshot.generation,
            pairingState: snapshot.state,
            serverNow: new Date().toISOString()
          });
        }
        const dataUrl = await QRCode.toDataURL(snapshot.qr, { errorCorrectionLevel: "M", width: 256, margin: 1 });
        // QR source text is deliberately not serialized. The data URL is the
        // only presentation form and is protected by the loopback/no-store
        // route above.
        return respond(response, 200, { status: "pairing_qr_available", dataUrl, ...metadata });
      }
      if (method === "POST" && path === "/api/allowlist") {
        const rejection = mutationRejection(request, trustedOrigins, capability);
        if (rejection) return respond(response, rejection.status, { error: rejection.error });
        const body = await readJson(request);
        if (typeof body.chatId !== "string" || body.chatId.trim().length < 3 || body.chatId.length > 256) return respond(response, 400, { error: "invalid_chat_id" });
        application.pipeline.addAllowedChat(body.chatId.trim());
        return respond(response, 201, { ok: true });
      }
      if (method === "DELETE" && path.startsWith("/api/allowlist/")) {
        const rejection = mutationRejection(request, trustedOrigins, capability);
        if (rejection) return respond(response, rejection.status, { error: rejection.error });
        const chatId = decodeURIComponent(path.slice("/api/allowlist/".length));
        application.store.removeFromAllowlist(chatId);
        return respond(response, 200, { ok: true });
      }
      return respond(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ChatSummaryError) {
        return respond(response, 409, { error: error.code });
      }
      if (error instanceof PersonalHistoryImportError) {
        return respond(response, 409, { error: error.code });
      }
      return respond(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      trustedOrigins = allowedDashboardOrigins(actualPort);
      trustedHosts = allowedDashboardHosts(actualPort);
      resolve({
        port: actualPort,
        close: () => new Promise((closeResolve, closeReject) => server.close((error) => error ? closeReject(error) : closeResolve()))
      });
    });
  });
}
