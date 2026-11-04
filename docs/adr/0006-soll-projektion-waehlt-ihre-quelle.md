# Die Soll-Projektion wählt ihre Quelle

Bis hierher leitete der Flow-Reiter den Soll-Workflow ausschließlich aus dem
CuraFlow-Funktionskatalog ab. Das Projekt kann aber ein anderes System
einführen (z. B. Schreibdienst), und manchmal gibt es (noch) keinen
maschinenlesbaren Katalog. Deshalb wählt der Nutzer vor dem Erstellen die
**Quelle** der Projektion:

1. **Funktionskatalog eines Systems** — CuraFlow, Schreibdienst. Jede Quelle
   hat einen eigenen Env-Prefix (`CURAFLOW_BASE_URL`, `SCHREIBDIENST_BASE_URL`,
   dazu `_CATALOG_TOKEN`, `_CATALOG_TIMEOUT_MS`, `_CATALOG_TTL_MS`). Bezogen
   wird jeweils `<Basis>/api/catalog/flow`; der Cache ist pro Quelle getrennt.
2. **Freitext** — der Nutzer beschreibt selbst, wie er sich den Ablauf künftig
   vorstellt. Diese Beschreibung ersetzt den Katalog: das Modell nennt keine
   Funktions-ids, sondern leitet die Schritte aus Ist-Zustand und Beschreibung
   ab.

Die Wahl wird am Soll-Workflow gespeichert (`source`, `source_text`), damit die
Herkunft später nachvollziehbar bleibt und die Diagramm-Überarbeitung weiß, ob
sie ids nennen darf. Alte Zeilen ohne `source` gelten als CuraFlow.

Ist eine gewählte Katalogquelle nicht konfiguriert oder nicht erreichbar,
antwortet die Route mit **409** und dem Grund, statt eine Projektion zu
erzeugen, in der jeder Schritt `gap` ist. Eine solche Ausgabe sieht aus wie ein
Ergebnis, ist aber keine: sie nennt keine einzige Funktion und würde im
Beratungsgespräch als „CuraFlow kann nichts davon" gelesen. Der Hinweis nennt
deshalb Freitext als Alternative.

Verworfen: eine feste CuraFlow-Bindung (passt nicht zu Projekten mit anderem
System), ein automatischer Fallback auf Freitext (der Nutzer soll wissen, worauf
sich die Ableitung stützt) und ein Katalog-Upload pro Projekt (mehr Pflege als
Nutzen; die Quellen sind Systemeigenschaften, keine Projektentscheidungen).
