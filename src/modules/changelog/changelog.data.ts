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
    // Naechste Veroeffentlichung (1.8): Datum beim Release anpassen.
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Bewirtungsbeleg an der Kasse',
      en: 'Hospitality receipt at the till',
    },
    kurz: {
      de: 'Gäste, die geschäftlich bewirten, bekommen an der Kasse einen Bewirtungsbeleg mit eigener Nummer – gedruckt, als QR-Code oder per E-Mail.',
      en: 'Guests who entertain on business get a hospitality receipt with its own number at the till – printed, as a QR code or by e-mail.',
    },
    text: {
      de: 'Unter „Beleg“ gibt es nach dem Kassieren und im Verlauf jetzt „Bewirtungsbeleg“. Die Kasse stellt eine Rechnung mit fortlaufender Nummer (B-2026-0001) aus: Name, Anschrift und Steuernummer deines Vereins, Tag der Bewirtung, jede Position einzeln, Netto, Umsatzsteuer und Brutto je Steuersatz (bei Kleinunternehmern der Hinweis auf § 19 UStG), Trinkgeld als eigene Zeile und die TSE-Angaben. Über 250 € trägt die Kasse den Namen des Bewirtenden ein. Darunter stehen Leerzeilen für Anlass, Teilnehmer und Unterschrift, die der Gast von Hand ausfüllt. Der Beleg wird unveränderlich gespeichert und zehn Jahre aufbewahrt; jeder weitere Ausdruck ist als „Kopie“ markiert. Dafür brauchst du den offiziellen Namen, die Anschrift und – über 250 € – die Steuernummer deines Vereins in den Einstellungen. Danke an till-mueller für die Idee.',
      en: 'Under "Receipt" there is now "Hospitality receipt" after taking payment and in the history. The till issues an invoice with its own consecutive number (B-2026-0001): your club’s name, address and tax number, the day of the hospitality, every item on its own, net, VAT and gross per rate (for small businesses the note on § 19 UStG), the tip on its own line and the TSE details. Above 250 € the till adds the name of the host. Below are blank lines for occasion, guests and signature, which the guest fills in by hand. The receipt is stored unchangeable and kept for ten years; every further print is marked "Copy". For this you need your club’s official name, address and – above 250 € – tax number in the settings. Thanks to till-mueller for the idea.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Live-Kassensturz und Trinkgeld-Auszahlung',
      en: 'Live cash check and tip payout',
    },
    kurz: {
      de: 'Der Live-Kassensturz zeigt jederzeit, wie viel Bargeld jede Bedienung haben muss; Kellnerabrechnungen sind mit Cloud-TSE abgesichert, und angestellten Bedienungen zahlst du Kartentrinkgeld mit Beleg aus.',
      en: 'The live cash check shows at any time how much cash every server should have; server settlements are secured with the Cloud-TSE, and you pay out card tips to employed servers with a receipt.',
    },
    text: {
      de: 'Unter „Kellnerabrechnungen“ findest du den Live-Kassensturz: für jede Bedienung das Soll bar seit ihrer letzten Abrechnung, wo das Geld liegt, Kartenzahlungen, Trinkgeld und offene Tische – praktisch, wenn das Finanzamt zur Kassen-Nachschau kommt. Die Schichtleitung sieht ihn auch an der Kasse. Mit Cloud-TSE wird jede Kellnerabrechnung mit Soll, gezähltem Betrag und Differenz von der TSE abgesichert; ein Nachdruck trägt den Vermerk „Kopie“. Kellnerabrechnungen werden ausschließlich elektronisch erzeugt und aufbewahrt. Für Bedienungen mit „Arbeitnehmer (Lohnkonto)“ kannst du offenes Kartentrinkgeld bar auszahlen – mit eigenem Beleg und Quittung, auch direkt bei der Abrechnung. Bei Ehrenamtlichen gehört das Trinkgeld dem Verein, deshalb ist die Auszahlung dort gesperrt.',
      en: 'Under "Server settlements" you find the live cash check: for every server the expected cash since their last settlement, where the money is, card payments, tips and open tables – handy when the tax office comes for a cash inspection. Shift leads see it at the till too. With the Cloud-TSE every server settlement is secured with the expected amount, the counted amount and the difference; a reprint is marked "Copy". Server settlements are created and kept electronically only. For servers marked "Employee (payroll)" you can pay out open card tips in cash – with its own receipt and acknowledgement, also right at the settlement. For volunteers the tips belong to the club, so the payout is blocked there.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'verbessert',
    titel: {
      de: 'Trinkgeld mit dem richtigen Steuersatz',
      en: 'Tips with the right VAT rate',
    },
    kurz: {
      de: 'Trinkgeld, das in die Vereinskasse geht, wird jetzt mit dem Steuersatz der Speisen und Getränke versteuert; Trinkgeld angestellter Bedienungen bleibt steuerfrei.',
      en: 'Tips that go to the club are now taxed at the rate of the food and drinks; tips of employed servers stay tax-free.',
    },
    text: {
      de: 'Nach Rücksprache mit einem Steuerberater gilt: Trinkgeld an einen umsatzsteuerpflichtigen Verein gehört zum Entgelt. OpenEOS verteilt es deshalb im Verhältnis der Nettobeträge auf 7 % und 19 % – auf dem Bon, in der Cloud-TSE, im DSFinV-K-Export und im Bericht „Umsatzsteuer“. Der Bon zeigt das Trinkgeld als eigene Zeile. Nur wenn eine Bedienung „Arbeitnehmer (Lohnkonto)“ ist, gilt ihr Trinkgeld als Trinkgeld an Angestellte (steuerfrei). Das stellst du jetzt je Bedienung ein, nicht mehr für den ganzen Verein. Ehrenamtliche Helfer sind keine Arbeitnehmer. Kleinunternehmer weisen weiterhin keine Steuer aus.',
      en: 'After consulting a tax advisor: tips paid to a VAT-liable club are part of the consideration. OpenEOS therefore splits them onto 7 % and 19 % in proportion to the net amounts – on the receipt, in the Cloud-TSE, in the DSFinV-K export and in the "VAT" report. The receipt shows the tip as its own line. Only if a server is marked "Employee (payroll)" do their tips count as tips to employees (tax-free). You now set this per server instead of for the whole club. Volunteers are not employees. Small businesses still show no VAT.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'verbessert',
    titel: {
      de: 'Kleinunternehmer-Hinweis auf jedem Beleg',
      en: 'Small business notice on every receipt',
    },
    kurz: {
      de: 'Bons von Kleinunternehmern tragen jetzt den Hinweis auf die Steuerbefreiung nach § 19 UStG; dazu warnt das Dashboard, wenn dein Umsatz die Grenze erreicht.',
      en: 'Receipts of small businesses now carry the notice on the tax exemption under § 19 UStG; the dashboard warns you when your revenue approaches the limit.',
    },
    text: {
      de: 'Kassenbon, Erstattungsbeleg und Pfandrückgabe zeigen bei Kleinunternehmern „Steuerfrei nach § 19 Abs. 1 UStG (Kleinunternehmer)“ und nie einen Steuerbetrag. Erreicht dein Umsatz in OpenEOS 80 % der 100.000-€-Grenze im laufenden Jahr, siehst du einen Hinweis im Dashboard. Wirst du umsatzsteuerpflichtig, stellst du das mit Cloud-TSE über „Steuerstatus ändern“ um: OpenEOS erstellt vorher einen Kassenabschluss, damit alle bisherigen Buchungen noch steuerfrei abgeschlossen sind.',
      en: 'For small businesses, receipts, refund receipts and deposit returns show "Tax-exempt under § 19 (1) UStG (small business)" and never a VAT amount. When your revenue in OpenEOS reaches 80 % of the 100,000 € limit of the current year, the dashboard shows a notice. If you become VAT-liable and use the Cloud-TSE, switch via "Change tax status": OpenEOS creates a cash point closing first so that all earlier bookings are closed as tax-exempt.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'verbessert',
    titel: {
      de: 'Kassenbuch: Wechselgeld aus der Vereinskasse',
      en: 'Cash book: change money from the club cash box',
    },
    kurz: {
      de: 'Wechselgeld aus der Vereinskasse buchst du jetzt als „Wechselgeld aus Vereinskasse“, den Anfangsbestand nur noch für den Rest vom letzten Abschluss.',
      en: 'Change money from the club cash box is now booked as "Change money from club cash box"; the opening balance is only for what was left at the last closing.',
    },
    text: {
      de: 'Nach Rücksprache mit einem Steuerberater ist der Anfangsbestand nur das Bargeld, das beim Öffnen schon in der Kasse liegt. OpenEOS schlägt dafür den zuletzt gezählten Bestand vor. Wechselgeld, das du aus der Vereinskasse holst, ist ein Geldtransit („Wechselgeld aus Vereinskasse“), das Abschöpfen am Ende ebenso („Abschöpfung an Vereinskasse“). Bisherige Einträge bleiben gültig. Gibt der Verein Pfandbecher zurück, die vor der Umstellung im November ohne Umsatzsteuer verkauft wurden, mindern sie die Steuer nicht mehr: OpenEOS bucht sie zuerst gegen diesen Altsaldo und zeigt den Rest in den Pfand-Einstellungen.',
      en: 'After consulting a tax advisor, the opening balance is only the cash already in the drawer when you open it. OpenEOS suggests the last counted amount for it. Change money you take from the club cash box is a cash transfer ("Change money from club cash box"), and so is skimming at the end ("Transfer to club cash box"). Existing entries stay valid. Returned deposit cups that were sold without VAT before the switch in November no longer reduce VAT: OpenEOS books them against this old balance first and shows what is left in the deposit settings.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Beleg per QR-Code oder E-Mail',
      en: 'Receipt by QR code or e-mail',
    },
    kurz: {
      de: 'Nach dem Kassieren bietest du den Beleg als QR-Code, per E-Mail oder gedruckt an – auch später aus dem Verlauf.',
      en: 'After taking payment you offer the receipt as a QR code, by e-mail or printed – also later from the history.',
    },
    text: {
      de: 'Nach jeder Zahlung zeigt die Kasse jetzt „Beleg“: Mit „QR-Code“ scannt der Gast den Beleg mit dem Handy und öffnet ihn als Seite mit PDF zum Herunterladen, „E-Mail“ schickt ihn mit PDF-Anhang, „Bon drucken“ druckt ihn auf dem Bondrucker der Kasse – auch wenn der automatische Kassenbon aus ist. „Kein Beleg“ schließt das Fenster. Der digitale Beleg zeigt dasselbe wie der gedruckte Bon, mit MwSt, Pfand und TSE-Angaben, aber ohne Namen von Gästen. Die E-Mail-Adresse wird nur für den Versand verwendet und nicht gespeichert. Ein Beleg-Link bleibt 90 Tage gültig; aus dem Verlauf der Kasse kannst du den Beleg jederzeit neu ausgeben. So erfüllst du die Belegausgabepflicht auch ohne Papier, wenn der Gast einverstanden ist.',
      en: 'After every payment the till now shows "Receipt": with "QR code" the guest scans the receipt with their phone and opens it as a page with a PDF to download, "E-mail" sends it with a PDF attached, and "Print receipt" prints it on the till’s receipt printer – even if the automatic receipt is off. "No receipt" closes the window. The digital receipt shows the same as the printed one, with VAT, deposit and TSE details, but without guest names. The e-mail address is only used for sending and is not stored. A receipt link stays valid for 90 days; from the till’s history you can hand out the receipt again at any time. This way you meet the obligation to issue receipts without paper, if the guest agrees.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Bedienungen mit PIN und Kellnerabrechnung',
      en: 'Servers with PIN and server settlement',
    },
    kurz: {
      de: 'Bedienungen ohne Konto melden sich per PIN an gemeinsamen Kassen an; jede Buchung zeigt, wer sie gebucht hat, und am Schichtende gibt es die Abrechnung mit Bon.',
      en: 'Servers without an account sign in at shared tills with a PIN; every booking shows who made it, and at the end of the shift there is a settlement with a receipt.',
    },
    text: {
      de: 'Unter „Bedienungen“ legst du deine Helferinnen und Helfer mit einer Namensliste an, ohne Konto und ohne E-Mail. Jede Person bekommt eine PIN, die du als PIN-Zettel ausdruckst. Stellst du eine Kasse auf „Gemeinsame Kasse“, meldet sich vor dem Buchen jede Bedienung mit ihrer PIN an, wechselt in Sekunden und sperrt die Kasse, wenn sie geht; ihr Warenkorb bleibt so lange gemerkt. Bestellungen, Zahlungen, Stornos und Pfand zeigen dann, wer gebucht hat, und Tische tragen die Farbe ihrer Bedienung. Über den Chip mit dem Namen sieht jede Bedienung ihren Zwischenstand; die Schichtleitung rechnet am Ende ab, mit Bon und Unterschriftszeilen. Offene Tische übergibst du vorher an eine andere Bedienung. Im Bericht „Bedienungen“ und im Bestellexport findest du die Zahlen je Person. Hast du an einer Kasse bisher „PIN verlangen“ genutzt, läuft sie jetzt als gemeinsame Kasse; Mitglieds-PINs gelten weiter, leg für Helfer aber besser Bedienungen statt Mitglieder an. Bedienungsdaten werden nach festen Fristen anonymisiert, Details stehen in der Dokumentation.',
      en: 'Under "Servers" you add your helpers from a list of names, without an account and without an e-mail address. Everyone gets a PIN that you print as a PIN slip. If you set a till to "Shared till", every server signs in with their PIN before booking, switches in seconds and locks the till when leaving; their cart is kept in the meantime. Orders, payments, cancellations and deposits then show who booked them, and tables carry the color of their server. Via the chip with their name every server sees their running total; at the end the shift lead settles them, with a receipt and signature lines. Hand open tables over to another server first. The "Servers" report and the order export show the figures per person. If a till used "Require PIN" so far, it now runs as a shared till; member PINs keep working, but for helpers it is better to add servers instead of members. Server data is anonymized after fixed periods; details are in the documentation.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Drei Betriebsarten statt Bargeld-Schalter',
      en: 'Three operating modes instead of a cash switch',
    },
    kurz: {
      de: 'Unter „Betriebsart“ wählst du „Nur Bons“, „Bargeldlos“ oder „Alle Funktionen“; das Land deiner Organisation ist jetzt Pflicht.',
      en: 'Under "Operating mode" you choose "Orders only", "Cashless" or "All features"; your organization’s country is now required.',
    },
    text: {
      de: 'Aus dem Schalter „Bargeldloser Modus“ sind drei Betriebsarten geworden, die du als Admin unter Einstellungen → Organisation → Betriebsart wählst. „Nur Bons“ nimmt Bestellungen auf und schickt sie an Küche und Theke, ohne Preise und Zahlungen; kassiert wird außerhalb, etwa mit Wertmarken. „Bargeldlos“ bietet alles mit Karte und Online-Zahlung, nur ohne Bargeld. „Alle Funktionen“ nimmt auch Bargeld an, in Deutschland nur mit Cloud-TSE. Jede Organisation braucht dafür jetzt ein Land, bestehende fragt OpenEOS einmal danach. Sie arbeiten als „Alle Funktionen (Bestand)“ weiter, bis du wechselst; war der bargeldlose Modus an, bist du schon in „Bargeldlos“. Jeder Wechsel steht im Verlauf, und für „Nur Bons“ und „Bargeldlos“ gibt es eine Herstellerbescheinigung für deine Verfahrensdokumentation.',
      en: 'The "Cashless mode" switch has become three operating modes, which you as an admin choose under Settings → Organization → Operating mode. "Orders only" takes orders and sends them to the kitchen and bar, without prices and payments; money is taken outside OpenEOS, for example with tokens. "Cashless" offers everything with card and online payment, just without cash. "All features" also accepts cash, in Germany only with the Cloud TSE. For this every organization now needs a country, and existing ones are asked once. They keep working as "All features (existing)" until you switch; if cashless mode was on, you are already in "Cashless". Every switch is listed in the history, and for "Orders only" and "Cashless" there is a manufacturer’s certificate for your process documentation.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Erinnerungen zu deinen Veranstaltungen',
      en: 'Reminders for your events',
    },
    kurz: {
      de: 'Eine Woche vor dem Fest kommt eine Checkliste per E-Mail, am Vortag die wichtigsten Zeiten und danach ein Rückblick mit Zahlen.',
      en: 'A week before your event you get a checklist by e-mail, the day before the key times, and afterwards a review with figures.',
    },
    text: {
      de: "Als Admin bekommst du jetzt Mails zu deinen Veranstaltungen. Eine Woche vorher „Dein Fest rückt näher“ mit einer Checkliste aus deinen echten Daten: Kassen verbunden, Drucker online und Testdruck, Bedienungen, Produkte und Preise, Impressum und Datenschutzhinweis für Shop und QR-Bestellung, Betriebsart und Cloud-TSE, jeweils mit Haken oder Kreuz und einem Link an die richtige Stelle. Am Tag vor dem Verkaufsstart „Morgen geht's los“ mit der Uhrzeit, ab der echt verkauft wird, dem Hinweis, dass die Testbestellungen dann gelöscht werden, und der Nummer des Notfall-Supports. Nach dem Fest „Danke! So lief dein Fest“ mit Bestellungen, Umsatz und den drei meistverkauften Produkten, ohne Testbestellungen, und Links zu Berichten, CSV-Export und Kellnerabrechnungen. Ist eine Veranstaltung eine Woche vorher noch im Testmodus, erinnern wir dich ans Freischalten. Unter Einstellungen → Organisation → Benachrichtigungen schaltest du jede Mail für alle Admins ab, unter Einstellungen → Persönlich → Einstellungen nur für dich.",
      en: 'As an admin you now get e-mails about your events. A week before, "Your event is coming up" with a checklist from your real data: tills connected, printers online and a test print, servers, products and prices, imprint and privacy notice for the shop and QR ordering, operating mode and Cloud TSE, each with a tick or a cross and a link to the right place. The day before sales start, "Tomorrow is the day" with the time real sales begin, the note that test orders are deleted then, and the emergency support number. After the event, "Thank you! This is how your event went" with orders, revenue and the three best-selling products, without test orders, and links to reports, CSV export and server settlements. If an event is still in test mode a week before, we remind you to activate it. Under Settings → Organization → Notifications you turn each e-mail off for all admins, under Settings → Personal → Preferences just for you.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Geplant, Aktiv, Beendet: Phasen einer Veranstaltung',
      en: 'Planned, Active, Ended: the phases of an event',
    },
    kurz: {
      de: 'Nach dem Freischalten testest du weiter, echt verkauft wird ab dem Vorabend, und nach dem letzten Tag bleibt bis 12 Uhr Kulanz.',
      en: 'After activation you keep testing, real sales start the evening before, and after the last day there is grace time until noon.',
    },
    text: {
      de: 'Eine freigeschaltete Veranstaltung verkauft nicht mehr sofort und unbegrenzt echt. Bis zum Verkaufsstart ist sie „Geplant“: Kasse, Tische und QR-Bestellung buchen Testbestellungen. Echte Verkäufe beginnen zwölf Stunden vor dem ersten Veranstaltungstag, bei einem Fest am 16. also am 15. um 18 Uhr, damit du schon am Aufbauabend kassieren kannst; den Vorlauf änderst du unter „Echter Verkauf beginnt vorher“. Dann werden die Testbestellungen gelöscht, deine Einrichtung bleibt. Nach dem letzten Tag hast du bis 12 Uhr Zeit für späte Deckel, danach ist die Veranstaltung „Beendet“: keine neuen Bestellungen, kassieren, erstatten und auswerten geht weiter. Mit „Vorverkauf im Shop“ nimmt dein Shop schon vorher echte Bestellungen an. Ab dem Verkaufsstart steht der Beginn fest, das Ende kannst du nur noch vorziehen.',
      en: 'An activated event no longer sells for real straight away and without end. Until sales start it is "Planned": the till, tables and QR ordering book test orders. Real sales start twelve hours before the first event day, so for a party on the 16th that is 6 pm on the 15th, and you can already take money on the set-up evening; you change the lead time under "Real sales start earlier". Then the test orders are deleted and your setup stays. After the last day you have until noon for late tabs, then the event is "Ended": no new orders, while taking payments, refunds and reports keep working. With "Shop pre-sale" your shop takes real orders even before that. Once sales have started the start date is fixed, and the end can only be brought forward.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Neue Rechtstexte und der Bereich „Rechtliches“',
      en: 'New legal texts and the "Legal" area',
    },
    kurz: {
      de: 'AGB, Auftragsverarbeitungsvertrag, Datenschutzerklärung und Impressum sind neu; du bestätigst sie einmal und findest alles unter „Rechtliches“.',
      en: 'Terms, data processing agreement, privacy policy and imprint are new; you confirm them once and find everything under "Legal".',
    },
    text: {
      de: 'Wir haben unsere AGB, den Auftragsverarbeitungsvertrag (AVV), die Datenschutzerklärung und das Impressum neu gefasst. Sie stehen auf openeos.de als eigene Seiten mit PDF, ältere Fassungen bleiben unter ihrem Datum abrufbar. Als Admin einer Organisation bestätigst du die neuen AGB und den AVV einmal in einem Fenster nach der Anmeldung; bei der Registrierung setzt du dafür zwei Häkchen. Unter „Rechtliches“ im Benutzermenü und in den Einstellungen findest du alle Texte, welche Fassung du wann akzeptiert hast, die Liste der Unterauftragsverarbeiter, die Angaben für die Meldung deiner Kasse beim Finanzamt über ELSTER und eine Vorlage für den Datenschutzhinweis deines Shops.',
      en: 'We have rewritten our terms (AGB), the data processing agreement (AVV), the privacy policy and the imprint. They are on openeos.de as separate pages with a PDF, and older versions stay available under their date. As an admin of an organization you confirm the new terms and the AVV once in a window after signing in; when registering you tick two boxes for it. Under "Legal" in the user menu and in the settings you find all texts, which version you accepted and when, the list of sub-processors, the details for reporting your till to the tax office via ELSTER and a template for your shop’s privacy notice.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Shop und QR-Bestellung nur mit Impressum und Datenschutzhinweis',
      en: 'Shop and QR ordering only with imprint and privacy notice',
    },
    kurz: {
      de: 'Fehlen Impressum oder Datenschutzhinweis deines Vereins, nehmen Shop und QR-Bestellung keine Bestellungen an; eine Vorlage hilft beim Datenschutzhinweis.',
      en: 'If your club’s imprint or privacy notice is missing, the shop and QR ordering take no orders; a template helps with the privacy notice.',
    },
    text: {
      de: 'Wer online verkauft, braucht ein Impressum und einen Datenschutzhinweis. Fehlt bei deiner Organisation eines davon, zeigt der Online-Shop zwar die Speisekarte, nimmt aber keine Bestellungen an, auch im Testmodus nicht; dasselbe gilt für die Bestellung per QR-Code am Tisch. In der Veranstaltung weist OpenEOS dich darauf hin und führt dich mit „Rechtliche Angaben eintragen“ direkt zum Formular. Für den Datenschutzhinweis gibt es unter „Rechtliches“ eine Vorlage: Name, Anschrift und E-Mail deiner Organisation sind schon eingesetzt, den Rest füllst du aus und übernimmst den Text mit einem Klick. Vor dem Bezahlen steht im Shop außerdem, bei wem der Gast bestellt.',
      en: 'Anyone selling online needs an imprint and a privacy notice. If your organization lacks either of them, the online shop still shows the menu but takes no orders, not even in test mode; the same applies to ordering by QR code at the table. In the event OpenEOS points this out and takes you straight to the form with "Add legal information". For the privacy notice there is a template under "Legal": your organization’s name, address and e-mail are already filled in, you complete the rest and adopt the text with one click. Before paying, the shop now also says who the guest is ordering from.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Assistent: Speisekarte importieren und Icons vorschlagen',
      en: 'Assistant: import your menu and suggest icons',
    },
    kurz: {
      de: 'Lade Fotos, eine PDF oder den Text deiner Speisekarte hoch, und der Assistent macht daraus Kategorien und Produkte, die du vor dem Anlegen prüfst.',
      en: 'Upload photos, a PDF or the text of your menu, and the assistant turns it into categories and products that you check before they are created.',
    },
    text: {
      de: 'Der neue Assistent nimmt dir beim Einrichten Arbeit ab. Ein Admin schaltet ihn unter Einstellungen → Organisation → Assistent ein. Danach öffnest du auf der Produktseite „Importieren“ und lädst im Reiter „Speisekarte“ Fotos oder eine PDF hoch oder fügst den Text ein. Daraus entsteht ein Vorschlag mit Kategorien, Produkten, Preisen, Mehrwertsteuer, Pfand, Größen und Icons, den du in einer Tabelle prüfst; angelegt wird erst, wenn du bestätigst. Im Produktformular schlägt „Vorschlag“ bis zu drei passende Icons vor. Dafür nutzen wir ein Sprachmodell von IONOS, das in einem IONOS-Rechenzentrum in Berlin läuft; die Inhalte werden dort nach Angaben von IONOS nicht gespeichert und nicht zum Trainieren verwendet. Übertragen werden nur Speisekarte und Produktnamen, und hochgeladene Dateien löscht OpenEOS spätestens nach 24 Stunden.',
      en: 'The new assistant saves you work during setup. An admin switches it on under Settings → Organization → Assistant. Then you open "Import" on the products page and, in the "Menu" tab, upload photos or a PDF or paste the text. This becomes a suggestion with categories, products, prices, VAT, deposits, sizes and icons, which you check in a table; nothing is created until you confirm. In the product form "Suggest" proposes up to three matching icons. For this we use a language model from IONOS that runs in an IONOS data centre in Berlin; according to IONOS, the content is not stored there and not used for training. Only the menu and product names are transferred, and OpenEOS deletes uploaded files after 24 hours at the latest.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Pfand mit Steuersatz und Beleg zur Rückgabe',
      en: 'Deposits with a VAT rate and a return receipt',
    },
    kurz: {
      de: 'Jeder Pfand-Typ hat einen Steuersatz, jede Pfandauszahlung bekommt einen Beleg, und ein neuer Bericht zeigt die Umsatzsteuer je Satz.',
      en: 'Every deposit type has a VAT rate, every deposit payout gets a receipt, and a new report shows the VAT per rate.',
    },
    text: {
      de: 'Pfand gehört steuerlich zum Entgelt und wird mit dem Satz der Ware versteuert, für die es erhoben wird. Unter „Pfand“ wählst du deshalb für jeden Pfand-Typ den Steuersatz, meist 19 %; für Becher zu Getränken und Teller zu Speisen legst du getrennte Typen an. Auf dem Kassenbon steht das Pfand als eigene Zeile und ist in der ausgewiesenen Mehrwertsteuer enthalten. Zahlst du an der Kasse Pfand aus, entsteht ein Beleg „Pfandrückgabe“ mit Belegnummer, den du druckst wie einen Kassenbon. In der Auswertung zeigt die neue Karte „Umsatzsteuer“ Ware, Pfand und Pfandrückgaben je Steuersatz, auch als CSV und PDF. Weist deine Organisation keine Umsatzsteuer aus, ändert sich nichts, und schon gebuchtes Pfand bleibt, wie es war.',
      en: 'For tax purposes a deposit is part of the price and is taxed at the rate of the goods it is charged for. Under "Deposit" you therefore choose a VAT rate for every deposit type, usually 19 %; for cups with drinks and plates with food you create separate types. On the receipt the deposit has its own line and is included in the VAT shown. When you pay out a deposit at the till, a "Deposit return" receipt with a receipt number is created, which you print like a sales receipt. In the reports the new "VAT" card shows goods, deposits and deposit returns per rate, also as CSV and PDF. If your organization does not charge VAT, nothing changes, and deposits already booked stay as they were.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Webhooks: OpenEOS meldet sich bei deinem System',
      en: 'Webhooks: OpenEOS notifies your system',
    },
    kurz: {
      de: 'Unter „Webhooks“ lässt du dir Bestellungen, Zahlungen und andere Ereignisse sofort an eine eigene Adresse schicken.',
      en: 'Under "Webhooks" you have orders, payments and other events sent straight to an address of your own.',
    },
    text: {
      de: 'Statt dass ein Skript immer wieder nachfragt, schickt OpenEOS jetzt selbst eine Nachricht, sobald etwas passiert: wenn eine Bestellung angelegt oder bezahlt wird, bei Erstattungen, Shop-Bestellungen und Pfandrückgaben, wenn eine Veranstaltung in die nächste Phase geht oder sich ein Produkt ändert. Als Admin richtest du unter Einstellungen → Organisation → Webhooks bis zu zehn Empfänger ein und wählst die Ereignisse aus. Jede Nachricht ist signiert, damit dein System prüfen kann, dass sie von OpenEOS kommt. Im Zustellprotokoll siehst du jeden Versuch und kannst ihn wiederholen; klappt die Zustellung einen Tag lang nicht, schaltet OpenEOS den Empfänger ab und schreibt dir. Gästedaten und Testbestellungen gehen nur mit, wenn du es einschaltest.',
      en: 'Instead of a script asking again and again, OpenEOS now sends a message itself as soon as something happens: when an order is created or paid, on refunds, shop orders and deposit returns, when an event moves to its next phase or a product changes. As an admin you set up to ten receivers under Settings → Organization → Webhooks and choose the events. Every message is signed so your system can check that it comes from OpenEOS. The delivery log shows every attempt and lets you repeat it; if delivery fails for a whole day, OpenEOS switches the receiver off and lets you know. Guest data and test orders are only included if you switch that on.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'API-Zugänge und KI-Agenten',
      en: 'API access and AI agents',
    },
    kurz: {
      de: 'Mit einem API-Token binden Skripte, Automatisierungen und KI-Agenten deine Organisation an; alle Endpunkte stehen in der API-Referenz.',
      en: 'With an API token, scripts, automations and AI agents connect to your organization; all endpoints are listed in the API reference.',
    },
    text: {
      de: 'Unter Einstellungen → Organisation → Zugänge legst du als Admin API-Tokens an, mit Namen, ausgewählten Rechten und auf Wunsch einem Ablaufdatum. Damit greifen Skripte und Automatisierungen auf Veranstaltungen, Produkte, Tische, Schichtpläne, Berichte und Bestellungen deiner Organisation zu. Über denselben Zugang verbindest du auch einen KI-Agenten, den du ohnehin nutzt: OpenEOS spricht MCP, und der Agent legt dann zum Beispiel Produkte an oder baut einen Schichtplan auf. Jede Änderung zeigt er dir erst als Vorschau, und alles landet im Protokoll. Kassieren, Zahlungen, Mitglieder und Löschen gehen nur in der App. Die API-Referenz und die Anleitung für Agenten findest du auf docs.openeos.de.',
      en: 'Under Settings → Organization → Access you as an admin create API tokens, with a name, selected permissions and an optional expiry date. Scripts and automations use them to access your organization’s events, products, tables, shift plans, reports and orders. The same access also connects an AI agent you already use: OpenEOS speaks MCP, and the agent can then, for example, create products or build a shift plan. It shows you every change as a preview first, and everything is logged. The till, payments, members and deleting only work in the app. The API reference and the guide for agents are on docs.openeos.de.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Cloud-TSE für Bargeld kommt in Kürze',
      en: 'Cloud TSE for cash coming soon',
    },
    kurz: {
      de: 'Für Bargeld in Deutschland haben wir die Cloud-TSE vorbereitet: ohne Hardware und automatisch zur Veranstaltung. Bis dahin nutzt du „Nur Bons“ oder „Bargeldlos“.',
      en: 'For cash in Germany we have prepared the Cloud TSE: no hardware and set up automatically for your event. Until then you use "Orders only" or "Cashless".',
    },
    text: {
      de: 'Wer in Deutschland über eine elektronische Kasse Bargeld annimmt, braucht eine zertifizierte TSE. Dafür haben wir die Cloud-TSE vorbereitet; in der App steht sie noch als „Bald verfügbar“ und kommt in Kürze. Hardware brauchst du dann keine: Schaltest du in „Alle Funktionen“ eine Veranstaltung frei, richtet OpenEOS die TSE rechtzeitig vor dem Verkaufsstart selbst ein und meldet sie zum Monatsende wieder ab, derzeit im Preis der Veranstaltung inklusive. Jeder Bon trägt dann die TSE-Angaben mit QR-Code, und für eine Kassen-Nachschau des Finanzamts lädst du den DSFinV-K- und den TSE-Export mit wenigen Klicks herunter. Bis die Cloud-TSE da ist, arbeitest du in Deutschland mit „Nur Bons“ oder „Bargeldlos“.',
      en: 'Anyone in Germany who takes cash through an electronic till needs a certified TSE. For this we have prepared the Cloud TSE; in the app it is still marked "Coming soon" and will arrive shortly. You will not need any hardware: when you activate an event in "All features", OpenEOS sets up the TSE in good time before sales start and deregisters it at the end of the month, currently included in the event price. Every receipt then carries the TSE details with a QR code, and for a cash audit by the tax office you download the DSFinV-K and TSE exports in a few clicks. Until the Cloud TSE is here, you work with "Orders only" or "Cashless" in Germany.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Kassenbuch für Wechselgeld und Kassensturz',
      en: 'Cash book for change and cash counts',
    },
    kurz: {
      de: 'Wo deine Kasse Bargeld annimmt, buchst du Anfangsbestand, Einlagen, Entnahmen und den Kassensturz und siehst den Soll-Bestand.',
      en: 'Where your till accepts cash, you book the opening balance, cash in, cash out and the cash count and see the expected balance.',
    },
    text: {
      de: 'Nimmt deine Organisation Bargeld an, findest du im Menü der Kasse jetzt das Kassenbuch. Dort buchst du zu Beginn das Wechselgeld als Anfangsbestand, zwischendurch Einlagen und Entnahmen, wenn Geld dazukommt oder in den Tresor geht, und am Ende den Kassensturz: Du gibst den gezählten Betrag ein, und die Kasse zeigt sofort die Differenz zum Soll-Bestand. Der Soll-Bestand gilt für die Schublade des jeweiligen Geräts und ergibt sich aus Anfangsbestand, Barverkäufen, Bar-Erstattungen, Pfand-Auszahlungen und deinen Buchungen. In der Verwaltung siehst du unter „Kassenbuch“ den Bestand eines Geschäftstags je Gerät und für die ganze Kasse. In „Nur Bons“ und „Bargeldlos“ ist der Menüpunkt ausgeblendet.',
      en: 'If your organization accepts cash, the till menu now has a cash book. There you book the change at the start as the opening balance, cash in and cash out in between when money is added or goes to the safe, and the cash count at the end: you enter the amount counted, and the till immediately shows the difference to the expected balance. The expected balance applies to the drawer of each device and is made up of the opening balance, cash sales, cash refunds, deposit payouts and your bookings. In the admin area "Cash book" shows the balance of a business day per device and for the whole till. In "Orders only" and "Cashless" the menu item is hidden.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Bestellungen als CSV exportieren',
      en: 'Export orders as CSV',
    },
    kurz: {
      de: 'In der Bestellübersicht filterst du nach Zeitraum und lädst genau die gefilterten Bestellungen oder Positionen als CSV herunter.',
      en: 'In the order list you filter by period and download exactly the filtered orders or items as CSV.',
    },
    text: {
      de: 'Die Bestellübersicht in der Verwaltung hat jetzt einen Zeitraum mit „Von“ und „Bis“, der für die Liste und die Kacheln darüber gilt. Über den Knopf „Als CSV exportieren“ lädst du genau das herunter, was deine Filter gerade zeigen, über alle Seiten hinweg: als „Bestellungen“ mit einer Zeile je Bestellung oder als „Positionen“ mit einer Zeile je Artikel, samt Einzelpreis und Steuersatz. Die Datei öffnest du direkt in Excel oder LibreOffice. Exportieren dürfen Admins und Mitglieder mit der Berechtigung „Bestellungen“.',
      en: 'The order list in the admin area now has a period with "From" and "To", which applies to the list and the tiles above it. The "Export as CSV" button downloads exactly what your filters currently show, across all pages: as "Orders" with one row per order or as "Items" with one row per item, including unit price and VAT rate. You open the file directly in Excel or LibreOffice. Admins and members with the "Orders" permission can export.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: '„Bedienung“ und „Gerät“ auf Bons',
      en: '"Waiter" and "Device" on tickets',
    },
    kurz: {
      de: 'Zwei neue Elemente im Bon-Editor drucken, wer die Bestellung aufgenommen hat und an welchem Gerät.',
      en: 'Two new elements in the ticket editor print who took the order and on which device.',
    },
    text: {
      de: 'Im Editor für Bon-Vorlagen findest du in der Gruppe „Bestellung“ die neuen Elemente „Bedienung“ und „Gerät“. „Bedienung“ druckt den Namen der Bedienung oder des Mitglieds, das die Bestellung gebucht hat, sonst den Namen des Geräts; „Gerät“ druckt immer das Gerät. Beschriftung, Ausrichtung, Fett und Groß stellst du ein wie bei den anderen Elementen, und die Zeile erscheint nur, wenn es einen Namen gibt. Der Standard-Küchenbon zeigt die Bedienung unter der Uhrzeit, Kassenbons für Gäste bleiben ohne Namen. Deine gespeicherten Vorlagen ändern sich nicht. Danke an Bier57 für die Idee und die erste Umsetzung!',
      en: 'In the ticket template editor the "Order" group has two new elements, "Waiter" and "Device". "Waiter" prints the name of the server or member who booked the order, otherwise the name of the device; "Device" always prints the device. You set label, alignment, bold and large as for the other elements, and the line only appears if there is a name. The default kitchen ticket shows the waiter below the time, while guest receipts stay without names. Your saved templates do not change. Thanks to Bier57 for the idea and the first implementation!',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Konto und Organisation selbst löschen',
      en: 'Delete your account and organization yourself',
    },
    kurz: {
      de: 'Konto oder Organisation löschst du jetzt selbst; 30 Tage lang kannst du noch alles exportieren oder die Löschung abbrechen.',
      en: 'You now delete your account or organization yourself; for 30 days you can still export everything or cancel the deletion.',
    },
    text: {
      de: 'In deinen persönlichen Einstellungen unter „Konto“ löschst du dein Konto, als Admin unter Einstellungen → Organisation → Allgemein die ganze Organisation. Eine gelöschte Organisation bleibt danach 30 Tage lang zum Lesen da: Ein Hinweis nennt das Datum der endgültigen Löschung, und bis dahin exportierst du Auswertungen, Bestellungen und Kassendaten. E-Mails erinnern dich vorher, und mit „Löschung abbrechen“ holst du alles zurück. Bist du einziges Mitglied einer Organisation, geht sie mit deinem Konto mit, ebenfalls erst nach 30 Tagen. TSE-Daten und Kassenabschlüsse bleiben die vorgeschriebenen zehn Jahre aufbewahrt. Unter „Konto“ schaltest du außerdem jederzeit ein oder aus, ob du Neuigkeiten per E-Mail bekommst.',
      en: 'In your personal settings under "Account" you delete your account, and as an admin under Settings → Organization → General the whole organization. A deleted organization then stays available read-only for 30 days: a notice shows the date of the final deletion, and until then you export reports, orders and till data. E-mails remind you beforehand, and "Cancel deletion" brings everything back. If you are the only member of an organization, it goes along with your account, also only after 30 days. TSE data and cash point closings are kept for the required ten years. Under "Account" you can also switch on or off at any time whether you get news by e-mail.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'neu',
    titel: {
      de: 'Notfall-Support am Veranstaltungstag',
      en: 'Emergency support on event days',
    },
    kurz: {
      de: 'Hast du eine Veranstaltung gebucht, bekommst du für kritische Störungen eine Telefonnummer, an der Kasse direkt zum Anrufen.',
      en: 'Once you have booked an event, you get a phone number for critical problems, which you can call straight from the till.',
    },
    text: {
      de: 'Fällt am Festtag die Kasse aus und es gibt keinen Umweg, hilft dir jetzt eine Telefonnummer weiter. Sobald deine Organisation eine Veranstaltung gebucht hat, steht die Nummer unter „Support“, in der Buchungsbestätigung und, solange die Veranstaltung geplant ist oder läuft, im Dashboard und bei den Veranstaltungen. An der Kasse findest du sie während des echten Verkaufs im Menü unter „Notfall-Support“ und rufst auf Tablet oder Handy direkt an. Die Nummer ist nur für Störungen gedacht, die deinen Verkauf stoppen; alles andere schreibst du wie gewohnt in den Support-Chat oder per E-Mail. Im Testmodus gibt es keinen Notfall-Support.',
      en: 'If the till fails on the day of your event and there is no way around it, a phone number now helps. As soon as your organization has booked an event, the number is shown under "Support", in the booking confirmation and, while the event is planned or running, on the dashboard and with the events. At the till you find it in the menu under "Emergency support" during real sales and call it directly from a tablet or phone. The number is only meant for problems that stop your sales; everything else goes to the support chat or by e-mail as usual. There is no emergency support in test mode.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'verbessert',
    titel: {
      de: 'Buchen mit Zusammenfassung',
      en: 'Booking with a summary',
    },
    kurz: {
      de: 'Vor dem Bezahlen siehst du alles auf einen Blick und buchst mit „Kostenpflichtig buchen“; fehlende Rechnungsangaben fragt der Dialog ab.',
      en: 'Before paying you see everything at a glance and book with "Book with obligation to pay"; the dialog asks for missing billing details.',
    },
    text: {
      de: 'Beim Freischalten einer Veranstaltung zeigt der letzte Schritt jetzt eine Zusammenfassung: Veranstaltung, Termine, berechnete Veranstaltungstage, Leistung und Preis mit dem Hinweis zur Umsatzsteuer, dazu ein Link zu den AGB. Gebucht wird mit „Kostenpflichtig buchen“. Bei der Registrierung fragen wir weiterhin keine Rechnungsdaten ab. Fehlen beim ersten Kauf der offizielle Name oder die Rechnungsanschrift deiner Organisation, fragt der Dialog sie in einem kurzen Schritt ab und speichert sie bei der Organisation; beim nächsten Kauf ist alles schon da. Ändern kannst du die Angaben unter Einstellungen → Organisation.',
      en: 'When you activate an event, the last step now shows a summary: event, dates, event days charged, service and price with the VAT note, plus a link to the terms. You book with "Book with obligation to pay". We still do not ask for billing details when you register. If your organization’s official name or billing address is missing at the first purchase, the dialog asks for them in a short step and saves them with the organization; at the next purchase everything is already there. You change the details under Settings → Organization.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'verbessert',
    titel: {
      de: 'Höchstzahlen für Organisationen und Mitglieder',
      en: 'Limits for organizations and members',
    },
    kurz: {
      de: 'Ein Konto kann in bis zu fünf Organisationen sein, eine Organisation hat Platz für zehn Mitglieder; der Support hebt das bei Bedarf an.',
      en: 'An account can be in up to five organizations and an organization has room for ten members; support raises this if you need more.',
    },
    text: {
      de: 'Auf app.openeos.de gelten jetzt Höchstzahlen: Ein Konto kann Mitglied in bis zu fünf Organisationen sein, und eine Organisation hat Platz für zehn Mitglieder, offene Einladungen eingerechnet. Neben „Mitglied einladen“ siehst du, wie viele Plätze belegt sind. Ist alles voll, ist der Knopf ausgegraut, und dasselbe gilt für „Neue Organisation“. Helfer aus Schichtplänen und Bedienungen zählen nicht mit. Brauchst du mehr, schreib dem Support, dann heben wir die Grenze für dich an.',
      en: 'On app.openeos.de there are now limits: an account can be a member of up to five organizations, and an organization has room for ten members, open invitations included. Next to "Invite member" you see how many places are taken. When everything is full the button is greyed out, and the same applies to "New organization". Helpers from shift plans and servers do not count. If you need more, write to support and we raise the limit for you.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'verbessert',
    titel: {
      de: 'Aufgeräumte Einstellungen, verschlüsselte Zugangsdaten',
      en: 'Tidier settings, encrypted credentials',
    },
    kurz: {
      de: 'Alle Karten in den Einstellungen sehen gleich aus, und die Zugangsdaten für SumUp und PayPal liegen verschlüsselt.',
      en: 'All cards in the settings look the same, and the credentials for SumUp and PayPal are stored encrypted.',
    },
    text: {
      de: 'Jede Karte in den Einstellungen hat jetzt denselben Kopf mit Symbol, Titel und einer kurzen Erklärung, in den persönlichen Einstellungen wie in der Organisation, am Handy wie am PC. So findest du schneller, was du suchst. Unsichtbar, aber wichtig: Die Zugangsdaten deiner Zahlungsanbieter SumUp und PayPal speichert OpenEOS jetzt verschlüsselt. In der Oberfläche siehst du wie bisher nur die letzten vier Zeichen, und an deinen Einstellungen musst du nichts ändern.',
      en: 'Every card in the settings now has the same header with an icon, a title and a short explanation, in your personal settings as well as in the organization, on the phone as on the PC. That way you find what you are looking for faster. Invisible but important: OpenEOS now stores the credentials of your payment providers SumUp and PayPal encrypted. The interface still only shows the last four characters, and you do not need to change anything in your settings.',
    },
  },
  {
    datum: '2026-11-09',
    art: 'behoben',
    titel: {
      de: 'Bonzeilen, Kategorien und Rechnungshinweis',
      en: 'Receipt lines, categories and invoice note',
    },
    kurz: {
      de: 'Bons passen wieder in die Zeile, Kategorien mit gelöschten Produkten lassen sich löschen, und Rechnungen per Karte tragen den Hinweis nach § 19 UStG.',
      en: 'Receipts fit their lines again, categories with deleted products can be deleted, and card-paid invoices carry the § 19 UStG note.',
    },
    text: {
      de: 'Auf 80-mm-Druckern rutschte bei Kassen- und Bestellbons das letzte Zeichen einer Artikelzeile in die nächste Zeile, auf 58-mm-Druckern liefen lange Namen und TSE-Angaben über den Rand. Jetzt steht der Betrag rechtsbündig, lange Namen brechen sauber um, und alles passt zur Papierbreite. Eine Kategorie ließ sich nicht löschen, wenn darin einmal gelöschte Produkte lagen; das geht jetzt, und hat sie noch Produkte, sagt OpenEOS dir das. Außerdem fehlte auf Rechnungen für Freischaltungen per Karte oder Lastschrift der Hinweis, dass nach § 19 UStG keine Umsatzsteuer berechnet wird. Er steht jetzt auf allen Rechnungen.',
      en: 'On 80 mm printers the last character of an item line on receipts and order tickets slipped onto the next line, and on 58 mm printers long names and TSE details ran over the edge. Now the amount is right-aligned, long names wrap cleanly and everything fits the paper width. A category could not be deleted if it contained products that had been deleted before; that works now, and if it still has products, OpenEOS tells you. Invoices for activations paid by card or direct debit were also missing the note that no VAT is charged under § 19 UStG. It is now on all invoices.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'neu',
    titel: {
      de: 'Eigene Drucker statt Miete',
      en: 'Your own printers instead of rentals',
    },
    kurz: {
      de: 'Ein kleiner Drucker-Agent auf einem PC oder Raspberry Pi findet deine USB- und Netzwerkdrucker von selbst; die Hardware-Vermietung gibt es nicht mehr.',
      en: 'A small printer agent on a PC or Raspberry Pi finds your USB and network printers by itself; hardware rental is gone.',
    },
    text: {
      de: 'Bons druckst du jetzt auf deinen eigenen Bondruckern. Dafür läuft auf einem Windows- oder Linux-PC in deinem Netz, auch auf einem Raspberry Pi, der Drucker-Agent: ein kleines Programm, das angeschlossene USB-Drucker und Netzwerkdrucker von selbst findet und bei OpenEOS meldet. Unter „Drucker“ verbindest du den Agent mit dem sechsstelligen Code, den er beim Start anzeigt, übernimmst die gefundenen Drucker mit einem Klick und schickst einen Testdruck. Welcher Drucker Kassenbons und welcher Küchenbons bekommt, stellst du wie gewohnt in der Web-App ein, am PC gibt es nichts weiter zu konfigurieren. Die Vermietung von Druckern und Geräten bieten wir nicht mehr an. Eine Schritt-für-Schritt-Anleitung findest du in der Dokumentation auf docs.openeos.de unter „Drucker“.',
      en: 'You now print receipts on your own receipt printers. The printer agent, a small program, runs on a Windows or Linux PC in your network, a Raspberry Pi works too. It finds connected USB printers and network printers by itself and reports them to OpenEOS. Under "Printers" you connect the agent with the six-digit code it shows on start, adopt the printers it found with one click and send a test print. Which printer gets receipts and which gets kitchen tickets is set up in the web app as before; there is nothing left to configure on the PC. We no longer rent out printers or other hardware. A step-by-step guide is in the documentation on docs.openeos.de under "Printers".',
    },
  },
  {
    datum: '2026-10-29',
    art: 'neu',
    titel: {
      de: 'Bargeldloser Modus',
      en: 'Cashless mode',
    },
    kurz: {
      de: 'Ein Schalter in den Zahlungseinstellungen sperrt Bargeld an Kasse, Erstattung und Pfand; Karte und Online bleiben.',
      en: 'A switch in the payment settings blocks cash at the till, for refunds and for deposits; card and online stay.',
    },
    text: {
      de: 'In den Zahlungseinstellungen deiner Organisation gibt es den neuen Schalter „Bargeldloser Modus“. Ist er an, nimmt keine Kasse mehr Bargeld an, Erstattungen gehen nur auf die ursprüngliche Karten- oder Online-Zahlung zurück, zurückgegebenes Pfand wird nicht bar ausgezahlt, sondern mit neuem Pfand verrechnet, und die Kassenlade bleibt zu. Karten- und Online-Zahlungen laufen weiter wie bisher. Ein Hinweis erklärt, warum das wichtig ist: Wer über eine elektronische Kasse Bargeld annimmt, braucht in Deutschland eine zertifizierte TSE, ohne Bargeld nicht. Willst du Bargeld wieder erlauben, fragt OpenEOS vorher nach, und jede Änderung steht mit Datum im Verlauf. Mehr dazu in den FAQ auf openeos.de.',
      en: 'The payment settings of your organization now have a "Cashless mode" switch. When it is on, no till accepts cash any more, refunds only go back to the original card or online payment, returned deposits are not paid out in cash but offset against new deposits, and the cash drawer stays closed. Card and online payments keep working as before. A note explains why it matters: in Germany, anyone taking cash through an electronic till needs a certified TSE, without cash you do not. If you want to allow cash again, OpenEOS asks you to confirm first, and every change is listed with its date in the history. Read more in the FAQ on openeos.de.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'neu',
    titel: {
      de: 'Bestellverlauf mit Storno und Erstattung',
      en: 'Order history with cancellation and refunds',
    },
    kurz: {
      de: 'Im Verlauf der Kasse stornierst du einzelne Positionen, erstattest teilweise oder ganz und druckst den Gegenbeleg.',
      en: 'In the till history you cancel single items, refund part or all of an order and print the counter-receipt.',
    },
    text: {
      de: 'Der Verlauf an der Kasse zeigt jede Bestellung mit einem klaren Status und lässt sich nach Zeitraum, Zahlart und Status filtern. Öffnest du eine Bestellung, kannst du einzelne Positionen stornieren oder den Betrag teilweise oder ganz erstatten, auch bei Kartenzahlungen über SumUp geht das Geld direkt zurück auf die Karte. Zu jeder Erstattung druckt OpenEOS einen Gegenbeleg, und die Küche bekommt bei stornierten Speisen einen Stornobon. In der Verwaltung findest du dieselben Möglichkeiten in der Bestellübersicht; dort siehst du jetzt auch die Zahlart jeder Bestellung, und stornierte Positionen sind durchgestrichen.',
      en: 'The till history shows every order with one clear status and can be filtered by period, payment method and status. Open an order to cancel single items or refund part or all of the amount; for card payments via SumUp the money goes straight back to the card. OpenEOS prints a counter-receipt for every refund, and the kitchen gets a cancellation ticket for cancelled dishes. In the admin area the order list offers the same options; it now also shows the payment method of every order, and cancelled items are struck through.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'verbessert',
    titel: {
      de: 'Rechnung direkt vom Zahlungsdienst',
      en: 'Invoices straight from the payment service',
    },
    kurz: {
      de: 'Bei „Auf Rechnung“ kommt die Rechnung per E-Mail mit Zahlseite und PDF, Erinnerungen laufen automatisch, bei Storno gibt es eine Gutschrift.',
      en: 'With "Pay by invoice" the invoice arrives by e-mail with a payment page and PDF, reminders run automatically, and a cancellation issues a credit note.',
    },
    text: {
      de: 'Schaltest du eine Veranstaltung „auf Rechnung“ frei, kommt die Rechnung jetzt direkt von unserem Zahlungsdienst per E-Mail, mit PDF und einem Link zur Zahlseite, auf der du per Überweisung oder Karte bezahlst. Ist die Rechnung nach der Frist noch offen, erinnert dich der Zahlungsdienst von selbst. Stornierst du die Freischaltung oder erstatten wir einen Betrag, bekommst du automatisch eine Gutschrift. Alle Rechnungen und Gutschriften deiner Organisation findest du unter „Abrechnung“.',
      en: 'If you activate an event "by invoice", the invoice now comes straight from our payment service by e-mail, with a PDF and a link to a payment page where you pay by bank transfer or card. If the invoice is still open after the due date, the payment service reminds you automatically. If you cancel the activation or we refund an amount, you automatically receive a credit note. All invoices and credit notes of your organization are listed under "Billing".',
    },
  },
  {
    datum: '2026-10-29',
    art: 'neu',
    titel: {
      de: 'Kostenlos stornieren bis 7 Tage vor Beginn',
      en: 'Free cancellation up to 7 days before the start',
    },
    kurz: {
      de: 'Eine bezahlte Freischaltung stornierst du bis sieben Tage vor Beginn selbst, das Geld kommt zurück.',
      en: 'Cancel a paid activation yourself up to seven days before the start and get your money back.',
    },
    text: {
      de: 'Fällt eine Veranstaltung aus, musst du nicht mehr beim Support anfragen: In der Veranstaltung siehst du deine Freischaltung und stornierst sie bis sieben Tage vor Beginn selbst, kostenlos. Der Betrag geht auf dem Zahlungsweg zurück, mit dem du bezahlt hast, bei Rechnungen als Gutschrift. Bis wann das geht, steht direkt neben der Freischaltung. Beginnt die Veranstaltung in weniger als sieben Tagen, sagt dir OpenEOS das schon vor dem Bezahlen.',
      en: 'If an event is called off, you no longer need to ask support: in the event you see your activation and cancel it yourself up to seven days before the start, free of charge. The amount goes back the way you paid, for invoices as a credit note. The deadline is shown right next to the activation. If the event starts in less than seven days, OpenEOS tells you before you pay.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'verbessert',
    titel: {
      de: 'Ein Veranstaltungstag geht von 6 bis 6 Uhr',
      en: 'An event day runs from 6 am to 6 am',
    },
    kurz: {
      de: 'Für die Abrechnung endet ein Tag erst um 6 Uhr morgens, eine Nacht bis 3 Uhr zählt als ein Tag.',
      en: 'For billing a day only ends at 6 in the morning, so a night until 3 am counts as one day.',
    },
    text: {
      de: 'Bisher zählte eine Veranstaltung, die über Mitternacht ging, als zwei Tage. Jetzt läuft ein Veranstaltungstag für die Abrechnung von 6 Uhr morgens bis 6 Uhr am nächsten Morgen. Ein Fest von 18 bis 3 Uhr ist damit ein Tag, ein Wochenende von Freitagabend bis Sonntagfrüh zwei. Beim Freischalten siehst du, wie viele Tage berechnet werden, und auf der Preisseite ist die Regel erklärt.',
      en: 'Until now an event that ran past midnight counted as two days. For billing, an event day now runs from 6 in the morning to 6 the next morning. A party from 6 pm to 3 am is therefore one day, a weekend from Friday evening to Sunday morning is two. When activating you see how many days are charged, and the rule is explained on the pricing page.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'neu',
    titel: {
      de: 'Impressum und Datenschutz deines Vereins',
      en: 'Your club’s imprint and privacy notice',
    },
    kurz: {
      de: 'Online-Shop und Helferseiten zeigen die rechtlichen Angaben deines Vereins, eingetragen in der Organisation.',
      en: 'The online shop and helper pages show your club’s legal information, entered in the organization.',
    },
    text: {
      de: 'Dein Online-Shop und die Seiten, auf denen sich Helfer für Schichten eintragen, sind öffentlich, und dafür ist dein Verein verantwortlich. In der Organisation trägst du deshalb jetzt Impressum und Datenschutzerklärung deines Vereins ein. Beide erscheinen im Fuß des Shops und der Helferseiten, getrennt von den Angaben zu OpenEOS selbst. Solange nichts eingetragen ist, weist OpenEOS dich in der Organisation darauf hin.',
      en: 'Your online shop and the pages where helpers sign up for shifts are public, and your club is responsible for them. That is why you now enter your club’s imprint and privacy notice in the organization. Both appear in the footer of the shop and the helper pages, separate from the details about OpenEOS itself. As long as nothing is entered, OpenEOS reminds you in the organization.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'verbessert',
    titel: {
      de: 'Keine echte Kartenzahlung im Testmodus',
      en: 'No real card payments in test mode',
    },
    kurz: {
      de: 'Solange eine Veranstaltung im Testmodus ist, löst die Kasse keine Zahlung auf dem SumUp-Lesegerät aus.',
      en: 'While an event is in test mode, the till does not trigger a payment on the SumUp card reader.',
    },
    text: {
      de: 'Im Testmodus probierst du die Kasse aus, und dabei soll niemand versehentlich seine Karte belasten. Die Kasse spricht das SumUp-Lesegerät deshalb erst an, wenn die Veranstaltung freigeschaltet ist; vorher ist die Kartenzahlung im Kassieren-Blatt ausgegraut und mit einem Hinweis versehen. Bar und die übrigen Zahlarten kannst du im Testmodus wie gewohnt durchspielen.',
      en: 'In test mode you try out the till, and nobody should accidentally have their card charged while doing so. The till therefore only talks to the SumUp card reader once the event is activated; before that, card payment is greyed out in the checkout sheet with a note. Cash and the other payment methods can be rehearsed in test mode as usual.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'verbessert',
    titel: {
      de: 'Produkt- und Kategorieberichte netto',
      en: 'Net product and category reports',
    },
    kurz: {
      de: 'Die Berichte je Produkt und Kategorie rechnen jetzt netto und passen zum Nettoumsatz der Veranstaltung.',
      en: 'The reports per product and category are now net and match the net revenue of the event.',
    },
    text: {
      de: 'Die Berichte je Produkt und je Kategorie zeigten bisher Bruttobeträge, der Umsatz der Veranstaltung aber netto, und beides ließ sich nicht zusammenbringen. Jetzt rechnen alle drei netto: Die Summen der Produkt- und Kategorieberichte ergeben zusammen genau den Nettoumsatz, Rabatte und Pfand sind dabei berücksichtigt. Ein Hinweis über der Tabelle erinnert daran, dass die Zahlen ohne Mehrwertsteuer sind.',
      en: 'The reports per product and per category used to show gross amounts while the event revenue was net, and the two could not be reconciled. Now all three are net: the totals of the product and category reports add up exactly to the net revenue, with discounts and deposits taken into account. A note above the table reminds you that the figures exclude VAT.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'verbessert',
    titel: {
      de: 'Offener Quellcode unter einer Lizenz',
      en: 'Open source under one licence',
    },
    kurz: {
      de: 'OpenEOS steht komplett unter der AGPL, und in jeder Oberfläche führt ein Link zum Quellcode.',
      en: 'OpenEOS is fully licensed under the AGPL, and every interface links to the source code.',
    },
    text: {
      de: 'Alle Teile von OpenEOS, von der Kasse über den Online-Shop bis zur Dokumentation, stehen jetzt unter derselben freien Lizenz, der GNU AGPL. Du darfst OpenEOS also selbst betreiben, anpassen und weitergeben, solange du Änderungen ebenfalls offenlegst. Im Fuß jeder Oberfläche findest du einen Link zum Quellcode und eine Übersicht der verwendeten Bausteine anderer Projekte.',
      en: 'All parts of OpenEOS, from the till and the online shop to the documentation, are now under the same free licence, the GNU AGPL. You may run OpenEOS yourself, adapt it and pass it on, as long as you publish your changes too. The footer of every interface links to the source code and to an overview of the building blocks from other projects we use.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'verbessert',
    titel: {
      de: 'Updates ohne Unterbrechung',
      en: 'Updates without interruption',
    },
    kurz: {
      de: 'Neue Versionen gehen in Betrieb, ohne dass die Kasse zwischendurch aussetzt.',
      en: 'New versions go live without the till pausing in between.',
    },
    text: {
      de: 'Bisher konnte eine Kasse während eines Updates für ein paar Sekunden keine Verbindung bekommen. Jetzt läuft die neue Version erst an und wird geprüft, bevor die alte abgeschaltet wird. Für dich heißt das: Updates passieren im Hintergrund, auch mitten in einer Veranstaltung, und die Kasse merkt davon nichts.',
      en: 'Until now a till could lose its connection for a few seconds during an update. Now the new version starts up and is checked before the old one is switched off. For you that means updates happen in the background, even in the middle of an event, and the till does not notice.',
    },
  },
  {
    datum: '2026-10-29',
    art: 'behoben',
    titel: {
      de: 'Kassenlade und nachgelieferte Küchenbons',
      en: 'Cash drawer and re-sent kitchen tickets',
    },
    kurz: {
      de: 'Die Kassenlade öffnet nur noch, wenn eine eingerichtet ist; nach einem Verbindungsabbruch nachgedruckte Küchenbons sehen richtig aus.',
      en: 'The cash drawer only opens if one is set up; kitchen tickets reprinted after a lost connection look right again.',
    },
    text: {
      de: 'Die Kasse versuchte bei jeder Barzahlung, eine Kassenlade zu öffnen, auch wenn an dem Gerät keine eingerichtet war, und meldete dann einen Fehler. Jetzt passiert das nur noch, wenn das Gerät eine Kassenlade hat. Außerdem wurden Küchenbons, die nach einem kurzen Verbindungsabbruch des Druckers nachgeliefert wurden, mit der falschen Vorlage gedruckt und kamen leer oder gar nicht an. Sie werden jetzt genau so gedruckt wie beim ersten Mal.',
      en: 'The till tried to open a cash drawer on every cash payment, even on devices without one, and then reported an error. Now it only does so if the device has a cash drawer. Kitchen tickets that were re-sent after a short loss of connection to the printer were also printed with the wrong template and arrived blank or not at all. They are now printed exactly as the first time.',
    },
  },
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
  '2026-11-09': '1.8',
  '2026-10-29': '1.7',
  '2026-10-08': '1.6',
  '2026-10-03': '1.5',
  '2026-09-24': '1.4',
  '2026-09-17': '1.3',
  '2026-09-16': '1.2',
  '2026-09-09': '1.1',
  '2026-09-02': '1.0',
};
