**Zusammenfassung:** {
  "summary": "Die Jahresansicht des Rotationsplaners (Training-Seite) wird erweitert, um zukünftige Jahre bis einschließlich 2030 anzuzeigen und zu planen.",
  "affected_areas": [
    "src/pages/Training.jsx",
    "src/components/training/ (z.B. TrainingYearView, YearSelector, GanttChart)",
    "src/api/client.js (eventuell Query-Key-Anpassungen)",
    "server/routes/dbProxy.js (nur falls Validierungen existieren)",
    "server/routes/schedule.js (Transfer/Übernahme-Logik prüfen)"
  ],
  "step

_Repo-Kontext aus: andreasknopke/CuraFlow_

**Risiken:**
- Antwort nicht parsebar