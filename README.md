# WhatsApp Chat Intelligence

Eine neue, lokale und allowlist-basierte Anwendung für ausdrücklich autorisierte WhatsApp-Chats. Sie ist vollständig vom vorhandenen Device Activity Tracker getrennt und enthält keine RTT-, Presence-, Delete-/Reaction-Probes, ausgehenden WhatsApp-Nachrichten, Read-Receipt- oder Kontakt-Discovery-Logik.

Der sichere Startpunkt ist der automatisierte, synthetische Vertical Slice. Ein Linked Device wird nur vom browserunabhängigen Worker gestartet, wenn sämtliche ausdrücklichen Live-Gates erfüllt sind; ein normaler Default-Start koppelt nie ein Konto.

## Sicherheitsmodell in einem Satz

Eine leere Allowlist ist der Standard; bevor ein Chat ausdrücklich ausgewählt ist, werden weder seine Nachrichten noch Medien, Transkripte, Zusammenfassungen oder Benachrichtigungen gespeichert.

Siehe [Machbarkeit](docs/feasibility.md), [Architektur](docs/architecture.md), [Threat Model](docs/threat-model.md) und den [vollständigen Aufbau-/Experten-Prompt](docs/whatsapp-chat-intelligence-expert-prompt.md) für die verbindlichen Entscheidungen und Grenzen.

## Voraussetzungen

- macOS mit Node.js 26 oder neuer und npm 11 oder neuer
- Für den späteren lokalen Audio-Runner: dessen separat geprüfte lokale Installation (der MVP verwendet kontrollierte Fixtures und lädt nichts in eine Cloud hoch)
- Für Docker: Docker Desktop
- Ein eigenes oder ausdrücklich autorisiertes WhatsApp-Konto, falls die getrennte Linked-Device-Option bewusst aktiviert werden soll

## Lokaler Entwicklungsstart

```bash
npm ci
cp .env.example .env
openssl rand -base64 32
```

Trage den erzeugten Wert als `WCI_ENCRYPTION_KEY_BASE64` in `.env` ein. Für den normalen, fixture-basierten Worker genügen die sicheren Defaults:

```bash
npm test
npm run check
npm run worker
```

Das Dashboard ist optional und ausschließlich lokal erreichbar:

```bash
npm run dashboard
# http://127.0.0.1:8787
```

`npm run worker`, `npm run dashboard` und `npm run setup:personal` laden eine lokale `.env`, sofern sie vorhanden ist. Die Datei ist ignoriert und darf niemals eingecheckt werden. `npm run dashboard` zeigt ausschließlich das lokale Dashboard: Es startet weder den Pairing-Dienst noch erzeugt es einen QR-Code.

Das Dashboard erzeugt bei jedem Start eine zufällige, nur im Prozess gehaltene Capability für Allowlist-Änderungen. Die lokale Seite liefert sie ausschließlich an ihr eigenes Skript aus; mutierende Requests benötigen zusätzlich dieselbe Loopback-Origin und `application/json`. Alle Dashboard-Routen prüfen außerdem einen lokalen `Host`-Header. Damit kann eine fremde Website weder per Formular noch per Cross-Origin-Fetch einen Chat erlauben und ein fremder Host bekommt weder Status noch Pairing-QR.

## Persönliches Linked Device: bewusster Setup-Ablauf

Baileys ist ein inoffizieller WhatsApp-Web-Adapter. Er kann unvollständige History liefern und ist nicht mit WhatsApp verbunden oder von WhatsApp autorisiert. Die aktuell gepinnte Version `7.0.0-rc14` liegt über der gepatchten Mindestversion für [CVE-2026-48063 / GHSA-qvv5-jq5g-4cgg](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg). Upserts mit `requestId` sowie automatische historische Nachrichten werden verworfen; `INITIAL_BOOTSTRAP` und `RECENT` werden nur für flüchtige Chat-Metadaten und echte History-Cursor verarbeitet, ein globaler `FULL`-Import bleibt deaktiviert.

Erst nach einer eigenen rechtlichen und technischen Prüfung setzt du lokal in `.env`:

```dotenv
WCI_LIVE_IMPORT_ENABLED=true
WCI_ACCOUNT_AUTHORIZED=true
WCI_SETUP_CONFIRMED=true
WCI_TIMEZONE_CONFIRMED=true
WCI_RETENTION_CONFIRMED=true
WCI_EXPORT_DELETION_CONFIRMED=true
WCI_NOTIFICATIONS_CONFIRMED=true
WCI_ENCRYPTION_KEY_BASE64=<dein-lokaler-32-byte-base64-key>
```

Dann startet der bewusste Setup-Prozess:

```bash
npm run setup:personal
# http://127.0.0.1:8787
```

Nur `npm run setup:personal` startet zusätzlich den Pairing-Dienst für das persönliche Linked Device. Nach erfolgreicher Kopplung wechselt das Dashboard zur gezielten Chat-Auswahl; eine Chat-Auswahl ergänzt ausschließlich die Allowlist und aktiviert den Live-Import nicht allein.

Nach Änderungen am Dashboard muss der laufende `personal-setup`-Prozess neu gestartet und die Seite im Browser neu geladen werden: Das HTML samt eingebettetem Skript wird beim Prozessstart erzeugt. Wenn der Scan bestätigt ist, blendet die aktuelle Version den gesamten QR-Bereich aus und zeigt auch bei leerer Chatliste direkt **Gerät gekoppelt – Verbindung steht.** sowie **Chats auswählen** mit dem bewussten JID-Fallback. Die Chatliste stammt ausschließlich aus echten Baileys-Metadaten: Einzelchats werden als solche angezeigt, Gruppen werden insbesondere an einer echten JID mit `@g.us` erkannt und mit ihrem übermittelten Gruppennamen angezeigt. **Chatliste aktualisieren** fordert nur einen read-only App-State-Resync an; Lade-, Leer- und Fehlerzustände bleiben sichtbar. Eine bereits authentifizierte Companion-Session, die ihren initialen History-Sync in einem früheren Lauf vollständig übersprungen hat, kann diese Chatliste durch einen Reconnect nicht rückwirkend erzeugen; dafür ist ein ausdrücklich gestarteter neuer Pairing-Lauf oder der bewusste JID-Fallback erforderlich.

Der QR-Code existiert nur im Speicher dieses localhost-Prozesses, wird weder geloggt noch auf Platte gespeichert und verschwindet nach Verbindung. Das Dashboard startet sein konservatives **30-Sekunden-Anzeige-Fenster**, sobald der Browser den QR tatsächlich anzeigt, statt die verstrichene Zeit seit dem internen Empfang zu übernehmen. Baileys ist dafür zusätzlich auf einen 30-Sekunden-QR-Timeout eingestellt; ein während des laufenden Fensters eintreffender Folgecode wird bis zum Ablauf gepuffert. Die Anzeige ist ausdrücklich **keine** WhatsApp-Gültigkeitsdauer: Der Timer fordert keinen Ersatzcode an und rotiert die Verbindung nicht. Die Ringanimation läuft von Grün über Gelb und Orange zu Rot. Eine WhatsApp-Meldung wie „Verknüpfen neuer Geräte derzeit nicht möglich“ ist serverseitig und kann durch den Timer nicht behoben werden. Vor der Auswahl bleibt die Allowlist leer; alle eingehenden Chat-Daten werden dadurch am Pipeline-Gate verworfen. Vorhandene Gespräche, die der Adapter ohne automatische Voll-History-Synchronisation lokal bereitstellt, können im Setup einzeln ausgewählt werden. Es gibt bewusst keinen „alle Chats“-Schalter. Falls keine sichere Chatliste verfügbar ist, bleibt die Auswahl unvollständig sichtbar und Chats können nur bewusst per JID hinzugefügt werden; die Anwendung behauptet dann keine vollständige Historie.

Die verschlüsselte Linked-Device-Session liegt außerhalb des Repositories unter `WCI_DATA_DIR/sessions/personal-auth-state.enc` mit restriktiven Dateirechten. Ein fehlender, falscher oder nur flüchtiger Schlüssel blockiert Live-Verarbeitung.

### Einmaliger historischer Import pro Allowlist-Chat

Für jeden bereits erlaubten Chat gibt es im Dashboard die separate Aktion **Bereits geschriebene Nachrichten einmalig importieren**. Sie startet niemals beim Koppeln oder beim Anzeigen/Aktualisieren der Chatliste. Vor dem Request verlangt die Oberfläche eine Bestätigung und eine Begrenzung; der Server prüft zusätzlich erneut Allowlist, Bestätigung, Anzahl-/Zeitbegrenzung und das vollständige Live-Gate einschließlich Kill-Switch.

Der Import verwendet in `7.0.0-rc14` ausschließlich `fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)`, paginiert mit einem echten, zuvor beobachteten WhatsApp-Cursor und filtert strikt auf den ausgewählten Chat. Duplikate werden auf Adapter- und Persistenzebene verhindert. Historische Datensätze erhalten `source=history_sync` und `isHistorical=true`; sie werden nicht wie neue Live-Nachrichten behandelt und erzeugen keine Erinnerungen oder Notifications. Der Import ruft selbst weder `sendMessage`, Read Receipts noch Presence-Aktionen auf. Medien werden ohne tatsächlich geladene und geprüfte Bytes nicht als vorhanden markiert.

Baileys kann für Companion-Geräte trotzdem keine vollständige Historie garantieren. Liefert WhatsApp keinen sicheren Cursor, antwortet die On-Demand-Anfrage nicht oder endet die Übertragung ohne verlässlichen Abschluss, zeigt das Dashboard einen unvollständigen/nicht verfügbaren Status und verweist auf den manuellen [WhatsApp-Chat-Export](#optionaler-lokaler-chat-export-import) als Alternative. Das entspricht auch der weiterhin offenen praktischen Einschränkung aus [Baileys Issue #2452](https://github.com/WhiskeySockets/Baileys/issues/2452); die Ereignis-/History-Semantik von rc14 wird zusätzlich in [Issue #2580](https://github.com/WhiskeySockets/Baileys/issues/2580) beobachtet. Eine vollständige Historie wird nicht behauptet.

## macOS-Hintergrundbetrieb

Der Browser ist nicht Teil des Empfangs- oder Benachrichtigungspfads. Nach einem erfolgreichen lokalen Build kann der benutzerbezogene LaunchAgent geschrieben werden:

```bash
npm run build
npm run setup:launch-agent
cp .env "$HOME/Library/Application Support/WhatsAppChatIntelligence/runtime.env"
chmod 600 "$HOME/Library/Application Support/WhatsAppChatIntelligence/runtime.env"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.whatsapp-chat-intelligence.worker.plist"
```

Der Agent startet den kompilierten Worker beim Login erneut. Er lädt die geheime Laufzeitkonfiguration nur aus `WCI_DATA_DIR/runtime.env`, nicht aus dem Repository. Wenn alle Live-Gates einschließlich einer nicht-leeren Allowlist erfüllt sind, startet der Worker den Personal-Adapter selbst und versucht nach einem Verbindungsabbruch mit begrenztem exponentiellem Backoff erneut zu verbinden. macOS-Benachrichtigungen laufen über `osascript`/Notification Center im Benutzerprozess. Ein fehlgeschlagener Versand bleibt erneut zustellbar und wird im lokalen Health-Status sichtbar; er fällt nie auf WhatsApp zurück.

Zum kontrollierten Stoppen:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.whatsapp-chat-intelligence.worker.plist"
```

Sleep/Wake und Dienstneustarts laufen idempotent: nur der aktuelle relevante Zustand wird konsolidiert nachgeholt, niemals eine Notification je verpasster Nachricht.

## Docker

Docker ist für den reproduzierbaren Worker-/Dashboard-Kern, aber **nicht** die macOS-Notification-Brücke. Setze den Schlüssel ausschließlich in deiner lokalen Shell und starte:

```bash
export WCI_ENCRYPTION_KEY_BASE64="$(openssl rand -base64 32)"
docker compose up --build
docker compose --profile dashboard up --build
```

Der Compose-Default hat Live-Import bewusst deaktiviert. Das volumenbasierte Docker-Datenverzeichnis ist vom Device Activity Tracker getrennt.

## Backup, Aufbewahrung und Löschung

- `WCI_RETENTION_DAYS` wird vom Worker angewandt und entfernt abgelaufene Nachrichten samt nicht mehr referenzierten Medien sowie abgelaufene Summary-Snapshots aus diesem Datenverzeichnis.
- Ein konsistenter Export enthält nur die SQLite-Datenbank mit feldverschlüsselten Inhalten und den verschlüsselten Medienvault – weder Session noch Laufzeitkonfiguration noch Schlüssel. Wähle ein **neues Verzeichnis außerhalb** von `WCI_DATA_DIR`:

```bash
WCI_EXPORT_DIR="/sicherer/backup-ordner" npm run export:local
```

- Zum vollständigen, bewusst bestätigten Löschen dieser einen App-Instanz (Session, Runtime-Konfiguration, Logs, SQLite samt WAL/SHM und Medien) stoppe zuerst den LaunchAgent und führe aus:

```bash
WCI_CONFIRM_ERASE_LOCAL_INSTANCE=true npm run erase:local
```

Die Löschroutine verweigert Root-, Home- und Workspace-Verzeichnisse sowie Pfade außerhalb des konfigurierten App-Datenbereichs. Sie berührt niemals den Device Activity Tracker.

## Optionaler lokaler Chat-Export-Import

Ein WhatsApp-Text-Export ist eine **separate historische Quelle** (`chat_export`), kein Linked-Device-Login und kein Ersatz für eine vollständige Historie. Der Import liest genau eine bewusst ausgewählte, absolute lokale UTF-8-Textdatei; er verbindet sich nie mit WhatsApp, folgt keinen Symlinks, entpackt keine ZIPs, sucht keine Begleitdateien und lädt keine Medien herunter. Senderlabels und abgeleitete Import-IDs werden vor der Speicherung gekeyt pseudonymisiert; Logs enthalten nur Zähler und Fehlercodes, keine Chatinhalte oder Dateipfade.

Vorher muss der Zielchat bereits ausdrücklich auf der Allowlist stehen. Der Befehl verweigert sonst bereits **vor** dem Lesen der Exportdatei. Außerdem braucht er eine dauerhaft gesetzte Verschlüsselung sowie die lokale Kontoautorisierung. Der eigene Exportname ist optional und bleibt lediglich flüchtig für die `fromMe`-Zuordnung:

```bash
WCI_ACCOUNT_AUTHORIZED=true \
WCI_ENCRYPTION_KEY_BASE64="<dein-lokaler-32-byte-base64-key>" \
WCI_CONFIRM_CHAT_EXPORT_IMPORT=true \
WCI_CHAT_EXPORT_PATH="/absoluter/pfad/_chat.txt" \
WCI_CHAT_EXPORT_CHAT_ID="bereits-erlaubte-chat-jid" \
WCI_CHAT_EXPORT_SELF_SENDER="optional: exakter Name im Export" \
WCI_CHAT_EXPORT_DATE_ORDER=auto \
npm run import:chat-export
```

Unterstützt werden die üblichen Android-/iOS-Zeilenformate mit deutschem Punkt-Datum bzw. US-`AM`/`PM`. Anders nicht eindeutig interpretierbare numerische Schrägstrich-/Bindestrich-Daten werden nicht geraten, sondern gezählt und übersprungen; setze dafür bewusst `WCI_CHAT_EXPORT_DATE_ORDER=dmy` oder `mdy`. Export-Zeitstempel werden in `WCI_TIMEZONE` interpretiert. Ein nicht vorhandener Sommerzeit-Zeitpunkt, ungültiges UTF-8, Nicht-Dateien, Symlinks sowie Dateien über 32 MiB werden abgelehnt. Importiert werden höchstens 100.000 Nachrichten mit jeweils höchstens 64 KiB Text.

Export-Platzhalter wie `<Media omitted>` erhalten nur einen nachvollziehbaren `unsupported`-Status: Ohne sicher geladene Bytes und Hash wird kein Medium als vorhanden behauptet. Als historische Quelle erzeugt der Import keine neuen oder geänderten Erinnerungen; vorhandene Termine bleiben quellengebunden und können als best effort lückenhaft sein.

## Chat-Zusammenfassungen mit OpenAI

Die OpenAI-Zusammenfassung ist standardmäßig ausgeschaltet und läuft nur auf ausdrücklichen Klick im lokalen Dashboard. Zusätzlich zum dauerhaften `WCI_ENCRYPTION_KEY_BASE64`-Schlüssel trägst du den API-Schlüssel ausschließlich in die lokale, ignorierte `.env` ein und schaltest die Funktion dort sichtbar frei:

```dotenv
WCI_OPENAI_API_KEY=<dein OpenAI API-Schlüssel>
WCI_OPENAI_SUMMARIES_ENABLED=true
WCI_OPENAI_SUMMARY_MODEL=gpt-6-astra
```

Starte danach `npm run dashboard` neu und öffne `http://127.0.0.1:8787`. Unter **Chat-Zusammenfassungen** erscheinen ausschließlich bereits allowlistete Chats. Für jeden Lauf bestätigst du erneut, dass die ausgewählte Nachrichtenmenge an OpenAI gesendet wird; du kannst die neuesten 1 bis 500 gespeicherten Nachrichten begrenzen. Zusammengefasst werden Textnachrichten und lokal gespeicherte Voice-/Audio-Transkripte. Nicht transkribierte oder andere Medien werden nicht hochgeladen. Chat-JIDs, Teilnehmer-IDs, Session-Daten und Medienbytes werden ebenfalls nicht an die API gesendet. Beim Docker-Compose-Setup werden diese drei Variablen nur an den Dashboard-Container durchgereicht, nicht an den Worker.

Die Responses-API erhält `store: false` und ein strikt strukturiertes JSON-Schema. Quellen-IDs und Konfidenzen jeder Aussage werden geprüft; Quellen müssen zu den tatsächlich übermittelten Nachrichten gehören. Termine kommen aus den lokalen, quellengebundenen Event-Datensätzen. Das Ergebnis wird verschlüsselt in der lokalen Summary-Tabelle abgelegt. Die API nutzt Eingaben/Ausgaben standardmäßig nicht zum Modelltraining; Missbrauchsüberwachungsprotokolle können API-Inhalte standardmäßig bis zu 30 Tage enthalten. Für Datenverarbeitungsdetails siehe die [offizielle OpenAI-Dokumentation](https://developers.openai.com/api/docs/guides/your-data) und für das Ausgabeformat [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). API-Nutzung kann Kosten verursachen.

## Recovery und Datenlücken

History-Sync und Chat-Export sind best effort. Fehlende, gelöschte oder nicht mehr abrufbare Medien bleiben sichtbar und werden nie als vorhanden ausgegeben. Fehlgeschlagene Transkription ist `transcription_failed`, nicht erfundener Text. Historische Quellen erzeugen keine neuen Erinnerungen. Jede Termin-/Summary-Ableitung enthält Quellen-IDs, Status und Konfidenz.

## Validierung

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Die Tests decken den Vertical Slice sowie Zeit-/DST-Auflösung, Webhook-Signaturprüfung, Replay-/Request-ID-Abwehr, Chat-Export-Grenzen, Adapter-Metadaten, browserunabhängigen Reconnect, lokale Transkriptionsfehler, Update/Absage, per-Chat-Reihenfolge, History ohne Notification, Dedupe, Retry nach fehlgeschlagener Notification, Lifecycle-Export/-Löschung und Inhaltsredaktion ab.
