# Der Soll-Workflow zeigt auch, was CuraFlow nicht tut

Die KI-Ableitung im Flow-Reiter darf den Ablauf verkürzen, aber nicht
beschönigen. Zwei Dinge fallen **nie** weg, unabhängig vom gewählten
Detailgrad:

1. **Lanes/Swimlanes** — jede beteiligte Rolle bzw. Abteilung behält ihre Lane,
   auch wenn sie nur einen Schritt beisteuert.
2. **Arbeit außerhalb von CuraFlow** — Unterschrift, Papier, Telefon, Excel,
   Fremdsystem, Sichtkontrolle. Solche Schritte bleiben eigene Schritte mit
   `funktion: gap` oder `funktion: manuell` und ihrer Rolle.

Grund: das System dient der Dokumentation der Arbeit mit den Anwendern und der
Darstellung des Nutzens der neuen Software. Ein Soll-Workflow, der nur die
CuraFlow-Funktionen zeigt, erzeugt im Beratungsgespräch den Eindruck, die
Software erledige den ganzen Ablauf. Später heißt es dann „das war doch
zugesagt". Die ehrliche Darstellung schützt beide Seiten: sie zeigt den Nutzen
und benennt gleichzeitig, was bleibt.

Der Detailgrad (`grob` / `mittel` / `fein`) entscheidet deshalb nur, wie stark
Tätigkeiten **innerhalb** von CuraFlow zusammengefasst werden — nicht, ob
Rollen und externe Arbeit verschwinden. Bei grobem Grad wird innerhalb von
CuraFlow stärker gebündelt, bis das Aktivitätslimit passt.

Umgesetzt in `services/atlas/detailLevel.js` (`NEVER_OMIT`, gilt für jeden Grad
und jeden Ableitungstyp) sowie in `SOLL_SYSTEM_PROMPT`,
`SOLL_BPMN_SYSTEM_PROMPT`, `BPMN_SYSTEM_PROMPT` und
`BPMN_REFINE_SYSTEM_PROMPT`.

Verworfen: die Regel nur im groben Detailgrad zu nennen (sie gilt immer) und
externe Schritte als Freitext in der Zusammenfassung zu belassen, statt sie als
Aktivität mit Lane zu modellieren (dann fehlen sie im Diagramm).
