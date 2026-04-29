**Verdikt:** `approve_with_changes`
**Empfohlener Coding-Level:** `medium`
_Die Änderungen beschränken sich auf das Frontend und erfordern keine neue Backend-Logik, aber die korrekte Umsetzung der Zeitfilter und des Datentransfers erfordert Sorgfalt._

Die Erweiterung des bestehenden Trainings-/Rotationsplaners um eine Mehrjahresansicht passt grundsätzlich zu dem vorhandenen System. Eine solche Ansicht erweitert die bestehende Jahresübersicht und nutzt die vorhandenen Tabellen (training_rotations, shift_entries) sowie die generische CRUD-API. Der Plan ist jedoch zu vage formuliert und muss konkretisiert werden.

**Integrationsrisiken:**
- Performance-Engpässe bei vielen Rotationseinträgen über mehrere Jahre, wenn alle Daten auf einmal geladen werden.
- Verwechslungsgefahr beim Transfer von Rotationen aus vergangenen Jahren in den aktuellen Dienstplan (es dürfen nur zukünftige oder aktuelle Rotationen übertragen werden).
- UI-Konflikte mit der bestehenden Jahres‑/Wochennavigation im Trainingsmodul.

**Empfohlene Aenderungen:**
- Lade-Strategie definieren: entweder paginiert nach Jahren oder alle Einträge im Hintergrund laden, aber mit Caching.
- Transfer-Button nur für Einträge anbieten, dessen Zeitraum in der Zukunft liegt oder den aktuellen Plan betrifft.
- Visuelle Trennung zwischen aktuell geplantem Jahr und archivierten/vergangenen Jahren (z.B. durch Ein- und Ausblenden) vorsehen.
- Rückwärtskompatibilität zur bestehenden Jahresansicht sicherstellen – die bisherige Ansicht sollte unverändert funktionieren, wenn der Benutzer die Mehrjahresansicht nicht aktiviert.