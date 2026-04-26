# Ticketsystem

Ein webbasiertes Ticketsystem zur Verwaltung von Bug-Reports und Feature-Requests.

Das Projekt befindet sich im Unterordner [ticketsystem/](ticketsystem/).

## Schnellstart

```bash
cd ticketsystem
npm install
# .env Datei erstellen (siehe README in ticketsystem/)
npm start
```

Weitere Informationen: [ticketsystem/README.md](ticketsystem/README.md)

## Coolify Deployment

Nutze in Coolify den Dockerfile-Pfad `ticketsystem/Dockerfile`.
Details zu Environment-Variablen und Persistent Volume stehen in [ticketsystem/README.md](ticketsystem/README.md).

Alternativ (ohne Pfad-Konfiguration in Coolify) kann das Root-Dockerfile `Dockerfile` verwendet werden.
