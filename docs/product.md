# Was ist das Ticketsystem?

Ein Ticketsystem mit integriertem Projektmanagement für die Einführung von
Software in Krankenhäusern.

## Zweck

Das System verbindet zwei Dinge, die sonst getrennt liegen:

1. **Support der neuen Software** — Tickets zu Fehlern (`bug`) und
   Feature-Wünschen (`feature`), mit SLA, Triage und KI-gestütztem Workflow.
2. **Begleitung der Einführung** — Projekte (ein System in einer Abteilung),
   Meilensteine, Termine mit Key-Usern, Wiki und das dabei entstehende
   Implementierungswissen.

Der zweite Teil ist der Grund, warum es dieses System gibt. Wer eine Abteilung
einführt, weiß nach dem Projekt noch, *warum* welche Entscheidung getroffen
wurde — und kann es beim nächsten Mal wiederverwenden. Ohne diese Erfassung
versickert das Wissen in Köpfen und verstreuten Notizen.

## Zielgruppe

- Implementierungsberatung, die Abteilungen auf die Software bringt
- Key-User und Abteilungsleitungen als Gegenüber im Rollout
- IT/Support, das später die Tickets der eingeführten Systeme bearbeitet

## Was es nicht ist

- **Kein Customer-Support-Tool.** Tickets betreffen die *neue* Software, nicht
  die Anfragen von Endnutzern an eine Service-Hotline.
- **Kein Ersatz für das KIS.** Es integriert nicht in Klinikprozesse, es
  begleitet deren Einführung.
- **Kein Projektmanagement für beliebige Vorhaben.** Ein Projekt ist immer die
  Einführung eines Systems in genau einer Abteilung.
- **Kein Wissensmanagement-Vollprodukt.** Semantische Suche, LLM-Extraktion und
  abteilungsübergreifende Empfehlungen sind bewusst nicht Teil des aktuellen
  Stands.

## Zentrale Begriffe

Siehe [GLOSSARY.md](../GLOSSARY.md). Entscheidungen siehe [docs/adr/](./adr/).
