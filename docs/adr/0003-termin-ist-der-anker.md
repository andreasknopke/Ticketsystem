# Termin ist der Anker für Wissensextraktion

Project Atlas modelliert ein `Meeting` mit Transkript, an dem Workflows, Probleme,
Adoptionsrisiken und Stakeholder hängen. Dieses Repository hat bereits
`key_user_meetings` (Einladung, ICS, Follow-up-Kette) und nennt diese Ereignisse
in der Oberfläche **Termine**. Wir erweitern `key_user_meetings` um ein optionales
Transkript und hängen die Extraktion an den Termin, statt eine zweite
`meetings`-Tabelle einzuführen.

Grund: das Onboarding-Gespräch mit der Radiologie *ist* der Termin mit den
Key-Usern. Zwei Tabellen für dasselbe Ereignis erzwingen Doppelerfassung, und
Doppelerfassung ist der Grund, warum solche Wissenssysteme nicht benutzt werden.
Der kanonische Begriff ist **Termin**; "Meeting" wird aus dem Wortschatz gestrichen.

Die Abteilung ist über den Termin ableitbar (`Termin → Projekt → Abteilung`),
deshalb braucht der Termin kein eigenes `department_id`.
