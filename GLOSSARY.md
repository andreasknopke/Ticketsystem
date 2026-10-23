# Ticketsystem

Ein Ticketsystem mit Projektmanagement für die Einführung von Software in
Krankenhäusern. Es verbindet den operativen Support (Tickets zu Bugs und
Feature-Wünschen) mit dem Einführungsgeschäft (Projekte, Meilensteine, Key-User,
Termine) und erfasst das dabei entstehende Implementierungswissen.

## Language

### Organisationen

**Hospital**:
Eine Gesundheitseinrichtung, deren Abteilungen auf die Software gebracht werden.
Der Pilot ist ein einzelnes Klinikum; weitere Krankenhäuser folgen später.
_Avoid_: Kunde, Klinik, Standort, Mandant

**Department**:
Eine Abteilung innerhalb eines Krankenhauses, die ihre Prozesse eigenständig
führt (z. B. Radiologie-Ärzte, Radiologie-Pflege). Sie ist die Einheit, die
eingeführt, konfiguriert und gemessen wird.
_Avoid_: Station, Team, Bereich, Einheit

### Software

**System**:
Ein Softwareprodukt, das eingeführt oder supportet wird — Schreibdienst,
CuraFlow, das Ticketsystem selbst. Tickets und Projekte verweisen darauf.
_Avoid_: Anwendung, App, Produkt, Tool, Software

**Projekt**:
Die Einführung eines Systems in genau einer Abteilung eines Krankenhauses. Trägt
Meilensteine, Wiki, Termine und Key-User; ist zeitlich begrenzt.
_Avoid_: Vorhaben, Engagement, Implementierung, Rollout

### Termine und Wissen

**Termin**:
Ein Ereignis mit einer Abteilung zu einem festen Zeitpunkt (Onboarding-Gespräch,
Schulung, Review). Trägt optional ein Transkript und ist der Anker für alles, was
daraus extrahiert wurde.
_Avoid_: Meeting, Session, Gespräch, Call, Appointment

**Transkript**:
Der mitgeschriebene Text eines Termins; die Rohquelle, aus der Workflows,
Probleme und Adoptionsrisiken gewonnen werden. Eines pro Termin.
_Avoid_: Notizen, Protokoll, Aufzeichnung, Mitschrift

**Workflow**:
Die aktuelle (Ist-)Arbeitsweise einer Abteilung für einen Prozess, vor der
Einführung. Zielzustand wird nur in Empfehlungen und Konfigurationen beschrieben,
nie als zweiter Soll-Workflow.
_Avoid_: Prozess, Ablauf, Current State

**Problem**:
Ein Mangel im **aktuellen (alten) Workflow** einer Abteilung, den die Einführung
beheben soll. Entsteht aus einem Termin und gehört zu einer Abteilung.
_Avoid_: Issue, Ticket, Bug, Pain Point, Anforderung

**Adoptionsrisiko**:
Ein Grund, warum eine Abteilung trotz Verbesserung nicht wechseln will (z. B.
keine Zeit zum Lernen). Ein Hindernis für den Wandel, kein Mangel im Workflow;
wird durch Change Management adressiert, nicht durch Softwareänderung.
_Avoid_: Blocker, Widerstand, Hindernis, Risiko

### Support

**Ticket**:
Eine Anfrage zur **neuen Software**: entweder ein Fehler (`bug`) oder ein
Feature-Wunsch (`feature`). Durchläuft Triage, SLA und den KI-Workflow.
_Avoid_: Problem, Anfrage, Case, Issue

**Stakeholder**:
Eine Person, die für eine Seite eines Rollouts spricht — Abteilungsleitung,
Kliniker, IT-Kontakt. Nimmt an Terminen teil.
_Avoid_: Nutzer, Kontakt, Teilnehmer, Person
