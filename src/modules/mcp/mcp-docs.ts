/**
 * Doku-Auszuege als MCP-Ressourcen (`openeos://docs/<slug>`), damit ein
 * Agent Bedienfragen beantworten kann, ohne das Netz zu durchsuchen.
 *
 * Quelle: openeos-docs, Branch `dev`, `docs/<slug>.md` — gekuerzt auf
 * das, was ein Agent fuer die Einrichtung braucht (keine Screenshots,
 * keine Installationsanleitungen). Bei groesseren Aenderungen an der
 * Doku hier nachziehen.
 */
export interface McpDoc {
  slug: string;
  title: string;
  description: string;
  text: string;
}

export const MCP_DOCS: McpDoc[] = [
  {
    slug: 'produkte',
    title: 'Produkte',
    description: 'Produkte anlegen, bepreisen, Icons, Bestand, Import aus der Speisekarte.',
    text: `# Produkte

Unter **Produkte** verwaltest du das Sortiment einer Veranstaltung – alles, was an der Kasse verkauft wird. Jedes Produkt hat mindestens einen Namen und einen Preis und gehört zu einer Kategorie. Produkte gehören immer zu einer Veranstaltung.

## Produkt erstellen
- **Name** (Pflicht), **Kategorie**, **Beschreibung** (die erste Zeile erscheint als zweite Zeile der Kachel, z. B. „0,5 l“), **Preis** (Pflicht, brutto in Euro), **MwSt.** (Prozent; mit „Keine Umsatzsteuer“ in der Organisation immer 0).
- Optional ein **Produkt-Icon** (\`pos-icon:<id>\`, Vorschläge über \`suggest_icons\`) oder ein Bild; ohne beides nimmt die Kasse das Icon der Kategorie.
- **Favorit**: Favoriten erscheinen an der Kasse ganz oben in der Kategorie „Favoriten“.
- **Optionsgruppen** (Varianten wie 0,3 l / 0,5 l, Beilagen): je Gruppe Name, Typ (single/multiple/ingredients), Pflicht, Optionen mit Aufpreis gegenüber dem Grundpreis.
- **Pfand**: einem Produkt wird eine Pfandart der Organisation zugeordnet (z. B. „Becher“ 2,00 €); der Betrag kommt aus der Pfandart.

## Produktliste und Status
Die Liste zeigt Name, Kategorie, Preis, Bestand und Status. **Verfügbar/ausverkauft** schaltet ein Produkt an der Kasse ab, ohne es zu löschen. **Aktiv** blendet es ganz aus.

## Bestand
- Verkauf reduziert den Bestand automatisch.
- Ohne hinterlegten Bestand („-“) wird kein Bestand geführt – sinnvoll für frisch zubereitete Speisen.
- Anfangsbestand und Korrekturen laufen über das Modul **Inventur**; sinnvoll vor allem für Getränkekisten, Pfandbecher usw.

## Produkte importieren
- **CSV-Import** mit Name, Kategorie, Preis, optional Pfand und Icon; Vorschau vor dem Anlegen.
- **Aus Speisekarte importieren** (Assistent-Funktion, Opt-in durch einen Admin): Fotos, PDF oder Text werden zu einem Vorschlag mit Kategorien, Produkten, Preisen, Steuersatz, Varianten und Icons; nur angehakte Zeilen werden angelegt. Vorschläge können Fehler enthalten – prüfen, bevor angelegt wird.

## Für Agenten
- Produkte je Veranstaltung über \`list_products\`, anlegen/ändern über \`upsert_products\` (erst Vorschau, dann \`confirm\`).
- Ausverkauft melden: \`update_product_availability\`.
- Kategorien zuerst anlegen (\`create_category\`) oder \`createMissingCategories\` nutzen.
`,
  },
  {
    slug: 'veranstaltungen',
    title: 'Veranstaltungen',
    description: 'Veranstaltungen anlegen, Kassiermodus, Tische, Testmodus und Freischaltung.',
    text: `# Veranstaltungen

Eine **Veranstaltung** (Event) ist der Rahmen für ein Fest oder einen Verkaufstag. Produkte, Preise, Stationen, Bestellungen und Auswertungen beziehen sich immer auf eine Veranstaltung.

## Veranstaltung erstellen
- **Name** (Pflicht), **Beschreibung**, **Startdatum** und **Enddatum** (ohne Enddatum ein Tag).
- **Kassiermodus**: *Sofort kassieren* (\`immediate\`; Theke, Imbiss – der Gast zahlt beim Bestellen) oder *Auf Deckel buchen* (\`tab\`; Bedienung am Tisch, „Senden“ schickt Runden an Küche und Theke, „Kassieren“ rechnet am Ende ab).
- **Tische**: *Keine Tische* (\`none\`, Thekenbetrieb), *Tischnummer frei eingeben* (\`free\`, Voreinstellung) oder *Vordefinierte Tische* (\`predefined\`, die Kasse bietet nur die angelegten Tische an; optional nur bestimmte Bereiche über \`areaIds\`).
- **Online-Shop** mit Öffnungszeiten und optionaler Servicegebühr.

Alle Angaben lassen sich später ändern; Kassen übernehmen Kassiermodus und Tische von selbst.

## Was eine Veranstaltung kostet
OpenEOS wird **pro Veranstaltungstag** abgerechnet. Ein Veranstaltungstag geht von 6 bis 6 Uhr Ortszeit; eine Nacht, die vor 6 Uhr endet, gehört zum Vortag. Endet die Veranstaltung nachts, als Enddatum den Tag wählen, an dem der Abend beginnt.

## Erst testen, dann bezahlen
Eine neue Veranstaltung ist zunächst **nicht freigeschaltet** (Status \`inactive\`). Im **Testmodus** (\`test\`) ist alles benutzbar – Kassen, Anzeigen, Drucker, Auswertung – begrenzt auf 25 Bestellungen. Beim **Freischalten** (Status \`active\`) werden die Testbestellungen gelöscht, die Einrichtung bleibt. Freischalten, Testmodus und Bezahlen (Karte, Lastschrift oder auf Rechnung) passieren in der Web-App; Agenten können das nicht auslösen.

## Immer nur eine aktive Veranstaltung
Die aktive Veranstaltung bestimmt, welche Produkte an der Kasse erscheinen und wohin Bestellungen gehen.

## Für Agenten
- \`list_events\`, \`get_event\`, \`create_event\` (legt immer \`inactive\` an), \`update_event\`.
- \`copy_event\` kopiert Kategorien und Produkte aus einer früheren Veranstaltung; Steuersatz, Pfand und Stationen danach mit \`upsert_products\` nachziehen.
- Produktionsstationen (Küche, Grill, Theke) je Veranstaltung: \`list_production_stations\`, \`create_production_station\`; Drucker kommen aus \`list_printers\`.
`,
  },
  {
    slug: 'tische',
    title: 'Tische',
    description: 'Bereiche und Tische anlegen, Serien, Tischplan, Bezeichnungen.',
    text: `# Tische

Unter **Tische** legst du fest, in welchen **Bereichen** (z. B. *Zelt A*, *Saal*, *Biergarten*) welche **Tische** stehen und wie sie auf dem **Tischplan** liegen. Die Kasse zeigt die Tische als Liste und als Karte.

Bereiche und Tische gehören zur **Organisation**, nicht zu einer Veranstaltung – einmal anlegen, bei jedem Fest nutzen. **Ob** eine Veranstaltung Tische nutzt und **welche Bereiche**, stellst du in der Veranstaltung ein (Tische: \`predefined\`, optional \`areaIds\`). Bearbeiten dürfen Administratoren und Mitglieder mit dem Recht für Veranstaltungen.

## Bereiche
Jeder Bereich hat eine eigene Karte. Standardkarte 1200 × 800 Einheiten; ein Tisch ist 80 Einheiten groß. Beim Löschen eines Bereichs verschwinden seine Tische; Bestellungen bleiben.

## Tische anlegen
- **Einzeln**: eckig oder rund; der neue Tisch bekommt die nächste Nummer der Reihe.
- **Als Serie**: Bereich, **Präfix** (z. B. \`B\`, darf leer sein), **Start** und **Anzahl**, **Stellen** (2 → \`B01\` statt \`B1\`), Plätze, Form, Spalten für die Anordnung auf der Karte. Die Vorschau zeigt alle Bezeichnungen; belegte sind markiert.

**Bezeichnungen sind in der ganzen Organisation eindeutig** – einen Tisch \`12\` gibt es nur einmal. Mit mehreren Bereichen deshalb Präfixe wie \`A\` und \`G\` verwenden. Höchstens 20 Zeichen.

## Tischplan
Tische ziehen, drehen, Größe ändern; Deko (Theke, Bühne, Beschriftung), Wände, Zonen (Küche, gesperrt, Bar) und Raumform. **Inaktive** Tische bietet die Kasse nicht an, sie bleiben aber im Plan – besser als löschen, wenn ein Tisch nur zeitweise aufgebaut ist.

## Während des Fests
- **Umbenennen** geht jederzeit; offene Bestellungen bekommen die neue Bezeichnung, bezahlte behalten die alte.
- **Löschen** geht nur ohne offene Bestellungen.

## Für Agenten
- \`list_table_areas\` (mit Tischen), \`create_table_area\`, \`create_tables\` (Serie: Präfix, Start, Anzahl, Stellen), \`update_table\` (umbenennen, Plätze, Form, Bereich, inaktiv).
- Der Tischplan selbst (Positionen, Wände, Zonen) wird in der Web-App gezeichnet.
`,
  },
  {
    slug: 'drucker',
    title: 'Drucker',
    description: 'Drucker-Agent, Drucker übernehmen, Zuordnung zu Stationen und Kassen, Vorlagen, Bon-Workflows.',
    text: `# Drucker

Im Bereich **Drucker** verbindest du Bondrucker mit OpenEOS und legst fest, wie und wohin gedruckt wird. Drei Reiter: **Drucker**, **Vorlagen**, **Bon-Workflows**.

OpenEOS druckt auf **ESC/POS-Bondruckern** (Epson, Star, Bixolon und die meisten No-Name-Geräte, 58 oder 80 mm) per USB oder Netzwerk. Die Verbindung stellt der **Drucker-Agent** her – ein kleines Programm auf einem Windows- oder Linux-PC (auch Raspberry Pi) im Netz der Drucker. Er findet USB-, Windows- und Netzwerkdrucker, meldet sie an OpenEOS und druckt die Bons, die OpenEOS schickt.

## Agent verbinden
Beim ersten Start zeigt der Agent einen **sechsstelligen Code**. In der Web-App: **Drucker-Agent verbinden** → Code eingeben → Namen vergeben („Drucker-PC Küche“) → **Verknüpfen**. Danach erscheint der Agent in der Liste und sucht sofort nach Druckern.

## Drucker übernehmen
Gefundene Drucker sind erst nach **Übernehmen** nutzbar: Name („Küche“, „Theke“), **Druckertyp** (Kassenbon \`receipt\`, Küchenbon \`kitchen\`, Etikett \`label\`), **Papierbreite** (58/80 mm), **Kassenlade angeschlossen**. Netzwerkdrucker, die der Agent nicht findet, lassen sich manuell mit IP-Adresse und Port (meist 9100) anlegen. **Testdruck** prüft die ganze Kette.

## Drucker zuordnen
Ein übernommener Drucker druckt erst, wenn etwas an ihn gerichtet wird:
- **Produktionsstationen** (Küche, Grill, Ausgabe) – jede Station hat ihren Drucker; dort landen die Küchenbons der Produkte, die über Kategorie oder Produkt zu dieser Station gehören.
- **Bon-Workflows** – welche Bon-Arten automatisch gedruckt werden; je Bon-Art optional ein fester Drucker.
- **Kassen-Gerät** – Standarddrucker der Kasse (Kassenbons, Rückfall) und Drucker mit Kassenlade.

Stationsdrucker werden nur benutzt, wenn der Küchenbon im Modus **1 Bon pro Station** (oder pro Produkt) läuft.

## Vorlagen
Vorlagen bestimmen Inhalt und Layout der Bons (Kopfzeile, Positionen, Hinweise, Fußzeile). Typen: Kassenbon \`receipt\`, Küchenbon \`kitchen_ticket\`, Bestellbon \`order_ticket\`. Je Typ kann eine Vorlage Standard sein.

## Bon-Workflows
Drei Bon-Arten mit eigenem Schalter: **Küchenbon** (Modus 1 Bon pro Bestellung / pro Produkt mit Barcode / pro Station), **Bestellbon**, **Kassenbon** (Auslöser: bei Zahlung, bei Abschluss, manuell). Ohne Override-Drucker gilt die Routing-Kette: Drucker der Produkt-Station, sonst der Kategorie-Station, sonst Standarddrucker des Geräts.

## Status
Agent und Drucker zeigen **Online** und **zuletzt gesehen**. Der Agent meldet sich alle 30 Sekunden; angenommene Aufträge druckt er nach einem Neustart nach.

## Für Agenten
- \`list_printers\` (nur lesen – Drucker werden in der Web-App übernommen), \`list_print_templates\`, \`create_print_template\`, \`update_print_template\` (Admin).
- Drucker einer Station zuordnen: \`create_production_station\` / \`update_production_station\` mit \`printerId\`.
`,
  },
  {
    slug: 'schichten',
    title: 'Schichtpläne',
    description: 'Schichtpläne, Arbeiten, Schichten erzeugen, veröffentlichen, Helfer-Anmeldungen.',
    text: `# Schichtpläne

Mit **Schichtplänen** organisierst du die Helferinnen und Helfer einer Veranstaltung: Arbeiten (Theke, Grill, Auf- und Abbau) anlegen, daraus Schichten erzeugen und einen **öffentlichen Helfer-Link** veröffentlichen, über den sich Helfer selbst eintragen.

## 1. Schichtplan erstellen
Optional eine Veranstaltung wählen (Helfer sehen dann das Datum), Name („Helferplanung Sommerfest“) und Beschreibung (erscheint auf der öffentlichen Seite). Der Plan startet im Status **Entwurf** (\`draft\`).

## 2. Arbeiten anlegen
Eine **Arbeit** (Job) ist eine Aufgabe oder Station. Je Arbeit: Name, Beschreibung, **Helfer pro Schicht** (Standard für alle Schichten der Arbeit), Farbe.

## 3. Schichten erzeugen
Schichten sind Zeitfenster je Arbeit: Datum, Beginn, Ende (Ende vor Beginn = über Mitternacht). Der Generator in der Web-App erzeugt sie für einen Zeitraum mit Schichten pro Tag und Überlappung; per API werden Schichten als Liste übergeben.

## 4. Einstellungen und öffentlicher Link
- **Bestätigung erforderlich**: Anmeldungen müssen freigegeben werden.
- **Mehrere Schichten** je Helfer, **Max. Schichten pro Person** (0 = unbegrenzt).
- **Erinnerung** so viele Tage vor der Schicht; Erinnerungen für unbestätigte E-Mail-Adressen.
- Öffentlicher Link \`https://app.openeos.de/s/<slug>\`.

## 5. Veröffentlichen
Im Entwurf ist der Plan nur intern sichtbar. **Veröffentlichen** (\`published\`) schaltet den öffentlichen Link frei; Änderungen sind danach weiter möglich. **Plan schließen** (\`closed\`) nimmt keine Anmeldungen mehr an. Erst veröffentlichen, wenn Arbeiten und Schichten stehen.

## Helfer-Bereich und Anmeldungen
Helfer wählen Schichten ohne Login, tragen Name und E-Mail ein und bestätigen ihre Adresse per Mail. Status je Anmeldung: *E-Mail offen*, *Freigabe offen*, *Bestätigt*. Admins können bestätigen, ablehnen, Helfer manuell eintragen und allen Helfern schreiben.

## Für Agenten
- \`list_shift_plans\`, \`get_shift_plan\` (Arbeiten, Schichten, Zähler je Status – keine Helferdaten).
- \`create_shift_plan\` → \`create_shift_job\` → \`create_shifts\` → \`publish_shift_plan\` (jeweils erst Vorschau, dann \`confirm\`).
- Anmeldungen (Namen, E-Mails) sieht nur die Web-App.
`,
  },
];
