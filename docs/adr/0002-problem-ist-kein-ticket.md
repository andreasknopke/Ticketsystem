# Problem und Ticket sind verschiedene Dinge

Ein **Problem** ist ein Mangel im *aktuellen (alten) Workflow* einer Abteilung,
den die Einführung beheben soll. Ein **Ticket** ist eine Anfrage zur *neuen
Software*: ein Fehler (`bug`) oder ein Feature-Wunsch (`feature`). Beide bekommen
eine eigene Tabelle (`problems` vs. `tickets`), auch wenn sie sich im Alltag
überschneiden können.

Verworfen: `tickets.type = 'problem'`. Das Ticket trägt SLA, Priorität, Triage,
KI-Workflow und eine Zustandsmaschine (offen → in Bearbeitung → geschlossen).
Ein Problem wird stattdessen *konfiguriert* und verschwindet, wenn der neue
Workflow es nicht mehr hat. Diese beiden Lebenszyklen in einer Tabelle zu
vereinen würde jedes Ticket-Query um eine Bedeutung erweitern, die es nicht hat.

Die Verbindung entsteht bei Bedarf als Verknüpfung (*Problem erzeugt Ticket*),
nicht als Identität. Damit bleibt "Problem ≠ Ticket" auch dann wahr, wenn aus
einem Problem ein Ticket wird.
