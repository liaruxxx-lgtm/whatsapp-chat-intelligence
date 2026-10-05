# Architektur

Stand: 2026-09-21
Status: Synthetic-First-MVP

## Isolation

`WhatsApp Chat Intelligence` ist ein eigenes Repository mit eigener Konfiguration, eigener SQLite-Datei, eigener Medienablage, eigener Session-Ablage, eigenen Tests und einem eigenen macOS-LaunchAgent. Es importiert weder Code noch Laufzeitdaten aus dem getrennten Repository `device-activity-tracker`.

| Operation | Chat Intelligence | Device Activity Tracker |
| --- | --- | --- |
| Start | `npm run worker` bzw. `launchctl`-LaunchAgent | Unabhängig im bestehenden Repository/Docker-Stack |
| Test | `npm test` im neuen Repository | Unabhängig im bestehenden Repository |
| Daten | `WCI_DATA_DIR` außerhalb des Repositorys | Bestehende Tracker-Daten unverändert |
| Entfernen | Setup-gesteuerte sichere Löschung dieser Instanz | Berührt den Tracker nicht |

## Komponenten und Datenfluss

```text
SyntheticAdapter / ChatExportAdapter / PersonalLinkedDeviceAdapter / BusinessCloudAdapter
                           |
                           v
                  Allowlist-Gate (vor Persistenz)
                           |
                           v
       SQLite MessageStore + verschlüsselter sensibler Payload
                           |
                 +---------+----------+
                 |                    |
                 v                    v
       Media/LocalTranscription   Event resolver
                 |                    |
                 v                    +------------+
          Transcript records      |            |
                                  v            v
                       Event revisions + reminders   Structured summary snapshots
                                      |
                                      v
                      Notification adapter (macOS / test double)
```

Der Browser ist nur ein Dashboard und Konfigurationsclient. Ingest, Resolver, Reminder und Benachrichtigungen laufen im Worker-Prozess und benötigen kein geöffnetes Browserfenster.

Chat-Zusammenfassungen haben zusätzlich einen manuellen Dashboard-Pfad: ausgewählter Allowlist-Chat → erneute Bestätigung → begrenzte Auswahl gespeicherter Textnachrichten/Transkripte → OpenAI Responses API → Schema- und Quellenprüfung → lokal verschlüsselter Snapshot. Dieser Pfad startet nicht automatisch bei Nachrichteneingang.

## Adaptergrenzen

- `SyntheticAdapter`: kontrollierte Fixtures für den gesamten Vertical Slice; keinerlei Netzwerk- oder Kontoaktion.
- `ChatExportAdapter`: optionaler, rein lokaler Import genau einer vom Nutzer gewählten UTF-8-Textdatei in einen **bereits** allowlisteten Chat. Er ist kein Login, kein Vollimport und keine Kontakt-/Dateisuche: reguläre Nicht-Symlink-Datei, feste Größen-/Record-Grenzen, keine ZIPs, keine Attachments und kein Netzwerk. Export-Senderlabels und fehlende Nachrichten-IDs werden nur über gekeyte lokale Token abgeleitet; seine Quelle ist stets `chat_export`.
- `PersonalLinkedDeviceAdapter`: ein opt-in Baileys-Adapter für ein autorisiertes Konto. Er setzt `markOnlineOnConnect: false`, sendet keine Nachrichten, verwirft Upserts mit `requestId`, deaktiviert globalen `FULL`-History-Import und verarbeitet `INITIAL_BOOTSTRAP`/`RECENT` nur flüchtig für echte Chat-Metadaten und Cursor. Automatische historische Nachrichten werden verworfen; ein expliziter, begrenzter `fetchMessageHistory`-Import ist auf einen bereits erlaubten Chat beschränkt und mit Quelle sowie Datenlücke markiert.
- `BusinessCloudAdapter`: separater Webhook-Eingang mit HMAC-Signaturprüfung, Replay-/ID-Deduplizierung und keinem stillen Fallback auf persönliche Daten.

Kein Adapter bekommt vor dem Allowlist-Gate Zugang zu einer Persistenz- oder Transkriptionsschnittstelle. Eine Chatliste für die manuelle Auswahl dient nur der lokalen Setup-Ansicht vorhandener Gespräche und ist kein Contact-Discovery- oder Vollimport-Mechanismus.

Für die notwendige Auswahl darf der Personal-Adapter vorhandene Chat-Metadaten, die Baileys beim lokalen Pairing tatsächlich liefert, nur flüchtig an das localhost-Dashboard geben. Nicht ausgewählte JIDs/Namen werden nicht in SQLite geschrieben. Eine lückenhafte Adapterliste wird als lückenhaft behandelt; sie ist keine Zusicherung vollständiger Chat-Historie.

## Speicherung und Datenmodell

Die Datenbank enthält mindestens diese Tabellen: `chats`, `participants`, `messages`, `message_revisions`, `media_assets`, `transcripts`, `summary_snapshots`, `facts`, `tasks`, `detected_events`, `event_revisions`, `reminders`, `notification_deliveries`, `processing_jobs` und `audit_log`.

Die kanonische Nachrichtenidentität ist `chatId + messageId + sender/participant context + fromMe`; sie wird als stabiler, gekeyter Token persistiert. Vor der Verarbeitung wird die Nachricht idempotent gespeichert. Nachrichtentexte **und vollständige Transkriptsegmente** liegen AES-256-GCM-verschlüsselt vor; Logs enthalten nur IDs, Status und redigierte Fehler. Routing-Metadaten bleiben lokal und werden nicht geloggt; der Export enthält die feldverschlüsselte Datenbank und gehört deshalb in einen geschützten lokalen Speicher.

Nach jedem relevanten, bereits persistierten Eventübergang erzeugt der Worker einen inkrementellen strukturierten Snapshot. Der standardmäßige deterministische Provider ist über einen provider-neutralen Vertrag austauschbar; jede Provider-Antwort wird vor der Speicherung auf die feste Struktur und darauf geprüft, dass alle Quellen-IDs zu den bekannten Chat-Ereignissen gehören. Eine Wiederholung derselben Nachricht erzeugt keinen neuen Snapshot.

Die manuelle OpenAI-Zusammenfassung ist ein getrennter, ausdrücklich aktivierter Provider. Pro Anfrage gehen höchstens die neuesten 500 gespeicherten Textnachrichten bzw. vorhandenen Transkripte mit gekeyten kanonischen Quellen-IDs, Zeitstempeln und `fromMe`-Rolle an `https://api.openai.com/v1/responses`; JIDs, Sender-IDs, Mediendateien, QR und Sessiondaten bleiben lokal. Requests setzen `store: false`. Das Dashboard bestätigt den externen Versand für jeden Lauf, und ein API-Schalter bleibt standardmäßig aus. Jede generierte Aussage muss auf IDs der tatsächlich gesendeten Nachrichten zeigen und enthält eine Konfidenz. Die erzeugten Termine werden nicht vom Modell erfunden, sondern aus den lokalen Event-Datensätzen übernommen. Modellresultate werden mit einem persistenten lokalen Schlüssel verschlüsselt gespeichert; Retention entfernt alte Summary-Snapshots zusammen mit ihren Datenfenstern.

Der Baileys-Auth-State verwendet bewusst nicht `useMultiFileAuthState`: Credentials und Signal-Key-Store werden als ein AES-256-GCM-verschlüsselter, atomar ersetzter Sessionzustand mit Dateirechten `0600` außerhalb des Repositorys gespeichert.

Audio-/Medienbytes werden nie unter einem extern gelieferten Namen oder einer URL gespeichert. Ein hashbasierter lokaler Pfad führt zu einem AES-256-GCM-verschlüsselten Vault-Envelope mit Integritätsprüfung; die Datenbank enthält nur den ebenfalls verschlüsselten Pfadhinweis, MIME-Metadaten und SHA-256. Ohne erfolgreich geladene Bytes bleibt ein Asset sichtbar `unavailable`.

Eine `detected_event` ist das **logische** Ereignis mit stabiler ID. `event_revisions` halten Versionen und Quellen. Dadurch bleibt bei „15 Uhr → auf 16 Uhr verschoben“ genau ein logisches Ereignis aktiv, während die 15-Uhr-Version prüfbar erhalten bleibt. Erinnerungen referenzieren Event-ID und Revision; ein stabiler Delivery-Key verhindert doppelte Benachrichtigungen.

## Zeit- und Ereignisverarbeitung

Der Parser nutzt den ursprünglichen Nachrichtentimestamp und `Europe/Berlin`, nicht die spätere Verarbeitungszeit. Er erstellt nur dann einen bestätigten Termin, wenn Datum und Uhrzeit ausreichend klar sind. Vorschläge, Fragen, niedrige Konfidenz und widersprüchliche Aussagen bleiben ohne Erinnerung in einem prüfbaren Unsicherheitszustand. Bei mehreren aktiven Terminen ändert oder storniert der Resolver nur ein eindeutig passendes Thema; ein mehrdeutiger Bezug erzeugt stattdessen einen nicht erinnerungsfähigen Unsicherheitszustand.

## Zuverlässigkeit

- Persist-before-process, Unique-Constraints und Delivery-Keys machen Wiederholungen idempotent.
- Gleichzeitige Eingänge werden pro Chat seriell abgearbeitet; eine langsame Audio-Transkription kann dadurch keine später eingegangene Änderung desselben Chats überholen. Verschiedene Chats bleiben unabhängig ausführbar.
- Ein erneut eingelesener identischer Chat-Export dedupliziert über lokale, gekeyte Importidentitäten. Vorspann mit älteren Nachrichten verschiebt diese Identitäten nicht; bei exakt gleichen Timestamp-/Sender-/Text-Duplikaten bleibt die Reihenfolge die unvermeidbare Best-effort-Unterscheidung.
- Eine Notification wird erst nach erfolgreicher macOS-Brücke als zugestellt markiert; ein fehlgeschlagener Versuch wird wieder freigegeben, ein beim Prozessende offener Claim beim nächsten Lauf.
- Der Worker startet den Personal-Adapter nur nach vollständigem Live-Gate und erstellt nach Socket-Close mit begrenztem exponentiellem Backoff einen frischen Socket. Das separate Pairing-Setup darf über das engere Connection-Gate ebenfalls einen abgelaufenen QR-Socket erneuern, doch sein Inbound-Callback bleibt bis zum vollständigen Live-Gate strikt vor Persistenz gesperrt. Restart/Sleep-Wake lädt nur noch aktuelle aktive Erinnerungen; History-Quelle und unveränderte Revisionen erzeugen nie neue Benachrichtigungen.
- `processing_jobs` und die Business-Cloud-Runtime sind bewusst vorbereitete, aber noch nicht aktivierte Erweiterungspunkte; sie werden nicht als produktive DLQ-/Retry-Pipeline ausgegeben.
- Health/Readiness, Gate-Gründe und letzter sicherer Fehlerstatus sind über den lokalen Dashboard-Endpunkt sichtbar.

## Laufzeit und Deployment

`docker compose` bietet eine reproduzierbare Worker-/Dashboard-Umgebung für den fixture-basierten Kern. Die tatsächliche macOS-Benachrichtigung bleibt absichtlich im lokalen Benutzerprozess: ein `LaunchAgent` startet den Worker beim Login, hält ihn nach Absturz am Leben und schreibt keine Daten in das Repository. Docker allein ist nicht die Benachrichtigungsquelle.

## Konfiguration

Die Beispielkonfiguration enthält ausschließlich sichere Defaults: leere Allowlist, `WCI_LIVE_IMPORT_ENABLED=false`, `WCI_EXTERNAL_TRANSCRIPTION_ENABLED=false`, `WCI_OPENAI_SUMMARIES_ENABLED=false`, `Europe/Berlin`, 30 Minuten Vorlauf und aktivierte Inhaltsredaktion. Session-Pfad, Datenpfad und Schlüssel liegen außerhalb des Repositorys. Retention wird vom Worker angewandt; Export erstellt nur verschlüsselte Nutzdaten, und Löschung verweigert breite Datenpfade. Zeitzone, Retention, Export/Löschung und lokale Notification müssen einzeln bestätigt werden, bevor der Worker Live-Ingest startet. Der separate Chat-Export-Befehl verlangt zusätzlich eine explizite Einmalbestätigung, Kontoberechtigung, persistenten Schlüssel und eine bereits bestehende Allowlist; seine Textzeitstempel werden bewusst in der konfigurierten Zeitzone gelesen. Der OpenAI-API-Schlüssel bleibt in der lokalen `.env`; ohne Schalter, Schlüssel und Bestätigung gibt es keinen API-Request.
