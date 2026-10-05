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
  '2026-10-03': '1.5',
  '2026-09-24': '1.4',
  '2026-09-17': '1.3',
  '2026-09-16': '1.2',
  '2026-09-09': '1.1',
  '2026-09-02': '1.0',
};
