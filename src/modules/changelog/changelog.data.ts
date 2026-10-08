import type { ChangelogEintrag } from './changelog.types';

/**
 * Was sich in OpenEOS geändert hat — für Leute geschrieben, die das
 * System benutzen, nicht für Entwickler.
 *
 * Diese Datei ist die einzige Quelle: die Website holt sie über den
 * öffentlichen Endpunkt, und die Oberfläche zeigt daraus beim Anmelden,
 * was seit dem letzten Besuch dazugekommen ist. Zwei gepflegte Listen
 * würden binnen eines Monats auseinanderlaufen.
 *
 * Bewusst keine Ableitung aus Git: eine Commit-Liste erklärt niemandem,
 * was er jetzt anders machen kann. Jeder Eintrag beantwortet genau das.
 *
 * Neueste zuerst. Datum im Format JJJJ-MM-TT.
 */
export const CHANGELOG: ChangelogEintrag[] = [
  {
    datum: '2026-10-08',
    art: 'neu',
    titel: {
      de: 'Die neue Kasse',
      en: 'The new till',
    },
    kurz: {
      de: 'Neues Design mit farbigen Kategorien, Favoriten, Suche, Hell/Dunkel und einem Kassieren-Blatt für alles.',
      en: 'A new design with coloured categories, favourites, search, light/dark and one checkout sheet for everything.',
    },
    text: {
      de: 'Die Kasse ist von Grund auf neu gestaltet. Kategorien stehen mit eigener Farbe und eigenem Icon in einer Leiste, ganz oben findest du deine Favoriten, und über die Lupe suchst du jeden Artikel direkt. Bar, Karte, Rabatt, Pfand und „Rechnung teilen“ erledigst du in einem Kassieren-Blatt. Blätter schließt du, indem du sie nach unten wischst. Über das Menü (drei Striche oben) stellst du Hell, Dunkel oder System für dieses Gerät ein. Im Testmodus zeigt ein schmaler Streifen unter dem Kopf, dass die Bestellungen beim Freischalten gelöscht werden.',
      en: 'The till has been redesigned from the ground up. Categories sit in a bar with their own colour and icon, your favourites are at the top, and the magnifier lets you search for any item directly. Cash, card, discount, deposit and "Split bill" are all handled in one checkout sheet. Sheets close when you swipe them down. The menu (three lines at the top) lets you choose light, dark or system for this device. In test mode a slim strip below the header reminds you that orders will be deleted on activation.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'neu',
    titel: {
      de: 'Tische und Tischplan',
      en: 'Tables and floor plan',
    },
    kurz: {
      de: 'Lege Bereiche und Tische an und zeichne einen Tischplan mit Wänden, Raumform und Zonen.',
      en: 'Create areas and tables and draw a floor plan with walls, room shape and zones.',
    },
    text: {
      de: 'Unter „Tische“ legst du Bereiche wie Saal oder Terrasse an und darin deine Tische, einzeln oder als ganze Serie (zum Beispiel A1 bis A20). Im Tischplan-Editor ziehst du die Tische an ihren Platz, zeichnest Wände als Linienzug, passt die Raumform an und markierst Zonen wie Küche, Bar/Theke oder gesperrte Flächen. Liegt ein Tisch außerhalb des Raums oder in einer gesperrten Zone, weist dich der Editor darauf hin. In der Veranstaltung legst du fest, ob mit festen Tischen oder freien Tischnummern gearbeitet wird.',
      en: 'Under "Tables" you create areas such as a hall or terrace and the tables in them, one by one or as a whole series (for example A1 to A20). In the floor plan editor you drag tables into place, draw walls as lines, adjust the room shape and mark zones such as kitchen, bar/counter or blocked areas. If a table lies outside the room or in a blocked zone, the editor tells you. In the event you choose whether to work with fixed tables or free table numbers.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'neu',
    titel: {
      de: 'Kassieren am Tisch',
      en: 'Table service at the till',
    },
    kurz: {
      de: 'Tisch öffnen, offene Tische im Blick, Tisch wechseln und den ganzen Tisch auf einmal kassieren.',
      en: 'Open a table, keep an eye on open tables, switch tables and settle a whole table at once.',
    },
    text: {
      de: 'Mit Tischbetrieb startet die Kasse mit „Tisch öffnen“: per Nummer, aus einer Liste oder direkt auf dem Tischplan. Welche Ansicht eine Kasse zeigt, stellst du je Gerät ein. Die Leiste „Offene Tische“ zeigt, wo noch etwas offen ist und wo ein Gast wartet oder Essen fertig zum Servieren ist; mit „Serviert“ hakst du es ab. Über die Tischanzeige wechselst du den Tisch, der angefangene Warenkorb wird dabei geparkt oder mitgenommen. Beim Kassieren zahlst du alle offenen Bestellungen des Tisches in einem Schritt. Alle Kassen sind dabei live auf demselben Stand.',
      en: 'With table service the till starts with "Open table": by number, from a list or right on the floor plan. You choose per device which view a till shows. The "Open tables" bar shows where something is still open and where a guest is waiting or food is ready to serve; "Served" ticks it off. Tapping the table lets you switch tables, and the cart you started is parked or taken along. At checkout you settle all open orders of the table in one step. All tills stay in sync live.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'neu',
    titel: {
      de: 'Integrationen für deine Organisation einschalten',
      en: 'Switch on integrations for your organization',
    },
    kurz: {
      de: 'Ein Katalog zeigt alle Integrationen; SumUp schaltest du pro Organisation ein und aus.',
      en: 'A catalog shows all integrations; you switch SumUp on and off per organization.',
    },
    text: {
      de: 'Unter „Integrationen“ findest du jetzt einen Katalog mit allen Anbindungen, jeweils mit Beschreibung und Bildern. Admins schalten eine Integration für die Organisation ein oder aus, eingerichtet wird sie auf ihrer eigenen Seite. Kartenzahlung mit SumUp erscheint an der Kasse erst, wenn die Integration eingeschaltet ist. Hinterlegte Zugangsdaten bleiben beim Ausschalten erhalten.',
      en: 'Under "Integrations" you now find a catalog of all connections, each with a description and pictures. Admins switch an integration on or off for the organization and set it up on its own page. Card payment with SumUp only appears at the till once the integration is switched on. Stored credentials are kept when you switch it off.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'neu',
    titel: {
      de: 'Produkt-Icons und farbige Kategorien',
      en: 'Product icons and coloured categories',
    },
    kurz: {
      de: 'Wähle für Produkte ein Kassen-Icon statt eines Fotos und gib Kategorien Icon und Farbe.',
      en: 'Pick a till icon for products instead of a photo and give categories an icon and colour.',
    },
    text: {
      de: 'Für jedes Produkt kannst du aus einer Sammlung von Kassen-Icons wählen, zum Beispiel Pils, Pommes oder Bratwurst, statt ein Foto hochzuladen. Kategorien bekommen ein Icon und eine Farbe; beides siehst du an der Kasse in der Kategorieleiste und bei Produkten ohne eigenes Bild.',
      en: 'For every product you can choose from a collection of till icons, such as beer, fries or sausage, instead of uploading a photo. Categories get an icon and a colour; you see both at the till in the category bar and on products without their own picture.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'neu',
    titel: {
      de: 'Stationsanzeige mit Fertig-Rückmeldung',
      en: 'Station display shows what is ready',
    },
    kurz: {
      de: 'Erledigtes wird sichtbar abgehakt und lässt sich nach einer einstellbaren Zeit ausblenden.',
      en: 'Finished items are visibly ticked off and can be hidden after a time you choose.',
    },
    text: {
      de: 'Tippst du an der Stationsanzeige auf „Fertig“, wird der Artikel sofort abgehakt; ist eine Bestellung komplett, färbt sich die Karte grün. In den Geräteeinstellungen legst du mit „Erledigte ausblenden“ fest, nach wie vielen Sekunden fertige Bestellungen verschwinden oder ob sie gesammelt am Ende stehen bleiben. Alle Karten sind gleich aufgebaut und zeigen Tisch, Abholung, To-go oder Theke.',
      en: 'When you tap "Ready" on the station display, the item is ticked off immediately; once an order is complete, its card turns green. In the device settings, "Clear completed" sets after how many seconds finished orders disappear, or whether they stay collected at the end. All cards share the same layout and show table, pickup, to-go or counter.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'neu',
    titel: {
      de: 'Mitglieder direkt anlegen',
      en: 'Create members directly',
    },
    kurz: {
      de: 'Beim Selbstbetrieb legst du Konten mit Startpasswort direkt in der Oberfläche an.',
      en: 'When self-hosting, you create accounts with a starting password right in the interface.',
    },
    text: {
      de: 'Wer OpenEOS selbst betreibt, hat oft keinen Mailserver für Einladungen. Unter „Mitglieder“ → „Mitglied hinzufügen“ gibt es deshalb den Reiter „Konto direkt anlegen“: Name, E-Mail und ein Startpasswort, das du dem neuen Mitglied weitergibst. Hat die Person schon ein Konto, fügst du sie ohne Passwort hinzu.',
      en: 'If you run OpenEOS yourself, you often have no mail server for invitations. Under "Members" → "Add member" there is now a "Create account directly" tab: name, email and a starting password that you pass on to the new member. If the person already has an account, you add them without a password.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'verbessert',
    titel: {
      de: 'Bestellung und Zahlung in einem Schritt',
      en: 'Order and payment in one step',
    },
    kurz: {
      de: 'Beim sofortigen Kassieren geht eine Bestellung erst nach der Zahlung an Küche und Stationen.',
      en: 'With immediate checkout, an order only reaches kitchen and stations once it is paid.',
    },
    text: {
      de: 'Kassierst du sofort, werden Bestellung und Zahlung jetzt gemeinsam gebucht. Bricht die Zahlung ab oder wird die Karte abgelehnt, entsteht keine Bestellung, und die Küche bekommt nichts, was nicht bezahlt ist. „Senden“ ohne Zahlung gibt es nur noch, wenn die Veranstaltung mit offenen Rechnungen arbeitet.',
      en: 'When you check out immediately, order and payment are now booked together. If the payment is cancelled or the card is declined, no order is created, and the kitchen gets nothing that has not been paid. "Send" without payment is only offered when the event works with open tabs.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'verbessert',
    titel: {
      de: 'Geräte übersichtlicher einrichten',
      en: 'Clearer device setup',
    },
    kurz: {
      de: 'Geräteeinstellungen neu gegliedert, „Verknüpft mit“ auf einen Blick, Kopplungscode am Stück.',
      en: 'Device settings reorganized, "Linked to" at a glance, pairing code in one piece.',
    },
    text: {
      de: 'Die Einstellungen eines Geräts sind jetzt nach Betrieb, Zahlung, Sicherheit, Anzeige und Aussehen gegliedert, und was von einer Wahl abhängt, steht direkt darunter: bei einer Kasse mit Tischen der Standardbereich und die Tischwahl, beim Kundendisplay die zugehörige Kasse, bei der Stationsanzeige der Standort. Die Kachel „Verknüpft mit“ zeigt sofort, wozu ein Gerät gehört. Der Kopplungscode erscheint als sechs Ziffern am Stück, und beim Eingeben darfst du ihn auch mit Leerzeichen einfügen.',
      en: 'A device\'s settings are now grouped into operation, payment, security, display and appearance, and whatever depends on a choice sits right below it: for a till with tables the default area and table selection, for a customer display its till, for a station display its station. The "Linked to" tile shows at once what a device belongs to. The pairing code appears as six digits in one piece, and you may paste it with spaces when entering it.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'verbessert',
    titel: {
      de: 'Ganz auf Englisch, auf Deutsch per Du',
      en: 'Fully in English, informal in German',
    },
    kurz: {
      de: 'Die englische Oberfläche ist vollständig, auf Deutsch sprechen wir dich mit Du an, Fehlermeldungen sind verständlich.',
      en: 'The English interface is complete, German now uses the informal "du", and error messages are easy to understand.',
    },
    text: {
      de: 'Stellst du Englisch ein, ist jetzt wirklich alles englisch, auch Navigation, Datumsangaben und Zahlen. Auf Deutsch spricht OpenEOS dich überall mit Du an, in der Oberfläche, in E-Mails und auf dem Bon. Fehlermeldungen sagen jetzt in deiner Sprache, was genau nicht geklappt hat, statt nur „Fehler“ zu melden.',
      en: 'If you choose English, everything really is in English now, including navigation, dates and numbers. In German, OpenEOS addresses you informally everywhere: in the interface, in emails and on the receipt. Error messages now tell you in your language what exactly went wrong instead of just saying "error".',
    },
  },
  {
    datum: '2026-10-08',
    art: 'verbessert',
    titel: {
      de: 'Frischeres Erscheinungsbild',
      en: 'A fresher look',
    },
    kurz: {
      de: 'Neue Schrift, neue Icons und Seitenköpfe, die überall gleich aufgebaut sind.',
      en: 'A new typeface, new icons and page headers that work the same everywhere.',
    },
    text: {
      de: 'Überschriften nutzen eine neue, kräftigere Schrift, und alle Icons stammen aus einem einheitlichen Satz. Jede Seite ist gleich aufgebaut: oben Titel und Beschreibung, die Aktionen wie „Schichtplan erstellen“ oder „Inventur erstellen“ an der Liste, zu der sie gehören. Detailseiten von Gerät, Schichtplan, Benutzer und Integration haben beschriftete Knöpfe statt reiner Symbole. Auf dem Telefon und im dunklen Modus wird alles sauber dargestellt.',
      en: 'Headlines use a new, bolder typeface, and all icons come from one consistent set. Every page follows the same pattern: title and description at the top, actions such as "Create shift plan" or "Create stocktake" on the list they belong to. Detail pages for devices, shift plans, users and integrations have labelled buttons instead of bare symbols. Everything displays cleanly on phones and in dark mode.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'verbessert',
    titel: {
      de: 'Support-Anfragen und Kontaktformulare bleiben vollständig in OpenEOS',
      en: 'Support requests and contact forms stay entirely within OpenEOS',
    },
    kurz: {
      de: 'Nachrichten an den Support werden nicht mehr an einen Messenger weitergeleitet.',
      en: 'Messages to support are no longer forwarded to a messenger.',
    },
    text: {
      de: 'Was du im Support-Chat oder über die Kontaktformulare der Website schreibst, wird jetzt ausschließlich in OpenEOS bearbeitet. Eine Weiterleitung an einen Messenger-Dienst gibt es nicht mehr; das Team wird per E-Mail benachrichtigt. Für dich ändert sich an der Bedienung nichts.',
      en: 'What you write in the support chat or through the contact forms on the website is now handled solely within OpenEOS. Messages are no longer forwarded to a messenger service; the team is notified by email. Nothing changes in how you use it.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'verbessert',
    titel: {
      de: 'Fehlerberichte enthalten weniger Daten',
      en: 'Error reports contain less data',
    },
    kurz: {
      de: 'Automatische Fehlerberichte beschränken sich auf das, was zur Fehlersuche nötig ist.',
      en: 'Automatic error reports are limited to what is needed to find the fault.',
    },
    text: {
      de: 'Tritt ein Fehler auf, schickt OpenEOS einen Bericht, damit wir ihn beheben können. Diese Berichte enthalten jetzt nur noch, was zur Fehlersuche nötig ist; persönliche Angaben und Bildschirmaufzeichnungen sind nicht mehr dabei.',
      en: 'When an error occurs, OpenEOS sends a report so we can fix it. These reports now contain only what is needed to find the fault; personal details and screen recordings are no longer included.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'behoben',
    titel: {
      de: 'Testbestellungen werden beim Freischalten gelöscht',
      en: 'Test orders are deleted on activation',
    },
    kurz: {
      de: 'Nach dem Freischalten tauchen Testbestellungen nicht mehr in Auswertungen und Beständen auf.',
      en: 'After activation, test orders no longer show up in reports and stock.',
    },
    text: {
      de: 'Die Kasse kündigt es an: Bestellungen aus dem Testmodus werden beim Freischalten gelöscht. Bisher blieben sie trotzdem stehen und zählten in Auswertungen, Beständen und Abholnummern mit. Jetzt verschwinden sie beim Freischalten wirklich, und die Veranstaltung startet sauber.',
      en: 'The till says so: orders from test mode are deleted on activation. Until now they stayed anyway and counted in reports, stock and pickup numbers. Now they really disappear on activation, and the event starts with a clean slate.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'behoben',
    titel: {
      de: 'Richtige Tage rund um Mitternacht',
      en: 'The right day around midnight',
    },
    kurz: {
      de: 'Eindeutige Bestellnummern, korrektes „Heute“ zwischen 0 und 2 Uhr und Schichten am richtigen Tag.',
      en: 'Unique order numbers, a correct "today" between midnight and 2 a.m. and shifts on the right day.',
    },
    text: {
      de: 'Kurz nach Mitternacht konnte dieselbe Bestellnummer zweimal vergeben werden, und Bestellungen zwischen 0 und 2 Uhr zählten in Übersicht und Auswertungen noch zum Vortag. Der Schicht-Generator legte Schichten einen Tag zu früh an. Alle drei richten sich jetzt nach dem Kalendertag deiner Organisation, und englische Datumsangaben erscheinen im gewohnten Format.',
      en: 'Shortly after midnight the same order number could be issued twice, and orders between midnight and 2 a.m. still counted towards the previous day in the dashboard and reports. The shift generator created shifts one day early. All three now follow the calendar day of your organization, and English dates appear in the usual format.',
    },
  },
  {
    datum: '2026-10-08',
    art: 'behoben',
    titel: {
      de: 'Kleinere Korrekturen',
      en: 'Smaller fixes',
    },
    kurz: {
      de: 'Artikelanzahl in der Übersicht, To-go an der Station, Mitgliederverwaltung und Darstellung.',
      en: 'Item counts on the dashboard, to-go at the station, member management and display.',
    },
    text: {
      de: 'Die letzten Aktivitäten in der Übersicht zeigten bei jeder Bestellung „0 Artikel“ – jetzt steht dort die richtige Zahl. To-go-Bestellungen erscheinen an der Stationsanzeige als To-go statt als Theke. Beim Entfernen und Ändern von Mitgliedern bleibt immer mindestens ein Admin in der Organisation, und jeder kann nur Rechte vergeben, die er selbst hat. Außerdem sind Menüs, Dialoge und Karten auf dem Telefon und im dunklen Modus nicht mehr abgeschnitten oder schlecht lesbar, und der Shop zeigt Pflichtfelder, Öffnungszeiten und den LIVE-Hinweis korrekt an.',
      en: 'Recent activity on the dashboard showed "0 items" for every order – it now shows the right number. To-go orders appear on the station display as to-go instead of counter. When members are removed or changed, an organization always keeps at least one admin, and everyone can only grant permissions they have themselves. Menus, dialogs and cards are no longer cut off or hard to read on phones and in dark mode, and the shop shows required fields, opening hours and the LIVE badge correctly.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'neu',
    titel: {
      de: 'OpenEOS kostenlos selbst betreiben',
      en: 'Run OpenEOS yourself, free of charge',
    },
    kurz: {
      de: 'Auf eigenem Server, für eine Organisation, ohne Gebühren — mit Anleitung im Handbuch.',
      en: 'On your own server, for one organisation, with no fees — with a guide in the handbook.',
    },
    text: {
      de: 'OpenEOS lässt sich jetzt kostenlos auf einem eigenen Server betreiben. Diese Variante ist bewusst schlank: eine Organisation, in der du alles verwaltest, ohne Abrechnung und ohne Selbstregistrierung — neue Mitglieder legst du selbst mit einem Startpasswort an. Wie man das mit Docker einrichtet, sichert und aktualisiert, steht im Handbuch unter „Selbst betreiben“. Am gehosteten Angebot unter openeos.de ändert sich nichts.',
      en: 'OpenEOS can now be run on your own server free of charge. This edition is deliberately lean: one organisation in which you manage everything, with no billing and no self-registration — you create new members yourself with a starting password. How to set it up with Docker, back it up and update it is described in the handbook under "Self-hosting". Nothing changes for the hosted service at openeos.de.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'neu',
    titel: {
      de: 'Küchenbildschirm einer Station zuordnen',
      en: 'Assign a kitchen screen to a station',
    },
    kurz: {
      de: 'In den Geräteeinstellungen wählst du, welche Station ein Bildschirm zeigt.',
      en: 'Device settings now let you choose which station a screen shows.',
    },
    text: {
      de: 'Ein Bildschirm im Stationsmodus meldete bisher „keine Station konfiguriert“, ohne dass sich das irgendwo ändern ließ. In den Einstellungen des Geräts stehen jetzt die Stationen der laufenden Veranstaltung zur Auswahl; danach zeigt der Bildschirm die Bestellungen dieser Station.',
      en: 'A screen in station mode used to report "no station configured" with no way to change that. The device settings now offer the stations of the running event; once one is chosen, the screen shows that station\'s orders.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'verbessert',
    titel: {
      de: 'Zwei-Faktor-Schutz abschalten nur mit Code',
      en: 'Turning off two-factor sign-in needs a code',
    },
    kurz: {
      de: 'Wer die Zwei-Faktor-Anmeldung abschaltet, bestätigt das mit einem aktuellen Code.',
      en: 'Turning off two-factor sign-in is now confirmed with a current code.',
    },
    text: {
      de: 'Um die Zwei-Faktor-Anmeldung abzuschalten oder neue Wiederherstellungscodes zu erzeugen, gibst du jetzt einen aktuellen Code aus deiner App, per E-Mail oder einen Wiederherstellungscode ein. So kann niemand den Schutz abschalten, nur weil an einem Gerät noch jemand angemeldet ist.',
      en: 'To turn off two-factor sign-in or create new recovery codes you now enter a current code from your app, by email, or a recovery code. That way nobody can remove the protection just because a device was left signed in.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'behoben',
    titel: {
      de: 'Zahlungsanbieter-Zugangsdaten bleiben beim Speichern erhalten',
      en: 'Payment provider credentials survive saving settings',
    },
    kurz: {
      de: 'Funktioniert die Kartenzahlung nicht mehr? Bitte den SumUp- bzw. PayPal-Schlüssel neu eintragen.',
      en: 'Card payments stopped working? Please enter your SumUp or PayPal key again.',
    },
    text: {
      de: 'Beim Speichern der Organisationseinstellungen konnte ein hinterlegter SumUp- oder PayPal-Schlüssel unbrauchbar werden — die Kartenzahlung an der Kasse schlug danach fehl. Das ist behoben, und Zugangsdaten werden insgesamt zurückhaltender an die Oberfläche gegeben. Falls die Kartenzahlung bei dir seitdem nicht mehr funktioniert, trage den Schlüssel unter „Integrationen“ einmal neu ein.',
      en: 'Saving the organisation settings could leave a stored SumUp or PayPal key unusable, after which card payments at the till failed. This is fixed, and credentials are now handed to the interface far more sparingly. If card payments have not worked for you since, enter the key once more under "Integrations".',
    },
  },
  {
    datum: '2026-10-03',
    art: 'behoben',
    titel: {
      de: 'Organisationseinstellungen speichern wieder vollständig',
      en: 'Organisation settings save completely again',
    },
    kurz: {
      de: 'Die Beschreibung der Organisation ging beim Speichern verloren — behoben.',
      en: 'The organisation description was lost on saving — fixed.',
    },
    text: {
      de: 'Die Beschreibung der Organisation wurde beim Speichern nicht übernommen. Außerdem fehlte Betreibern mit eigener Organisation der Reiter „Organisation“ in den Einstellungen. Beides ist behoben.',
      en: 'The organisation description was not kept when saving, and operators with their own organisation did not see the "Organisation" tab in the settings. Both are fixed.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'behoben',
    titel: {
      de: 'Sprachwechsel bleibt auf der Seite',
      en: 'Switching language keeps your page',
    },
    kurz: {
      de: 'Nach dem Umstellen der Sprache landet man nicht mehr auf der Startseite.',
      en: 'Changing the language no longer sends you back to the start page.',
    },
    text: {
      de: 'Wer in den Einstellungen die Sprache umstellte, landete bisher auf der Startseite. Jetzt bleibt die Seite offen, auf der du gerade bist.',
      en: 'Changing the language in the settings used to send you back to the start page. The page you are on now stays open.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'behoben',
    titel: {
      de: 'Bon mit Mehrwertsteuer und Rückgeld',
      en: 'Receipts show VAT and change',
    },
    kurz: {
      de: 'Der Bon weist die enthaltene MwSt je Steuersatz aus und druckt das Rückgeld.',
      en: 'Receipts now show the VAT contained per rate and print the change.',
    },
    text: {
      de: 'Kassenbons zeigten bisher weder die enthaltene Mehrwertsteuer noch das Rückgeld. Jetzt steht für jeden Steuersatz eine eigene Zeile auf dem Bon, Pfand und Trinkgeld bleiben dabei außen vor. Bei Barzahlung druckt der Bon das Rückgeld, sobald an der Kasse der erhaltene Betrag eingegeben wird. Organisationen, die als Kleinunternehmer oder steuerbefreit eingetragen sind, bekommen weiterhin keine MwSt-Zeile.',
      en: 'Receipts used to show neither the VAT they contain nor the change. Each VAT rate now gets its own line, leaving deposits and tips out. For cash payments the receipt prints the change as soon as the received amount is entered at the till. Organisations registered as VAT-exempt still get no VAT line.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'behoben',
    titel: {
      de: 'Shop-Öffnungszeiten nach Ortszeit',
      en: 'Shop opening hours follow local time',
    },
    kurz: {
      de: 'Wöchentliche Öffnungszeiten im Shop gelten jetzt in der Zeitzone der Veranstaltung.',
      en: "Weekly shop hours now apply in the event's time zone.",
    },
    text: {
      de: 'Wöchentliche Öffnungszeiten des Online-Shops wurden bisher nicht in der Zeitzone der Veranstaltung berechnet. Dadurch konnte der Shop eine oder zwei Stunden zu früh oder zu spät öffnen, besonders rund um die Zeitumstellung. Jetzt gelten die Zeiten genau so, wie sie eingetragen sind.',
      en: "Weekly opening hours of the online shop were not calculated in the event's time zone, so the shop could open an hour or two early or late, especially around the clock change. The hours now apply exactly as entered.",
    },
  },
  {
    datum: '2026-10-03',
    art: 'verbessert',
    titel: {
      de: 'Nachricht bei der Schichtbestätigung',
      en: 'A message with a shift confirmation',
    },
    kurz: {
      de: 'Was du beim Bestätigen einer Schicht schreibst, steht jetzt in der E-Mail an den Helfer.',
      en: 'What you write when confirming a shift now appears in the email to the helper.',
    },
    text: {
      de: 'Beim Bestätigen einer Schichtanmeldung ließ sich eine Nachricht eingeben, sie kam aber nie an. Jetzt steht sie in der Bestätigungsmail an den Helfer, zusammen mit deinem Namen.',
      en: 'When confirming a shift registration you could enter a message, but it never arrived. It now appears in the confirmation email to the helper, together with your name.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'verbessert',
    titel: {
      de: 'Angemeldete Geräte erkennbar',
      en: 'Recognisable signed-in devices',
    },
    kurz: {
      de: 'Die Sitzungsliste zeigt Browser und System, markiert dieses Gerät und wächst nicht mehr endlos.',
      en: 'The session list shows browser and system, marks this device and no longer grows endlessly.',
    },
    text: {
      de: 'Unter Einstellungen → Sicherheit stand bisher bei jeder Anmeldung „Unbekanntes Gerät“, und die Liste wurde ständig länger. Jetzt siehst du Browser und Betriebssystem, das Gerät, an dem du gerade sitzt, ist markiert, und jede Anmeldung erscheint nur einmal. „Alle anderen abmelden“ lässt die eigene Sitzung bestehen.',
      en: 'Settings → Security used to list every sign-in as "Unknown device", and the list kept growing. You now see browser and operating system, the device you are using is marked, and each sign-in appears only once. "Sign out all others" keeps your own session.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'behoben',
    titel: {
      de: 'Modulrechte gelten auch per Direktlink',
      en: 'Module permissions apply to direct links too',
    },
    kurz: {
      de: 'Mitglieder ohne das passende Recht kommen auch über einen Link nicht mehr auf die Seite.',
      en: 'Members without the matching permission can no longer reach the page via a link either.',
    },
    text: {
      de: 'Ein Mitglied ohne Recht für Veranstaltungen, Produkte, Geräte und so weiter sah den Menüpunkt zwar nicht, konnte die Seite aber über einen direkten Link öffnen. Jetzt geht es dann zurück zur Übersicht.',
      en: 'A member without permission for events, products, devices and so on did not see the menu item, but could still open the page through a direct link. They are now taken back to the dashboard.',
    },
  },
  {
    datum: '2026-10-03',
    art: 'behoben',
    titel: {
      de: 'Kleinigkeiten in Anmeldung und Einstellungen',
      en: 'Small fixes in sign-in and settings',
    },
    kurz: {
      de: 'Fehlermeldungen in deiner Sprache, und „Speichern“ wird nach dem Speichern wieder grau.',
      en: 'Error messages in your language, and "Save" greys out again after saving.',
    },
    text: {
      de: 'Falsche Anmeldedaten und Fehler beim Zurücksetzen des Passworts werden jetzt in der eingestellten Sprache gemeldet statt auf Englisch bzw. Deutsch. In Profil und Organisationseinstellungen wird der Speichern-Knopf nach dem Speichern wieder inaktiv, damit sichtbar ist, dass nichts mehr offen ist. Dialoge sind für Bildschirmleser besser zugänglich.',
      en: 'Wrong sign-in details and password reset errors are now reported in your chosen language instead of always in English or German. In the profile and organisation settings the save button becomes inactive again after saving, so you can see nothing is pending. Dialogs work better with screen readers.',
    },
  },
  {
    datum: '2026-09-24',
    art: 'behoben',
    titel: {
      de: 'Kassen und Bildschirme verbinden sich wieder',
      en: 'Tills and screens connect again',
    },
    kurz: {
      de: 'Geräte wurden dauerhaft als „offline“ angezeigt — das ist behoben.',
      en: 'Devices were permanently shown as offline — fixed.',
    },
    text: {
      de: 'Kassen und Anzeigen konnten ihre Live-Verbindung nicht aufbauen und wurden dauerhaft als „offline“ angezeigt, während die Bedienung selbst weiterlief. Bestellungen erreichten Küche und Anzeigen dadurch nicht sofort. Die Verbindung steht wieder; die Geräte müssen die Seite einmal neu laden.',
      en: 'Tills and screens could not open their live connection and were permanently shown as offline, even though they otherwise worked. Orders therefore did not reach the kitchen and the screens straight away. The connection works again; devices need to reload the page once.',
    },
  },
  {
    datum: '2026-09-24',
    art: 'neu',
    titel: {
      de: 'Der Preis steht beim Anlegen dabei',
      en: 'The price is shown as you create an event',
    },
    kurz: {
      de: 'Was das Freischalten kostet, steht jetzt direkt unter dem Zeitraum.',
      en: 'What activation costs now appears right under the date range.',
    },
    text: {
      de: 'Beim Anlegen einer Veranstaltung steht jetzt direkt unter dem Zeitraum, was das Freischalten kosten wird — mit Rechenweg und dem Hinweis, dass Testen kostenlos ist. Bisher tauchte der Betrag erst im Bezahldialog auf, also ganz am Ende der Einrichtung.',
      en: 'When you create an event, the cost of activating it now appears directly under the date range, with the arithmetic and a note that testing is free. Previously the amount only turned up in the checkout dialog, at the very end of setting up.',
    },
  },
  {
    datum: '2026-09-24',
    art: 'behoben',
    titel: {
      de: 'Veranstaltungen lassen sich löschen',
      en: 'Events can be deleted',
    },
    kurz: {
      de: 'Das Löschen schlug bisher immer fehl.',
      en: 'Deleting an event always failed before.',
    },
    text: {
      de: 'Das Löschen einer Veranstaltung endete bisher mit einer Fehlermeldung. Jetzt funktioniert es. Die Veranstaltung verschwindet aus der Liste; Bestellungen und Abrechnungsstände bleiben im Hintergrund erhalten, damit die Buchhaltung vollständig bleibt.',
      en: 'Deleting an event used to end in an error message. It works now. The event disappears from the list while orders and billing records are kept in the background, so the accounts stay complete.',
    },
  },
  {
    datum: '2026-09-24',
    art: 'neu',
    titel: {
      de: 'Antwort vom Support kommt per E-Mail',
      en: 'Support replies arrive by email',
    },
    kurz: {
      de: 'Eine Antwort im Support-Chat meldet sich jetzt per E-Mail.',
      en: 'A reply in the support chat now notifies you by email.',
    },
    text: {
      de: 'Wenn wir auf eine Support-Anfrage antworten, bekommst du eine E-Mail mit einem Auszug und einem Link in den Chat. Bisher musste man von sich aus nachsehen, ob schon etwas da war.',
      en: 'When we reply to a support request you now receive an email with an excerpt and a link into the chat. Previously you had to go and look for yourself.',
    },
  },
  {
    datum: '2026-09-24',
    art: 'verbessert',
    titel: {
      de: 'Abmelden beendet die Sitzung sofort',
      en: 'Signing out ends the session immediately',
    },
    kurz: {
      de: 'Der Zugang gilt ab dem Abmelden nicht mehr — auf diesem Gerät allein.',
      en: 'Access ends the moment you sign out — on that device only.',
    },
    text: {
      de: 'Nach dem Abmelden war der Zugang technisch noch bis zu einer Stunde gültig. Jetzt endet er sofort. Betroffen ist nur das Gerät, an dem du dich abmeldest — an der Kasse abzumelden wirft niemanden im Büro hinaus.',
      en: 'After signing out, access technically remained valid for up to an hour. It now ends at once, and only for the device you sign out from — signing out at the till does not throw anyone out of the office.',
    },
  },
  {
    datum: '2026-09-24',
    art: 'verbessert',
    titel: {
      de: 'Handbuch von der Registrierung bis zur Kasse',
      en: 'A handbook from signing up to selling',
    },
    kurz: {
      de: 'docs.openeos.de führt jetzt Schritt für Schritt durch die Einrichtung.',
      en: 'docs.openeos.de now walks you through setup step by step.',
    },
    text: {
      de: 'Das Handbuch unter docs.openeos.de ist neu aufgebaut: ein Weg von der Registrierung über die Einrichtung bis zum Verkauf am Festtag, mit neuen Kapiteln zur Kasse und zu den Anzeigen und mit aktuellen Bildern.',
      en: 'The handbook at docs.openeos.de has been rebuilt as a path: from signing up through setup to selling on the day, with new chapters on the till and the screens, and with current screenshots.',
    },
  },
  {
    datum: '2026-09-17',
    art: 'neu',
    titel: {
      de: 'Bildschirme per Code verbinden',
      en: 'Connect screens with a code',
    },
    kurz: {
      de: 'Fernseher und Tablets zeigen eine Zahl — die gibst du in OpenEOS ein, fertig.',
      en: 'TVs and tablets show a number — enter it in OpenEOS and you are done.',
    },
    text: {
      de: 'Ein Fernseher oder Tablet zeigt beim Start eine sechsstellige Zahl. Diese Zahl gibst du in OpenEOS ein — fertig. Wer ein Handy dabei hat, scannt stattdessen den QR-Code auf dem Bildschirm. Ein Kabel oder eine Einrichtung am Gerät selbst ist nicht nötig.',
      en: 'A TV or tablet shows a six-digit number when it starts. Enter that number in OpenEOS and you are done. With a phone to hand, scan the QR code on the screen instead. Nothing needs to be set up on the device itself.',
    },
  },
  {
    datum: '2026-09-17',
    art: 'neu',
    titel: {
      de: 'Bildschirme selbst gestalten',
      en: 'Style your screens',
    },
    kurz: {
      de: 'Hell oder dunkel, große Schrift, eigene Überschrift — je Bildschirm einstellbar.',
      en: 'Light or dark, large text, your own heading — set per screen.',
    },
    text: {
      de: 'Für jeden Bildschirm lässt sich einstellen, wie er aussieht: hell oder dunkel, normale oder große Schrift für weit entfernte Monitore, eine eigene Überschrift und ein eigener Begrüßungstext. Änderungen erscheinen sofort auf dem Bildschirm — du musst nicht hingehen.',
      en: 'Every screen can be set up individually: light or dark, normal or large text for monitors further away, its own header and its own welcome message. Changes appear on the screen straight away — no need to walk over to it.',
    },
  },
  {
    datum: '2026-09-17',
    art: 'verbessert',
    titel: {
      de: 'Küchenanzeige zeigt Bestellungen sofort',
      en: 'Kitchen screen shows orders immediately',
    },
    kurz: {
      de: 'Neue Bestellungen erscheinen ohne Verzögerung und lassen sich antippen.',
      en: 'New orders appear without delay and can be tapped to clear.',
    },
    text: {
      de: 'Bisher hat die Küchenanzeige alle 30 Sekunden nachgesehen, ob etwas Neues da ist. Im schlechtesten Fall lag eine Bestellung also eine halbe Minute herum, bevor sie jemand sah. Jetzt erscheint sie, sobald sie aufgenommen wurde.',
      en: 'The kitchen screen used to check for new orders every 30 seconds, so an order could sit there for half a minute before anyone saw it. Now it appears the moment it is taken.',
    },
  },
  {
    datum: '2026-09-16',
    art: 'neu',
    titel: {
      de: 'Anmelden ohne Passwort',
      en: 'Sign in without a password',
    },
    kurz: {
      de: 'Link per E-Mail anfordern statt Passwort eintippen.',
      en: 'Request a link by email instead of typing a password.',
    },
    text: {
      de: 'Du kannst dir einen Anmeldelink per E-Mail schicken lassen, statt ein Passwort einzugeben. Der Link gilt 15 Minuten und funktioniert genau einmal. Ein Passwort kannst du weiterhin verwenden — und wer sich neu anmeldet, braucht gar keines mehr zu vergeben.',
      en: 'You can have a sign-in link emailed to you instead of typing a password. The link is valid for 15 minutes and works exactly once. Passwords still work — and new accounts no longer need one at all.',
    },
  },
  {
    datum: '2026-09-16',
    art: 'behoben',
    titel: {
      de: 'Zwei-Faktor-Anmeldung greift wieder',
      en: 'Two-factor sign-in works again',
    },
    kurz: {
      de: 'Der zweite Faktor wird jetzt tatsächlich geprüft.',
      en: 'The second factor is now actually enforced.',
    },
    text: {
      de: 'Wer die Anmeldung mit zusätzlichem Code eingerichtet hatte, wurde beim Anmelden nicht danach gefragt — das Passwort allein genügte. Das ist behoben: Der Code wird jetzt verlangt, bevor die Anmeldung abgeschlossen ist. Wenn du ein Gerät als vertrauenswürdig markiert hast, bleibt es dabei.',
      en: 'Anyone who had set up sign-in with an extra code was never asked for it — the password alone was enough. Fixed: the code is now required before sign-in completes. Devices you marked as trusted stay trusted.',
    },
  },
  {
    datum: '2026-09-09',
    art: 'neu',
    titel: {
      de: 'Erste Schritte und Rundgang',
      en: 'Getting started and a guided tour',
    },
    kurz: {
      de: 'Ein geführter Rundgang zeigt die wichtigsten Stellen.',
      en: 'A guided tour points out the important places.',
    },
    text: {
      de: 'Neue Konten bekommen auf der Startseite eine Liste mit den Schritten bis zur ersten Bestellung. Beim ersten Anmelden führt ein kurzer Rundgang durch die Oberfläche. Beides lässt sich jederzeit ausblenden.',
      en: 'New accounts get a checklist on the dashboard covering everything up to the first order. On first sign-in, a short tour walks through the interface. Both can be dismissed at any time.',
    },
  },
  {
    datum: '2026-09-09',
    art: 'neu',
    titel: {
      de: 'Veranstaltung erst testen, dann bezahlen',
      en: 'Try an event before paying for it',
    },
    kurz: {
      de: 'Bis zu 25 Bestellungen kostenlos ausprobieren.',
      en: 'Try up to 25 orders at no cost.',
    },
    text: {
      de: 'Eine Veranstaltung lässt sich im Testmodus mit bis zu 25 Bestellungen ausprobieren, ohne etwas zu bezahlen. Erst wenn du darüber hinaus verkaufen willst, wird sie freigeschaltet.',
      en: 'An event can be tried in test mode with up to 25 orders at no cost. Only when you want to sell beyond that does it need activating.',
    },
  },
  {
    datum: '2026-09-02',
    art: 'neu',
    titel: {
      de: 'Bezahlen per Karte statt auf Rechnung',
      en: 'Card payment instead of an invoice',
    },
    kurz: {
      de: 'Freischalten per Karte oder Lastschrift, Rechnung kommt automatisch.',
      en: 'Activate by card or direct debit; the invoice follows automatically.',
    },
    text: {
      de: 'Veranstaltungen werden jetzt direkt per Karte oder Lastschrift bezahlt. Die Rechnung kommt automatisch per E-Mail und liegt zusätzlich unter „Rechnungen“ zum Herunterladen bereit.',
      en: 'Events are now paid by card or direct debit. The invoice arrives by email automatically and is also available for download under "Invoices".',
    },
  },
];

/**
 * Welche Version an welchem Tag erschienen ist.
 *
 * Getrennt von den Eintraegen gehalten: drei Neuerungen desselben Tages
 * gehoeren zur selben Veroeffentlichung, und dreimal dieselbe Nummer
 * abzutippen heisst, dass sie irgendwann auseinanderlaufen.
 *
 * Die Zahl steigt nur bei einer Veroeffentlichung. Die Build-Nummer der
 * Oberflaeche (1.0.<Lauf>) taugt dafuer nicht: sie zaehlt auch nach einer
 * reinen Fehlerkorrektur weiter, und dem Besucher der Website eine neue
 * Version zu melden, die nichts Neues enthaelt, waere eine Luege.
 *
 * Neues Datum im Changelog -> hier eine Zeile ergaenzen, sonst steht der
 * Eintrag ohne Version da.
 */
export const RELEASES: Record<string, string> = {
  '2026-10-08': '1.6',
  '2026-10-03': '1.5',
  '2026-09-24': '1.4',
  '2026-09-17': '1.3',
  '2026-09-16': '1.2',
  '2026-09-09': '1.1',
  '2026-09-02': '1.0',
};
