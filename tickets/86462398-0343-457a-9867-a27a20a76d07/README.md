# Ticket #86462398-0343-457a-9867-a27a20a76d07 — Coding-Dossier

> Dieses Verzeichnis enthaelt die vollstaendige Analyse des Ticketsystem-Workflows
> fuer Ticket #86462398-0343-457a-9867-a27a20a76d07. Es ist als Briefing fuer einen externen Coding-Agenten
> (z. B. OpenCode, VS Code Copilot) gedacht. Der Agent arbeitet direkt im Repo —
> die Analyse hier dient als Eingabe, nicht als Code-Vorlage.

## Eckdaten

- Titel: **sortierung der key user nach schulungsgrad**
- Typ: `feature`
- Dringlichkeit: `normal`
- System: Ticketsystem (`andreasknopke/Ticketsystem`)
- Workflow-Run: 180 (gestartet 2026-06-01 18:59:41)

## Inhalt

- [Triage Reviewer](./01_triage.md) — Status: `done`
- [Security & Redaction](./02_security.md) — Status: `done`
- [Solution Architect (Planning)](./03_planning.md) — Status: `done`
- [Integration Reviewer](./04_integration.md) — Status: `done`
- [Final Approver (Dispatch-Decision)](./05_approval.md) — Status: `waiting_human`
- [Manifest (JSON)](./manifest.json)

## Original-Beschreibung (unredacted)

> Hinweis: Der `02_security.md`-Bericht enthaelt die redaktierte Variante,
> die fuer KI-Aufrufe verwendet wurde.

```
Aktuell: im projekte tab gibt es key user die verschiedene atribute haben. Schulungsstatus,	Test-Protokoll, und	Notizen sind nur text felder. es ist schwer eine uebersicht ueber den algemeinen autreach und die implementierung zu gewinnen.
besser waere es, wenn man im jeweiligen projekt verschiedene schulungsziele definieren koennte. das text feld "schulungsstatus" koennte dann statdessen eine liste mit verschiedenen check boxen sein. zb: intro mail wurde gesendet, account erstellt, software installiert, feedback gegeben. Welche checkboxen im jeweiligen projekt verfuegbar sind, kann der ticketsystem admin definieren. vielleicht unter dem tab "key user", befor die tabelle der user beginnt. 
wichtig ist, dass das textfeld "schulungsstatsus" noch nicht entfernt wird, da aktuell schon informationen ueber die jeweiligen user dort gespeichert ist.
```