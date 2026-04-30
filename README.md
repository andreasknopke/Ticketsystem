# Ticketsystem

Ein webbasiertes Ticketsystem mit Projektmanagement zur Verwaltung von Bug-Reports und Feature-Requests.

Das Projekt befindet sich im Unterordner [ticketsystem/](ticketsystem/).

## Features

- **Ticket-Management** mit SLA-Tracking und Feedback-System
- **Projektmanagement** mit Meilensteinen, Key-User-Verwaltung und Zeitleisten
- **Wiki-Dokumentation** pro Projekt mit Markdown und Mermaid-Flowcharts
- **GitHub-Integration** mit Issue-Sync und Webhook-Unterstützung
- **E-Mail-Benachrichtigungen** über SMTP oder Brevo API
- **Echtzeit-Updates** via Socket.io
- **KI-gestützter Ticket-Workflow** mit automatischer Triage, Security- und Planungsreviews, Coding-Bots und Approval-Prozess

## Schnellstart

```bash
cd ticketsystem
npm install
# .env Datei erstellen (siehe README in ticketsystem/)
npm run seed   # Testdaten mit Projekten, Meilensteinen und Wiki-Seiten
npm start
```

Weitere Informationen: [ticketsystem/README.md](ticketsystem/README.md)

## Coolify Deployment

Nutze in Coolify den Dockerfile-Pfad `ticketsystem/Dockerfile`.
Details zu Environment-Variablen und Persistent Volume stehen in [ticketsystem/README.md](ticketsystem/README.md).

Alternativ (ohne Pfad-Konfiguration in Coolify) kann das Root-Dockerfile `Dockerfile` verwendet werden.
