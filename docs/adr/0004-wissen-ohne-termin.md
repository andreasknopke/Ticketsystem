# Wissen darf ohne Termin entstehen

Project Atlas hing Workflows, Probleme und Adoptionsrisiken zwingend an ein
Meeting (Transkript als Quelle). Dieses Repository lässt `meeting_id` optional:
ein Eintrag gehört immer zu einem **Projekt**, kann aber aus einem Termin
stammen oder direkt erfasst werden (`meeting_id IS NULL`).

Grund: die Bestandsaufnahme speist sich nicht nur aus Gesprächen. Ein
Anforderungsdokument, eine Prozessbeschreibung oder eine Beobachtung aus dem
Pilotbetrieb erzeugen Wissen ohne zugehörigen Termin. Ein erzwungener Termin
würde zu Pseudo-Terminen führen („Dokument gelesen"), die den Kalender
verwässern und die Herkunft verfälschen.

Die Herkunft bleibt sichtbar: Einträge mit Termin zeigen ihn an, direkte
Einträge sind als „direkt erfasst" markiert. Damit bleibt die Rückverfolgbarkeit
erhalten, ohne dass Wissen an ein Ereignis gekettet wird.

Jeder Eintrag trägt zusätzlich `project_id` (immer gesetzt, aus Termin oder URL)
und `department_id` (aus dem Projekt abgeleitet). Beide werden serverseitig
gesetzt, nie vom Client übernommen.

Verworfen: ein Pflicht-Termin pro Projekt, an dem alle Dokumente hängen (eine
Quelle der Wahrheit wäre ein künstliches Konstrukt), sowie ein getrenntes
„Problem ohne Termin" mit eigener Tabelle (zwei Tabellen mit identischer
Bedeutung).
