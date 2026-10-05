# Experten-Prompt: fortlaufende WhatsApp-Chat-Intelligence

Stand: 2026-09-21
Zweck: Übergabe an einen Coding-Agenten zur Machbarkeitsprüfung und anschließenden Umsetzung.

## Prompt

Du bist Principal Software Architect, Security Engineer und Senior TypeScript-/Node.js-Entwickler.

### Produktentscheidung: neue eigenständige App

Baue eine neue, eigenständige Anwendung mit dem Arbeitstitel `WhatsApp Chat Intelligence`. Sie ist ein separates Produkt und keine Erweiterung der bestehenden Device-Activity-Tracker-Funktion.

- Die bestehende Device-Activity-Tracker-App bleibt unverändert und funktionsfähig.
- Wenn dasselbe Git-Repository verwendet wird, muss die neue App in einem klar getrennten Top-Level-Verzeichnis oder als klar getrennte Servicestruktur mit eigener Konfiguration, eigener Datenablage, eigenen Jobs, eigener UI und eigenen Tests liegen.
- Eine separate Repository-Kopie oder ein separates Repository ist zulässig, wenn das die Isolation verbessert.
- Übernommen werden dürfen nach Prüfung nur generische Infrastrukturteile, beispielsweise Docker-Konventionen, QR-/Linked-Device-Verbindung oder Socket-Grundlagen.
- Nicht übernommen werden dürfen `tracker.ts`, `signal-tracker.ts`, RTT-Messung, Presence-Überwachung, Delete-/Reaction-Probes oder sonstige Aktivitäts- und Überwachungslogik.
- Die neue App verarbeitet standardmäßig ausschließlich eine explizite Chat-Allowlist. Nicht ausgewählte Einzel- und Gruppenchats werden weder gespeichert noch transkribiert noch zusammengefasst.

### Verbindlicher MVP-Entscheidungsrahmen

Verwende für die erste umsetzbare Version diese Defaults. Ändere sie nur, wenn eine technische Einschränkung oder eine begründete Sicherheitsanforderung dies erzwingt, und dokumentiere die Abweichung vor der Implementierung.

- **Kontomodus:** `PERSONAL_LINKED_DEVICE` für das ausdrücklich autorisierte persönliche Konto. Der Business-Cloud-API-Adapter bleibt eine spätere, getrennte Option und darf nicht heimlich als Ersatz verwendet werden.
- **Ausführung:** lokal auf macOS, reproduzierbar per Docker Compose.
- **Neue App:** eigene Services, eigene `.env`, eigene Session-/Datenverzeichnisse und eigene Test-Fixtures. Keine gemeinsame Laufzeit-Datenbank mit dem Device Activity Tracker.
- **Chat-Scope:** explizite Allowlist aus Einzelchat-JIDs und Gruppenchats. Es gibt keinen „alle Chats“-Default.
- **Allowlist-Bedienung:** Nach der Kopplung werden verfügbare Einzel- und Gruppenchats angezeigt. Der Nutzer wählt einzelne Chats oder eine ausdrücklich markierte Teilmenge aus. Die Allowlist startet leer; es gibt keinen impliziten „alle auswählen“- oder Vollimport-Schalter.
- **MVP-Inhalt:** Text und Sprachnachrichten vollständig; andere Medientypen zunächst mit Metadaten und nachvollziehbarem `unsupported`-Status.
- **Transkription:** lokal und standardmäßig ohne Upload an einen externen Anbieter. Ein externer Anbieter ist nur über einen sichtbaren Opt-in-Schalter erlaubt.
- **Zusammenfassung:** provider-neutrale Modell-Schnittstelle mit strikt strukturiertem JSON-Ausgabeformat, Quellen-IDs und Vertrauenswerten; kein freier, nicht belegbarer Fließtext als alleinige Datenbasis.
- **Benachrichtigung:** zunächst lokale macOS-Benachrichtigungen; Standardvorlauf 30 Minuten; Terminänderungen und Absagen sofort; Benachrichtigungen idempotent.
- **Hintergrundbetrieb:** Ein eigener macOS-Hintergrunddienst läuft als benutzerbezogener `LaunchAgent` unabhängig vom Browser. Das Browser-Frontend ist nur Dashboard und Konfiguration und darf keine Voraussetzung für Empfang, Verarbeitung, Terminplanung oder Benachrichtigungen sein.
- **Zeit:** `Europe/Berlin`, Sprache `de`, englische Nachrichten werden erkannt und verarbeitet.
- **Datenspeicherung:** lokale Datenbank und lokale Medienablage; Aufbewahrung, Export und Löschung müssen vor dem ersten Live-Import konfigurierbar und testbar sein.
- **Aktionen nach außen:** kein automatisches Antworten, kein Markieren als gelesen, kein Senden von Nachrichten und keine Presence-Aktionen.

Wenn `PERSONAL_LINKED_DEVICE` technisch, rechtlich oder sicherheitstechnisch nicht verantwortbar ist, stoppe vor dem Live-Betrieb, erkläre die Einschränkung und biete ausschließlich den offiziellen Business-API-Modus als klar getrennte Alternative an.

### Verbindlicher Entwicklungsablauf für den Coding-Agenten

Arbeite nicht direkt mit dem vollständigen Chatbestand. Liefere zuerst einen kleinen, überprüfbaren Vertical Slice:

1. App startet lokal mit leerer Datenbank.
2. Chat-Allowlist kann einen Einzelchat und einen Gruppenchat aufnehmen.
3. Ein synthetisches Text-Event wird idempotent gespeichert.
4. Ein synthetisches Audio-Event wird über eine Fixture transkribiert.
5. Eine Testnachricht mit „Heute um 15 Uhr“ erzeugt genau ein strukturiertes Event.
6. Eine zweite Testnachricht mit „auf 16 Uhr verschoben“ aktualisiert genau dieses Event.
7. Die lokale Benachrichtigung wird genau einmal erzeugt.
8. Ein nicht erlaubter Chat erzeugt keinerlei Speicherung, Transkription oder Benachrichtigung.
9. Das Browserfenster wird geschlossen; der Hintergrunddienst verarbeitet ein neues Test-Event weiterhin.
10. Nach einem simulierten Sleep/Wake oder Dienstneustart wird nur der aktuelle relevante Terminzustand nachgeholt gemeldet.

Erst wenn dieser Vertical Slice automatisiert grün ist, darf der Agent den echten WhatsApp-Adapter aktivieren. Vor dem ersten Live-Import muss ein sichtbarer Setup-Schritt die Allowlist, Zeitzone, Aufbewahrung und Benachrichtigung bestätigen lassen.

### Verbindliche Ausgabe vor jeder Implementierung

Der Agent muss zuerst eine kurze Entscheidungsmatrix ausgeben:

| Punkt | Gewählter Default | Begründung | Abweichung nötig? |
|---|---|---|---|
| Konto-/Adaptermodus | persönliches Linked Device | passt zum bestehenden persönlichen WhatsApp-Use-Case | ja/nein |
| Chat-Scope | explizite Einzel-/Gruppen-Allowlist | verhindert Vollüberwachung | ja/nein |
| Speicherung | lokal getrennt | minimiert Datenabfluss | ja/nein |
| Transkription | lokal | Schutz von Sprachnachrichten | ja/nein |
| Benachrichtigung | macOS lokal | kleinster sicherer MVP | ja/nein |
| Zeit/Locale | Europe/Berlin/de | definierter Terminparser | ja/nein |

Wenn ein Punkt nicht sicher entschieden werden kann, darf der Agent keine stillschweigende Annahme treffen. Er muss die Unsicherheit in `docs/feasibility.md` markieren und den Live-Import blockieren.

Entwickle ein datenschutzorientiertes System, das einen ausdrücklich autorisierten WhatsApp-Chat fortlaufend verarbeitet:

1. vorhandene Nachrichten best-effort importieren,
2. neue Nachrichten automatisch erkennen,
3. Sprachnachrichten herunterladen und transkribieren,
4. den Chat laufend zusammenfassen,
5. Termine, Aufgaben, Entscheidungen und Änderungen strukturiert erkennen,
6. bei neuen oder geänderten Terminen zuverlässig benachrichtigen.

Beispiel: „Heute um 15 Uhr treffen wir uns.“ Das System muss daraus – abhängig von Konfiguration und Vertrauensgrad – einen Termin für `Europe/Berlin` erzeugen und eine lokale Benachrichtigung planen.

### Nicht verhandelbare Grenzen

- Verarbeite ausschließlich das eigene WhatsApp-Konto oder Konten mit ausdrücklicher Autorisierung.
- Baue keine verdeckte Überwachung fremder Personen ein.
- Verwende keine RTT-Probes, Delete-Probes, Reaction-Probes, Presence-Überwachung, Read-Receipt-Tricks oder Kontaktaufzählung.
- Das Repository `device-activity-tracker` ist ein Forschungs-PoC zur Geräteaktivität und darf nicht als Überwachungslogik wiederverwendet werden. Die bestehenden Probe-Tracker gehören nicht in die Chat-Intelligence-Pipeline.
- Sende standardmäßig keine WhatsApp-Nachrichten und markiere standardmäßig keine Nachrichten als gelesen.
- Behaupte niemals Vollständigkeit, wenn die Quelle Lücken, fehlende Medien, gelöschte Nachrichten oder unvollständige Historie liefert.
- Jede Zusammenfassung und jedes erkannte Ereignis muss auf konkrete Nachrichten-IDs oder Transkriptsegmente zurückführbar sein.
- Bei Unsicherheit muss das System `uncertain`, `unconfirmed` oder `transcription_uncertain` ausgeben. Es darf keine Fakten, Uhrzeiten oder Personen erfinden.
- Session-Daten, Tokens, QR-Codes, Audio-Dateien und private Nachrichten dürfen weder in Git noch in Dokumentationsdateien oder Wikis gelangen.

### Projektkontext

Ausgangsrepository bzw. Referenz:

das getrennte lokale Repository `device-activity-tracker`

Zielumgebung:

- macOS für Entwicklung und lokale Ausführung
- Docker-kompatible Services
- Node.js/TypeScript als Hauptstack
- Standardzeitzone `Europe/Berlin`
- Sprachen zunächst Deutsch und Englisch
- lokale Verarbeitung standardmäßig bevorzugen

Vor jeder Codeänderung:

1. Lies alle relevanten `AGENTS.md`.
2. Prüfe `git status`, Branch, Lockfile und tatsächlich installierte Dependency-Versionen.
3. Prüfe aktuelle Baileys-Releases und Security Advisories.
4. Lies die Typdefinitionen der installierten Baileys-Version; übernimm keine veralteten Eventnamen aus Blogposts.
5. Erstelle zuerst `docs/feasibility.md`, `docs/architecture.md` und `docs/threat-model.md`.
6. Verändere die bestehende RTT-Demofunktion nicht. Die neue App muss in klar getrennten Modulen/Services implementiert werden.
7. Weise in der Architektur nach, dass die alte Aktivitäts-Tracker-App und die neue Chat-App unabhängig gestartet, gestoppt, getestet und gelöscht werden können.

### Adapter-Entscheidung

Implementiere zwei strikt getrennte Adapter und entscheide im Feasibility-Dokument, welcher für das Zielkonto zulässig ist.

#### A. Persönliches Konto / Linked Device

- QR- oder Pairing-Code-Verbindung mit persistenter Session.
- Nur eine aktuelle, gepatchte Baileys-Version verwenden und Dependency-Version sowie Lockfile synchronisieren.
- Auth-State sicher und außerhalb des Repositorys speichern.
- Mindestens diese Ereignisklassen verarbeiten:
  - neue Nachrichten,
  - historische Synchronisation,
  - Nachrichtenänderungen,
  - Löschungen,
  - Reaktionen,
  - Antworten und Zitate,
  - Gruppen,
  - Nachrichten von mir und von anderen.
- `notify` und historische `append`-Ereignisse getrennt behandeln.
- Historische Nachrichten dürfen keine neuen Erinnerungsbenachrichtigungen auslösen.
- Request-/Replay-Daten validieren und die aktuellen Upstream-Sicherheitsmaßnahmen befolgen.
- Reconnect, Exponential Backoff, Session-Revalidierung und sichtbaren Verbindungsstatus implementieren.
- Dokumentieren, dass Baileys inoffiziell ist und historische Vollständigkeit sowie langfristige Stabilität nicht garantiert werden können.

#### B. Offizielle WhatsApp Business Cloud API

- Webhooks für eingehende Nachrichten verwenden.
- Webhook-Anfragen und Signaturen nach aktueller Meta-Dokumentation verifizieren.
- Eingehende Events anhand der Nachrichten-ID idempotent speichern.
- Audio-/Voice-Media über Media-ID → Media-URL → sicheren Download verarbeiten.
- Eingehende Nachrichten, ausgehende Nachrichten und Statusereignisse trennen.
- Dokumentieren, dass die Cloud API kein beliebiger Spiegel einer privaten WhatsApp-Komplett-Historie ist.
- Wenn kein Business-Konto konfiguriert ist, darf dieser Adapter nicht stillschweigend verwendet werden.

### Initialer Import

Unterstütze getrennte Importquellen:

1. Baileys-History-Sync als best-effort Import.
2. WhatsApp-Chat-Export als optionalen Import.
3. Medien nur dann als vorhanden markieren, wenn sie tatsächlich heruntergeladen und gehasht wurden.

Für jede Nachricht speichern:

- kanonische Nachrichten-ID,
- Chat-ID,
- Teilnehmer-/Absender-ID,
- `fromMe`,
- ursprünglicher Nachrichtentimestamp,
- Empfangszeitpunkt,
- Quelle,
- Nachrichtentyp,
- Rohdaten-Hash,
- Verarbeitungsstatus,
- Medienstatus,
- Lösch-/Änderungsstatus.

Die kanonische ID darf nicht nur aus einer möglicherweise nicht global eindeutigen Nachrichten-ID bestehen. Verwende mindestens Chat-ID, Nachrichten-ID, Teilnehmer-/Absenderkontext und `fromMe`.

### Medien und Sprachnachrichten

Unterstütze mindestens:

- Text,
- Sprachnachrichten,
- Audio,
- Bilder,
- Dokumente,
- Videos,
- Sticker,
- Standorte,
- Kontakte,
- Umfragen,
- Reaktionen,
- zitierte Nachrichten,
- Weiterleitungen,
- bearbeitete und gelöschte Nachrichten.

Für Sprachnachrichten:

1. Medium sicher und idempotent herunterladen.
2. MIME-Typ, Größe, Dauer und SHA-256-Hash speichern.
3. Bei Bedarf mit FFmpeg in ein unterstütztes Transkriptionsformat konvertieren.
4. Standardmäßig lokale Transkription verwenden.
5. Transkript mit Sprache, Segment-Zeitstempeln und Vertrauenswert speichern.
6. Original-Audio und Transkript über dieselbe Nachrichten-ID verknüpfen.
7. Bei fehlendem oder nicht mehr verfügbarem Medium `media_unavailable` speichern.
8. Bei fehlgeschlagener Transkription nicht raten, sondern `transcription_failed` speichern.
9. Cloud-Transkription nur durch explizite Konfiguration aktivieren.

### Datenmodell

Entwirf ein nachvollziehbares Modell für:

- `chats`
- `participants`
- `messages`
- `message_revisions`
- `media_assets`
- `transcripts`
- `summary_snapshots`
- `facts`
- `tasks`
- `detected_events`
- `reminders`
- `processing_jobs`
- `audit_log`

Jede abgeleitete Information braucht:

- Quellen-Nachrichten-IDs,
- Erstellungszeit,
- Parser-/Modellversion,
- Vertrauenswert,
- Status,
- letzte Änderung,
- optionales Ablaufdatum.

### Zusammenfassung

Erzeuge pro Chat:

- Kurzfassung,
- neue Punkte seit der letzten Zusammenfassung,
- Entscheidungen,
- offene Fragen,
- Aufgaben mit Verantwortlichen,
- Termine und Fristen,
- Änderungen gegenüber der vorherigen Zusammenfassung,
- ungelöste Widersprüche,
- Datenlücken und Verarbeitungsfehler.

Arbeite inkrementell:

- neue Nachrichten zuerst in einem kleinen Änderungsfenster verarbeiten,
- regelmäßige kompakte Summary-Snapshots erzeugen,
- ältere Inhalte in stabile Snapshots komprimieren,
- bei Änderungen nur betroffene Fakten und Ereignisse neu berechnen,
- nicht bei jeder Nachricht den gesamten Chat blind neu zusammenfassen.

### Termine und Zeitangaben

Implementiere einen deterministischen Zeit- und Ereignisparser.

- Relative Begriffe wie „heute“, „morgen“ und „nächsten Freitag“ beziehen sich auf den Timestamp der Nachricht, nicht auf die spätere Verarbeitungszeit.
- Standardzeitzone ist `Europe/Berlin`, sofern keine andere Zeitzone sicher hervorgeht.
- Sommer-/Winterzeit muss korrekt behandelt werden.
- Fehlende Angaben niemals erfinden.
- Ein Ereignis kann `tentative`, `confirmed`, `changed`, `cancelled`, `completed` oder `uncertain` sein.
- „Treffen verschoben auf 16 Uhr“ aktualisiert denselben logischen Termin und erzeugt keinen zweiten unabhängigen Termin.
- „Treffen fällt aus“ storniert geplante Erinnerungen.
- Eine Terminänderung muss als Änderung gemeldet werden.
- Liegt der Termin beim Eintreffen der Nachricht bereits in der Vergangenheit, darf keine zukünftige Erinnerung erzeugt werden.
- Jede erkannte Zeit benötigt Quellen-ID, normalisierte Zeit, Zeitzone, Vertrauenswert und Begründung.

### Auflösung von Gesprächsverläufen und Terminänderungen

Ein Termin ist kein unabhängiges Datum pro Nachricht, sondern ein versioniertes logisches Ereignis. Implementiere dafür einen Event-Resolver mit Quellenbezug, Zustandsautomat und stabiler `eventId`.

Beispielverlauf:

1. „Wollen wir uns Montag treffen?“ → Frage/Entwurf, keine Erinnerung.
2. „Ja, lass uns Montag treffen.“ → bestätigter Termin Montag.
3. „Doch nicht.“ → Termin abgesagt; bestehende Erinnerung stornieren.
4. „Lass uns doch treffen, aber Dienstag.“ → derselbe logische Termin, neue aktive Version Dienstag.

Das System darf nicht dauerhaft Montag, Dienstag und Donnerstag als drei aktive Termine führen. Es muss:

- Fragen, Vorschläge, Bestätigungen, Absagen, Korrekturen und bloße Wiederholungen unterscheiden.
- Nachrichten mit demselben Gesprächsthema zu einem logischen Ereignis clustern.
- Negationen und spätere Korrekturen höher gewichten als frühere Vorschläge.
- `proposed`, `confirmed`, `cancelled`, `changed`, `uncertain` und `superseded` unterscheiden.
- pro logischem Ereignis genau eine aktive Version besitzen.
- alte Versionen revisionssicher als Historie behalten, aber nicht weiter erinnern.
- bei einer Änderung die alte Erinnerung stornieren und nur die aktuelle Erinnerung neu planen.
- unveränderte Zusammenfassungen und bereits gemeldete Zustände nicht erneut benachrichtigen.
- bei widersprüchlichen Nachrichten zunächst `pending_resolution` setzen und nicht für jede Zwischenstufe eine Benachrichtigung senden.
- eine konfigurierbare kurze Ruhe-/Sammelzeit nach einer relevanten Nachricht verwenden, beispielsweise zwei Minuten, damit schnell aufeinanderfolgende Korrekturen zusammengeführt werden.
- bei expliziter Absage oder klarer finaler Korrektur sofort reagieren; die Sammelzeit darf eindeutige Stornierungen nicht unnötig verzögern.
- nach der Sammelzeit höchstens eine Meldung zum aktuellen konsolidierten Zustand senden.

Als „wichtig“ gelten standardmäßig nur:

- bestätigter neuer Termin,
- bestätigte Änderung von Datum, Uhrzeit, Ort oder Teilnehmern,
- Absage eines zuvor bestätigten Termins,
- neue Aufgabe oder Frist mit ausreichender Konfidenz,
- Wiederaufnahme eines zuvor abgesagten Termins.

Nicht benachrichtigen bei:

- jeder einzelnen normalen Chatnachricht,
- bloßen Fragen ohne Bestätigung,
- bereits bekanntem unverändertem Termin,
- wiederholten Transkriptions-/Synchronisationsereignissen,
- jeder Zwischenversion innerhalb der Sammelzeit, sofern noch keine eindeutige Absage vorliegt.

Verwende mindestens dieses Schema oder eine gleichwertige, begründete Struktur:

```ts
type DetectedEvent = {
  id: string;
  chatId: string;
  type: "appointment" | "deadline" | "task" | "reminder";
  title: string;
  startsAt?: string;
  endsAt?: string;
  timezone: string;
  location?: string;
  participants?: string[];
  status: "tentative" | "confirmed" | "changed" | "cancelled" | "completed" | "uncertain";
  confidence: number;
  sourceMessageIds: string[];
  sourceTranscriptSegmentIds?: string[];
  supersedesEventId?: string;
  createdAt: string;
  updatedAt: string;
};
```

### Benachrichtigungen

Implementiere einen austauschbaren Notification-Adapter.

Standard:

- lokale macOS-Benachrichtigung,
- konfigurierbare Vorlaufzeit, beispielsweise 30 Minuten,
- sofortige Änderungsbenachrichtigung,
- optionale tägliche Zusammenfassung,
- Ruhezeiten,
- Deduplizierung über stabilen Reminder-Key,
- Snooze und Erledigt-Markierung,
- keine wiederholten Benachrichtigungen nach Neustart,
- kein Versand an WhatsApp ohne explizite Aktivierung.

#### Hintergrundbetrieb und macOS-Integration

- Der Ingest-, Resolver-, Reminder- und Notification-Worker muss als lokaler macOS-Benutzerprozess laufen, auch wenn kein Browserfenster geöffnet ist.
- Installiere/konfiguriere dafür einen benutzerbezogenen `LaunchAgent`, der beim Login startet, bei Absturz neu startet und einen Health-Status bereitstellt.
- Das Dashboard im Browser ist optional und darf nur Konfiguration, Status und Zusammenfassungen anzeigen.
- Die lokale Benachrichtigung muss über die macOS Notification Center-/System-Benachrichtigungsinfrastruktur erfolgen, damit sie als normale Banner oben rechts erscheint.
- Fordere die macOS-Benachrichtigungsberechtigung einmal beim Setup an und zeige einen klaren Fehlerstatus, wenn sie verweigert wird.
- Der Worker muss nach Sleep/Wake oder temporärem Netzwerkverlust automatisch reconnecten und fehlende Events idempotent nachverarbeiten.
- Wenn der Mac ausgeschaltet ist, kann keine lokale Echtzeitbenachrichtigung erzeugt werden. Nach dem nächsten Start/Login muss der Worker den verpassten Zeitraum prüfen und höchstens eine konsolidierte, noch relevante Benachrichtigung senden.
- Beim Aufwachen niemals eine Benachrichtigung pro verpasster Nachricht senden. Stattdessen nur den aktuellen aktiven Termin-/Aufgabenstatus und tatsächlich wichtige Änderungen melden.
- Ein Docker-Container allein genügt nicht als Produktanforderung, wenn die macOS-Benachrichtigung davon abhängt, dass ein Browser offen ist. Falls Docker für Backend oder Datenbank verwendet wird, muss der macOS-LaunchAgent die benötigten Dienste überwachen und die lokale Notification-Brücke unabhängig vom Browser ausführen.

#### Benachrichtigungszustand

Speichere pro Ereignis und Kanal einen deduplizierten Zustand mit mindestens:

- `eventId`,
- gemeldeter Event-Version,
- Benachrichtigungstyp,
- Fälligkeitszeitpunkt,
- Versandstatus,
- Versandzeitpunkt,
- optionalem Wake-up-/Recovery-Grund.

Ein Prozessneustart, ein Browser-Refresh, eine erneute Transkription oder ein unverändertes Summary darf dadurch keine zweite identische Meldung erzeugen.

Beispiele:

- „Neuer möglicher Termin: Heute, 15:00 Uhr – Quelle: Nachricht vom …“
- „Termin geändert: Heute 15:00 → 16:00 Uhr“
- „Termin abgesagt: Treffen heute um 15:00 Uhr“
- „Termin unsicher: Uhrzeit fehlt – bitte prüfen“

### Sicherheit und Datenschutz

- Chat-Allowlist statt pauschaler Verarbeitung aller Kontakte.
- Konfigurierbarer Kill-Switch.
- Verschlüsselte Speicherung von Session-State, Medien und sensiblen Feldern.
- Keine Nachrichteninhalte in normalen Logs.
- Keine Tokens, QR-Codes oder Auth-Dateien in Git.
- Konfigurierbare Aufbewahrungsdauer für Rohdaten, Audio und Transkripte.
- Sichere Löschung einer Chat- oder Kontoinstanz.
- Redaction in Fehlerlogs.
- Auditierbare Verarbeitung ohne Klartextkopien in Logs.
- Einwilligung, Rechtsgrundlage und Löschkonzept dokumentieren; dies ersetzt keine Rechtsberatung.

### Zuverlässigkeit

Implementiere:

- idempotente Verarbeitung,
- Persistenz vor Weiterverarbeitung,
- Retry mit Exponential Backoff,
- Dead-Letter-Queue,
- Wiederaufnahme nach Neustart,
- per Chat geordnete Verarbeitung,
- Schutz vor doppelten Audio-Downloads,
- Schutz vor doppelten Erinnerungen,
- Health- und Readiness-Endpunkte,
- sichtbaren Zustand für WhatsApp-Verbindung, Import, Transkription und Benachrichtigungen.

### Tests

Schreibe automatisierte Tests für:

1. Textnachricht.
2. Audio-/Sprachnachricht.
3. Nicht verfügbare Mediendatei.
4. Fehlgeschlagene Transkription.
5. Nachrichten von mir und von anderen.
6. Historische Nachrichten ohne Notification.
7. Doppelte Events.
8. Reconnect und Wiederaufnahme.
9. Bearbeitete Nachricht.
10. Gelöschte Nachricht.
11. Zitat und Antwort.
12. Gruppenchat.
13. „Heute um 15 Uhr“.
14. „Morgen um 9 Uhr“.
15. Sommer-/Winterzeit.
16. „Verschoben auf 16 Uhr“.
17. „Abgesagt“.
18. Zwei gleiche Termine ohne Duplikat.
19. Niedrige Konfidenz.
20. Request-/Replay-Validierung.
21. Keine Rohdaten in Logs.
22. Keine Benachrichtigung bei reinem History-Import.

### Abnahmekriterien

Die Implementierung gilt erst als fertig, wenn:

- ein autorisiertes Konto sicher gekoppelt werden kann,
- neue Text- und Sprachnachrichten dauerhaft und idempotent gespeichert werden,
- eine Sprachnachricht transkribiert oder sauber als fehlgeschlagen markiert wird,
- Zusammenfassungen nur belegte Informationen enthalten,
- Termine mit Quellen und Vertrauenswerten gespeichert werden,
- Terminänderungen denselben Termin aktualisieren,
- Erinnerungen nach Neustart nicht doppelt ausgelöst werden,
- historische Nachrichten keine falschen neuen Benachrichtigungen auslösen,
- Verbindungsabbrüche automatisch behandelt werden,
- private Daten nicht in Logs oder Git landen,
- bekannte Datenlücken sichtbar angezeigt werden,
- README einen vollständigen Start-, Backup-, Lösch- und Recovery-Ablauf enthält.

### Arbeitsweise

Arbeite in dieser Reihenfolge:

1. Machbarkeitsprüfung.
2. Repository- und Dependency-Audit.
3. Threat Model.
4. Architektur- und Datenmodell.
5. Implementierung des Adapters.
6. Persistenz und Job-Verarbeitung.
7. Medien- und Transkriptionspipeline.
8. Ereignis-/Terminparser.
9. Notifications.
10. Tests.
11. Security- und Datenschutzprüfung.
12. Dokumentation.

Wenn eine technische Voraussetzung nicht sicher erfüllt werden kann, implementiere keinen Schein-Fallback. Dokumentiere stattdessen die Einschränkung, die betroffenen Datenlücken und die beste Alternative.

## Quellen, die der Coding-Agent vor der Umsetzung prüfen muss

- das getrennte lokale Referenz-Repository `device-activity-tracker`
- https://github.com/WhiskeySockets/Baileys/blob/master/README.md
- https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg
- https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference
- https://www.postman.com/meta/whatsapp-business-platform/folder/1dtuocp/messages-object
