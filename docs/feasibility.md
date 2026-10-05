# Machbarkeit und Betriebsfreigabe

Stand: 2026-09-23
Status: **Chat-Zusammenfassung per OpenAI Responses API integriert und standardmäßig deaktiviert; Live-Import weiterhin gesperrt**

## Entscheidungs­matrix

| Punkt | Gewählter Default | Begründung | Abweichung nötig? |
| --- | --- | --- | --- |
| Konto-/Adaptermodus | `PERSONAL_LINKED_DEVICE` für ein ausdrücklich autorisiertes eigenes Konto | Entspricht dem gewünschten persönlichen Use Case; der Adapter bleibt inoffiziell und opt-in. | Nein, aber Live-Betrieb ist bis zur bestätigten Einrichtung gesperrt. |
| Chat-Scope | Leere, explizite Einzel-/Gruppen-Allowlist | Nachrichten nicht ausgewählter Chats gelangen nie in Persistenz, Medien- oder KI-Pipeline. | Nein |
| Speicherung | Getrennte lokale SQLite-Datenbank und lokaler Medienpfad | Keine gemeinsame Laufzeitdatenbank mit dem Device Activity Tracker und kein Cloud-Zwang. | Nein |
| Transkription | Lokal, zunächst Fixture-/lokaler Adapter | Sprachinhalte werden nicht ohne sichtbares Opt-in hochgeladen. | Nein |
| Benachrichtigung | Lokale macOS-Brücke | Browserunabhängig und ohne Versand an WhatsApp. | Nein |
| Zeit/Locale | `Europe/Berlin`, Deutsch mit englischer Erkennung | Deterministische Terminauflösung anhand des Nachrichtentimestamps inklusive Sommer-/Winterzeit. | Nein |

## Ergebnis der Prüfung

Die neue Anwendung ist als **eigenständiges lokales Produkt** technisch umsetzbar. Sie wird nicht aus dem Device Activity Tracker kopiert und enthält keine RTT-, Presence-, Delete-, Reaction- oder Read-Receipt-Logik. Der Adapter verarbeitet nur eingehende Daten eines autorisierten Kontos; ausgehende WhatsApp-Aktionen, automatische Antworten und „als gelesen“-Aktionen sind nicht implementiert.

Ein echter persönlicher Linked-Device-Betrieb bleibt ein begrenztes, inoffizielles Integrationsrisiko: Baileys ist nicht mit WhatsApp verbunden oder von WhatsApp autorisiert, History-Synchronisation ist best-effort und nicht vollständig garantierbar. Ein Default-Start startet deshalb nie einen Live-Import. Erst der browserunabhängige Worker darf nach allen bestätigten Gates verbinden; vor echter Verarbeitung müssen Setup-Bestätigung, eine nicht-leere explizite Allowlist, Aufbewahrung, Zeitzone, Export/Löschung, Benachrichtigungsbestätigung und ein lokaler Schlüssel konfiguriert sein.

Die offizielle Business Cloud API ist als strikt separater Adaptervertrag vorhanden. Sie ist eine Alternative für ein konfiguriertes Business-Konto, aber kein Ersatz für eine beliebige persönliche WhatsApp-Historie. Ohne Business-Konfiguration wird sie nicht aktiviert.

## On-Demand Chat-Zusammenfassung mit OpenAI

- Implementiert als expliziter Dashboard-Vorgang für bereits allowlistete Chats. Die Feature-Freigabe ist standardmäßig `false`; jeder einzelne Lauf braucht eine Nutzerbestätigung, einen persistenten lokalen Verschlüsselungsschlüssel und eine Grenze von höchstens 500 Nachrichten.
- Nur gespeicherter Text und verfügbare lokale Voice-/Audio-Transkripte werden übertragen. Nicht transkribierte Medien, JIDs, Teilnehmerkennungen, QR-Codes, Session-Daten und Schlüssel bleiben lokal. Die Anfrage nutzt die Responses API mit strikt strukturiertem JSON und `store: false`.
- Quellen-IDs werden gegen die in genau dieser Anfrage enthaltenen IDs geprüft; Termine werden aus den quellengebundenen lokalen Events bezogen. Snapshots liegen verschlüsselt in der lokalen Datenbank.
- Die offizielle OpenAI-Dokumentation empfiehlt Structured Outputs für schema-konforme JSON-Antworten ([Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)). API-Daten werden standardmäßig nicht zum Training verwendet; Missbrauchsüberwachungsprotokolle können Inhalte standardmäßig bis zu 30 Tage enthalten ([Data controls](https://developers.openai.com/api/docs/guides/your-data)). Der Dashboard-Dialog legt Übertragung und Retention offen.
- Ein echter API-Aufruf ist in dieser Umgebung noch nicht ausgeführt worden, da kein API-Schlüssel dafür bereitgestellt wurde. Vor Nutzung sind Schlüssel und expliziter Schalter lokal in der ignorierten `.env` zu konfigurieren; Kosten richten sich nach API-Modell und Umfang.

## Dependency- und Security-Audit

- Ziel-Repository: neues, leeres Git-Repository; vor der Initialisierung gab es weder Lockfile noch installierte Dependencies.
- Referenz-Repository: `@whiskeysockets/baileys` war in `package.json` mit `^7.0.0-rc.9` deklariert, im Lockfile und in `node_modules` aber als `7.0.0-rc13` vorhanden. Diese unsynchrone, nicht reproduzierbare Konfiguration wird nicht übernommen.
- Aktueller npm-Tag am 2026-09-21: `@whiskeysockets/baileys@7.0.0-rc14`; die Anwendung pinnt diese konkrete Version und committed ihren Lockfile.
- [GHSA-qvv5-jq5g-4cgg](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg) / CVE-2026-48063 betrifft Baileys vor `7.0.0-rc12` und ermöglicht manipulierte Upserts bzw. History-Sync-Korruption. `rc14` liegt oberhalb der gepatchten Mindestversion. Zusätzlich verwirft der Personal-Adapter jedes `messages.upsert` mit `requestId`, verarbeitet `INITIAL_BOOTSTRAP`/`RECENT` nur flüchtig für Chat-Metadaten/Cursor und lässt den globalen `FULL`-History-Import aus; ein bewusst angeforderter, klar markierter Best-effort-Import bleibt ein separater Vorgang.
- Die vor der Implementierung geprüften Typen der vorhandenen, gepatchten 7.x-Linie führen `messages.upsert`, `messaging-history.set`, `messages.update`, `messages.delete` und `messages.reaction`; `messages.upsert` hat `type` und optional `requestId`. Nach der Installation wird die gepinnte `rc14`-Typdefinition erneut per Typecheck geprüft; keine Eventnamen aus Blogartikeln werden übernommen.

## Sicherheits- und Live-Gates

`npm test` muss den Vertical Slice vollständig grün nachweisen, bevor ein echter Adapter aktiviert werden darf. Selbst dann bleibt der Live-Modus blockiert, bis der lokale Setup-Zustand alle folgenden Bedingungen erfüllt:

1. `WCI_LIVE_IMPORT_ENABLED=true` wurde bewusst lokal gesetzt (nicht in Git).
2. Die Kontoberechtigung ist lokal bestätigt.
3. Nach der Einrichtung enthält die Allowlist mindestens einen ausgewählten vorhandenen Chat, jedoch niemals einen All-Chats-Schalter.
4. Ein 32-Byte-Encryption-Key wird außerhalb des Repositories bereitgestellt.
5. Die lokal sichtbare Checkliste setzt `WCI_TIMEZONE_CONFIRMED`, `WCI_RETENTION_CONFIRMED`, `WCI_EXPORT_DELETION_CONFIRMED` und `WCI_NOTIFICATIONS_CONFIRMED` erst nach Prüfung auf `true`; fehlende Punkte erscheinen als Gate-Gründe im Dashboard.
6. Der persönliche Adapter verwendet die geprüfte gepinnte Baileys-Version, gefilterte Upserts, kein `markOnlineOnConnect`, nur flüchtige sichere Chat-Erkennung und einen global deaktivierten `FULL`-History-Import. Historische Nachrichten werden ausschließlich über den explizit begrenzten On-Demand-Weg verarbeitet.

Fehlt ein Gate, liefert der Dienst einen sichtbaren `blocked`/`degraded`-Status und verarbeitet keine Live-Nachricht. Das ist absichtlich kein Schein-Fallback.

Die Kopplung selbst darf vor der Chat-Auswahl stattfinden, weil die Allowlist laut Produktentscheidung leer beginnt. Dafür gilt ein engeres Connection-Gate (expliziter Live-Opt-in, Kontoberechtigung, Setup-Bestätigung, dauerhafter Schlüssel, Kill-Switch aus). Während der Auswahl verwirft das Allowlist-Gate trotzdem jede eingehende Nachricht vor Persistenz. Erst eine nicht-leere Auswahl schaltet tatsächliche Live-Verarbeitung frei. Die im Setup sichtbare Chatliste bleibt ausschließlich flüchtig im lokalen Prozess und wird für nicht ausgewählte Chats nicht gespeichert.

## Bewusste MVP-Grenzen

- Text und Voice/Audio werden vollständig verarbeitet. Bilder, Dokumente, Videos, Sticker, Standorte, Kontakte, Umfragen, Reaktionen, Zitate, Weiterleitungen, Edits und Deletes erhalten zunächst sichere Metadaten, Herkunft und einen nachvollziehbaren Status; nur Text/Voice erzeugen im MVP Ableitungen.
- Die lokale Transkriptionsschnittstelle verarbeitet im automatisierten Slice ausschließlich kontrollierte Fixtures. Ein produktiver lokaler Modell-Runner wird erst nach Auswahl eines lokal installierten Modells und Hardware-Test aktiviert; ein fehlender Runner führt zu `transcription_failed`, nie zu geratenem Text.
- Die Linked-Device-Session wird als AES-256-GCM-verschlüsselter Einzelzustand außerhalb des Repositories gespeichert. Der Setup-QR wird nur als localhost-Response im Prozessspeicher gehalten; er wird weder geloggt noch persistiert.
- Medienbytes werden, sobald sie einem Adapter sicher bereitgestellt wurden, vor Vault/Transkription gegen MIME- und Größenlimits geprüft sowie hashbasiert und AES-256-GCM-verschlüsselt im lokalen Medienvault abgelegt. Ein produktiver Baileys-/Cloud-Media-Downloader mit Zugangsdaten ist bewusst noch nicht aktiviert; ohne tatsächlich geladene Bytes bleibt der Status `media_unavailable`, statt ein Medium als vorhanden zu behaupten.
- Ein optionaler WhatsApp-Chat-Text-Export kann ausschließlich lokal in einen bereits erlaubten Chat importiert werden. Er verarbeitet keine Archive oder Begleitdateien, lädt keine Medien und aktiviert kein Konto. Ein fester Größen-/Record-Rahmen, UTF-8-/Nicht-Symlink-Prüfung, explizite Datumsreihenfolge bei ambigen Exportformaten sowie gekeyte Sender-/Nachrichtenidentitäten begrenzen Fehlinterpretation und Klartext-Metadaten. `chat_export` ist immer historisch und erzeugt keine Erinnerungen.
- Nach relevanten Eventübergängen entstehen inkrementelle, quellengebundene deterministische Snapshots. Zusätzlich kann die manuelle OpenAI-Integration einen textbasierten Chatüberblick mit quellengebundenen Punkten, Entscheidungen, Aufgaben und lokal erkannten Terminen erzeugen.
- Der deterministische Terminresolver deckt für den Slice Deutsch/Englisch, relative Tage, Uhrzeiten, Änderungen und Absagen ab. Unklare Aussagen bleiben `uncertain`/`pending_resolution` und planen keine Erinnerung.

## Noch nicht aktivierte Erweiterungen

- Der aktuelle deterministische Slice erzeugt quellengebundene Terminereignisse und Snapshots, aber noch keine automatischen Fakten-, Entscheidungs- oder Aufgabenableitungen. Die Tabellen dafür bleiben vorbereitet, statt unbelegte Heuristiken als Fakten auszugeben.
- `processing_jobs` ist vorbereitet; eine persistente Retry-/Dead-Letter-Queue und die produktive Business-Cloud-Webhook-Laufzeit sind noch nicht aktiviert. Der laufende Ingest ist pro Chat seriell und idempotent, ersetzt aber keine dauerhafte DLQ.
- Die macOS-Brücke liefert dedupliziert, retry-fähig und mit sichtbarem Fehlerstatus. Ruhezeiten, interaktive Snooze/Erledigt-Aktionen und ein Daily Digest sind noch nicht implementiert; fehlende oder verweigerte Notification-Berechtigungen führen deshalb weiterhin zu einem klaren lokalen Delivery-Fehler, nie zu einem WhatsApp-Fallback.

## Datenlücken und Betriebshinweise

WhatsApp-History, gelöschte Nachrichten, abgelaufene Medien und Geräte-Offlinezeiten können Lücken erzeugen. Jede verfügbare Importquelle wird mit Herkunft gespeichert; History löst nie neue Erinnerungen aus. Medien gelten erst nach erfolgreichem Download und SHA-256-Prüfung als vorhanden. Der Worker setzt eine unterbrochene Personal-Verbindung mit begrenztem exponentiellem Backoff neu auf und prüft nach Sleep/Wake ausschließlich den aktuellen, noch relevanten Zustand konsolidiert.

Der synthetische Slice, die verschlüsselte Persistenz, der opt-in Adapter und der getrennte lokale Chat-Export-Importer sind verifiziert. Die OpenAI-Integration ist implementiert, aber hier mangels API-Schlüssel nicht live gegen OpenAI verifiziert. **Nicht als Live-MVP freigegeben** bleiben bis zur ausdrücklichen Auswahl und Hardware-Prüfung eines lokalen STT-Runners sowie eines sicher getesteten Baileys-/Cloud-Medien-Downloaders. Die oben genannten noch nicht aktivierten Erweiterungen sind zusätzlich keine Grundlage für einen Vollständigkeitsanspruch. Chat-Exporte bleiben unabhängig davon eine best-effort-historische Textquelle und keine Zusicherung einer vollständigen WhatsApp-Historie. Diese Grenzen blockieren Live-Import bewusst statt einen unvollständigen Datenfluss als vollständig auszugeben.

Diese technische Dokumentation ersetzt keine Rechtsberatung. Die Person, die die App betreibt, ist für Kontoautorisierung, Einwilligung, Rechtsgrundlage und die passende Retention verantwortlich.
