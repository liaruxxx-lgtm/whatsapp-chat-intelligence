# Threat Model

Stand: 2026-09-21

## Schutzgüter

- WhatsApp-Session und QR-/Pairing-Geheimnisse
- Private Nachrichten, Teilnehmerdaten, Audio und Transkripte
- Abgeleitete Termine, Aufgaben, Zusammenfassungen und Benachrichtigungen
- Lokaler Verschlüsselungsschlüssel und exportierte Backups
- Integrität des Termin- und Benachrichtigungszustands

## Angreifer und Fehlermodi

| Risiko | Schutzmaßnahme | Verifikation |
| --- | --- | --- |
| Versehentliche Verarbeitung nicht autorisierter Chats | Leere Allowlist, Gate vor jeder Speicherung/Medienverarbeitung | Unallowlisted-Chat-Test erwartet keine DB-, Transkriptions- oder Notification-Nebenwirkung. |
| Session-/Token-Leak | Session außerhalb des Repo, `.gitignore`, kein QR-/Payload-Logging, Encryption-Key nur per Umgebung/Keychain-Bridge | Git-Ignore- und Redaction-Tests; keine Secrets in Beispieldateien/Dokumentation. |
| QR-Leak während Kopplung | QR nur als flüchtiges Bild für `127.0.0.1`, `Cache-Control: no-store`, keine Speicherung oder Logausgabe; alle Dashboard-Routen lehnen nicht-loopback `Host`-Header ab | Setup-Code hält nur einen In-Memory-Wert und verwirft ihn bei Verbindung; Dashboard-Test weist fremden Host auch auf Lesepfaden ab. |
| Cross-Site-Request oder Clickjacking erweitert die Allowlist | Mutationen brauchen exakt gleiche Loopback-Origin, `application/json` und eine je Dashboard-Prozess zufällige Capability; keine CORS-Freigabe, Framing ist verboten | Dashboard-Security-Test weist Cross-Origin-, Simple-POST-, capability-lose und Frame-Versuche ab. |
| Manipulierte/replayed Linked-Device-Events | Gepinnte gepatchte Baileys-Version, `requestId`-Drop, globaler `FULL`-History-Import aus; `INITIAL_BOOTSTRAP`/`RECENT` nur ephemer für Metadaten/Cursor, kanonische IDs + Unique-Constraints | Replay-/Request-ID-Test; Dependency/Lockfile-Audit. |
| Falsche Termin-Fakten | Deterministischer Parser, Quellen-IDs, Confidence, Versionen, `uncertain` statt Raten | Zeit-, Änderung-, Absage- und Low-confidence-Tests. |
| Unbelegte Modell-Zusammenfassung | Provider-neutraler, fest strukturierter Summary-Vertrag; Quelle jeder Task-/Termin-Ableitung muss zu bekannten Event-Quellen gehören | Summary-Test weist eine fremde Quellen-ID vor Persistenz ab. |
| Versehentlicher oder überbreiter externer Chatversand | OpenAI-Zusammenfassung ist standardmäßig aus, nur für Allowlist-Chats verfügbar, pro Lauf lokal zu bestätigen und auf 500 neueste Text-/Transkript-Nachrichten begrenzt; keine Medien/JIDs/Teilnehmer-IDs, feste OpenAI-API-Origin, `store: false`, Quellenbindung und verschlüsselte lokale Ablage | Laufzeit-Gate prüft Allowlist, Freigabeschalter, API-Schlüssel und Nutzerbestätigung; Modellquellen werden gegen genau die gesendeten IDs geprüft. |
| Prompt Injection in Nachrichtentext oder Modell-Rückgabe | Chat-Inhalte werden explizit als nicht vertrauenswürdige Daten behandelt; es gibt keine Tools/Funktionen, Modellquellen müssen gültig sein, strukturiertes Schema und Konfidenzprüfung werden vor Speicherung erzwungen | Provider prüft Form, Quellen-IDs und Konfidenzwerte; API-Fehler protokollieren nur sichere Fehlercodes. |
| OpenAI-Retention oder unerwartete API-Kosten | Transparenter Hinweis im Dashboard plus Bestätigung je Anfrage; Responses-API-`store:false`; API-Trainingsnutzung und Standard-30-Tage-Abuse-Monitoring-Retention werden offengelegt | Dashboard zeigt Datenübertragung und Retentionshinweis vor jedem POST; Schlüssel nicht an den Browser ausgegeben. |
| Doppelte oder verlorene Notifications | Eventrevision + stabiler Delivery-Key, `sending`-Claim, Erfolg erst nach macOS-Brücke, Recovery-Konsolidierung | Duplicate-, fehlgeschlagener-Bridge-, Restart-, History- und Sleep/Wake-Tests. |
| Reihenfolgefehler bei konkurrierenden Eingängen | Pro-Chat-Serialisierung vor Resolver/Reminder; persistierte Idempotenz bleibt für Neustarts maßgeblich | Test kombiniert verzögerte Audio-Transkription mit nachfolgender Terminänderung. |
| Inhaltsleak in Logs | Strukturiertes Logging ohne Bodies, zentrale Redaction | Test sucht Nachrichteninhalt nicht in Logs. |
| Medienmissbrauch/Dateiangriff | Audio-MIME-/Größenlimits vor Vault/Transkription, SHA-256, externe Dateinamen nie vertrauen, private Ablage | Oversize-, Media-unavailable- und transcription-failed-Tests. |
| Bösartiger oder falsch ausgewählter Chat-Export | Separater Offline-Adapter liest nur eine absolute reguläre Nicht-Symlink-UTF-8-Datei unter festen Größen-/Record-Limits; die Zielchat-Allowlist wird **vor** dem Dateilesen geprüft | Import-Test prüft Allowlist-vor-Read, UTF-8-/Pfad-Ablehnung, ambige Datums- und DST-Gap-Behandlung. |
| Falsche Vollständigkeits- oder Medienannahme beim Chat-Export | Quelle bleibt `chat_export`/historisch, erzeugt keine Reminder; ZIPs, Begleitdateien und Platzhalter-Medien werden nicht eingelesen oder als vorhanden markiert | Import-Test erwartet keine Notification; Architektur/README dokumentieren Datenlücken und Mediengrenze. |
| Medieninhalt im Ruhezustand | Hashbasierter Vault-Pfad, AES-256-GCM-Envelope, Dateirechte `0600`, Integritätscheck vor Lesen | Fixture-Audio wird verschlüsselt abgelegt und als Originalbytes zurückgelesen getestet. |
| Klartext in Transkriptmetadaten | Aggregattext **und Segment-JSON** liegen in getrennten AES-256-GCM-Envelopes; Legacy-Segmentspalten werden beim Öffnen migriert/überschrieben | SQLite- und WAL-Regressionstest sucht den Segmenttext explizit. |
| Zu breite Retention/Löschung | Retention löscht abgelaufene Nachrichten und verwaiste Vault-Dateien; Chat- und Gesamtinstanzlöschung sind auf den validierten App-Datenpfad begrenzt | Lifecycle-Test prüft Chat-Scope, Export und vollständige Instanzartefakte. |
| Verlust oder unvollständige Quelle | Quelltyp, Datenlücken- und Statusfelder, best-effort-Kennzeichnung | History importiert ohne Reminder; fehlende Medien bleiben sichtbar. |
| Browser-/Docker-Abhängigkeit | Worker/LaunchAgent statt Frontend-Lebenszyklus | Worker-Continuity-Test ohne Dashboard. |

## Vertrauensgrenzen

1. WhatsApp bzw. ein externer Webhook liefern untrusted input. Der Adapter normalisiert und validiert ihn, bevor die App ihn verarbeitet.
2. Baileys ist nicht die offizielle WhatsApp Business API. Der Personal-Adapter bleibt mit sichtbarem Risiko opt-in und ohne Vollständigkeitsversprechen.
3. Lokale Modell- oder FFmpeg-Prozesse sind isolierte Subprozesse; fehlende/fehlgeschlagene Ausführung ist ein Status, keine Text-Erfindung.
4. Der Browser kann lokale Statusdaten lesen/konfigurieren, ist aber nicht berechtigt, Ingest oder Notifications zu erzwingen.
5. Der manuelle Summary-Button sendet den freigegebenen, begrenzten Textinhalt an OpenAI. Die Anwendung reduziert unnötige Identifikatoren; der API-Anbieter bleibt dennoch eine externe Verarbeitungsgrenze mit dessen geltenden API-Datenkontrollen und Retention.

## Privacy-by-default

Die App sendet keine WhatsApp-Nachrichten, setzt keine Presence, setzt keine Read Receipts und führt keine Kontaktaufzählung durch. Standardmäßig gibt es keine Cloud-Transkription, keine OpenAI-Zusammenfassung, keine Cloud-Datenbank und keine aktive Kontokopplung. Aufbewahrungsfristen, Export und sichere Instanzlöschung sind vor Live-Import einzeln bestätigungspflichtig und im lokalen Health-Status sichtbar.

## Restrisiken

Ein kompromittiertes angemeldetes macOS-Benutzerkonto kann lokale Daten und Benachrichtigungen sehen. Verschlüsselung mindert Diebstahl im Ruhezustand, ersetzt aber keine Betriebssystem-Härtung; lokale Routing-Metadaten und verschlüsselte Exportdateien benötigen denselben geschützten Benutzerkontext. Eine unerlaubte oder instabile Linked-Device-Nutzung kann zur Abmeldung oder unvollständigen Historie führen. Deshalb dokumentiert die Anwendung Datenlücken sichtbar und blockiert Live-Betrieb ohne bewusste Konfiguration.
