# Projekt bleibt die Einheit, die Abteilung wird ihm zugeordnet

Project Atlas (ADR-0001) verwirft bewusst eine Engagement-/Implementierungs-Entität
und macht **Department** zur Einheit der Integration. Dieses Repository behält
`projects` als Einheit und ordnet ihm genau eine Abteilung zu
(`projects.department_id`), statt Projekte abzuschaffen.

Der Grund: hier hängt bereits alles am Projekt — Meilensteine, Wiki-Seiten,
Termine, Key-User, Anhänge. Die Abteilung allein kann diese Dinge nicht tragen,
weil ein Projekt ein *zeitlich begrenzter* Rollout ist und die Abteilung ein
*dauerhafter* Organisationsbegriff. Ein Wiki-Eintrag oder ein Meilenstein ohne
Projekt wäre nicht datierbar und nicht abschließbar.

Damit gilt: **Hospital 1—n Department 1—n Projekt** und **Projekt n—1 System**
(ein Projekt führt genau ein System in genau einer Abteilung ein). Kennt man
das Projekt, kennt man Abteilung, Krankenhaus und System.

Verworfen: (a) Abteilung nur an Key-Usern, (b) Projekt n:m Abteilungen,
(d) Abteilung als projektunabhängige Wissensebene. (b) scheitert an der Frage,
welche Abteilung ein Meilenstein oder ein Wiki-Eintrag betrifft; (d) würde das
Projekt als Ordnungsrahmen verdoppeln.
