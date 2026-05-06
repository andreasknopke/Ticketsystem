# Ticket #9ccb62ec-292d-4117-b872-49e1776f04b6 — Coding-Dossier

> Dieses Verzeichnis enthaelt die vollstaendige Analyse des Ticketsystem-Workflows
> fuer Ticket #9ccb62ec-292d-4117-b872-49e1776f04b6. Es ist als Briefing fuer einen externen Coding-Agenten
> (z. B. OpenCode, VS Code Copilot) gedacht. Der Agent arbeitet direkt im Repo —
> die Analyse hier dient als Eingabe, nicht als Code-Vorlage.

## Eckdaten

- Titel: **Key User im Projekt**
- Typ: `bug`
- Dringlichkeit: `normal`
- System: Ticketsystem (`andreasknopke/Ticketsystem`)
- Workflow-Run: 118 (gestartet 2026-05-06 10:59:48)

## Inhalt

- [Triage Reviewer](./01_triage.md) — Status: `done`
- [Security & Redaction](./02_security.md) — Status: `done`
- [Final Approver (Dispatch-Decision)](./05_approval.md) — Status: `done`
- [Solution Architect (Planning)](./03_planning.md) — Status: `done`
- [Integration Reviewer](./04_integration.md) — Status: `done`
- [Final Approver (Dispatch-Decision)](./05_approval.md) — Status: `waiting_human`
- [Manifest (JSON)](./manifest.json)

## Original-Beschreibung (unredacted)

> Hinweis: Der `02_security.md`-Bericht enthaelt die redaktierte Variante,
> die fuer KI-Aufrufe verwendet wurde.

```
Die Key User Verwaltung im Projekt ist falsch. Hier sollen keine Mitarbeiter vom Ticketsystem verwaltet werden, sondern User der externen Projekte, z.B. CuraFlow, für die das Projekt angelegt wurde. Deshalb muss es Freitext Edits geben, wo man die User Daten eintragen kann und zu diesen auch Information updaten kann (z.b. hat Schulung absolviert, hat ersten Test durchgeführt etc.)
```