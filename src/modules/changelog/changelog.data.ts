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
    datum: '2026-09-24',
    art: 'behoben',
    titel: {
      de: 'Kassen und Bildschirme verbinden sich wieder',
      en: 'Tills and screens connect again',
    },
    kurz: {
      de: 'Geräte wurden dauerhaft als „offline" angezeigt — das ist behoben.',
      en: 'Devices were permanently shown as offline — fixed.',
    },
    text: {
      de: 'Kassen und Anzeigen konnten ihre Live-Verbindung nicht aufbauen und wurden dauerhaft als „offline" angezeigt, während die Bedienung selbst weiterlief. Bestellungen erreichten Küche und Anzeigen dadurch nicht sofort. Die Verbindung steht wieder; die Geräte müssen die Seite einmal neu laden.',
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
      de: 'Wenn wir auf eine Support-Anfrage antworten, bekommen Sie eine E-Mail mit einem Auszug und einem Link in den Chat. Bisher musste man von sich aus nachsehen, ob schon etwas da war.',
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
      de: 'Nach dem Abmelden war der Zugang technisch noch bis zu einer Stunde gültig. Jetzt endet er sofort. Betroffen ist nur das Gerät, an dem Sie sich abmelden — an der Kasse abzumelden wirft niemanden im Büro hinaus.',
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
      de: 'Fernseher und Tablets zeigen eine Zahl — die geben Sie in OpenEOS ein, fertig.',
      en: 'TVs and tablets show a number — enter it in OpenEOS and you are done.',
    },
    text: {
      de: 'Ein Fernseher oder Tablet zeigt beim Start eine sechsstellige Zahl. Diese Zahl geben Sie in OpenEOS ein — fertig. Wer ein Handy dabei hat, scannt stattdessen den QR-Code auf dem Bildschirm. Ein Kabel oder eine Einrichtung am Gerät selbst ist nicht nötig.',
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
      de: 'Für jeden Bildschirm lässt sich einstellen, wie er aussieht: hell oder dunkel, normale oder große Schrift für weit entfernte Monitore, eine eigene Überschrift und ein eigener Begrüßungstext. Änderungen erscheinen sofort auf dem Bildschirm — Sie müssen nicht hingehen.',
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
      de: 'Sie können sich einen Anmeldelink per E-Mail schicken lassen, statt ein Passwort einzugeben. Der Link gilt 15 Minuten und funktioniert genau einmal. Ein Passwort können Sie weiterhin verwenden — und wer sich neu anmeldet, braucht gar keines mehr zu vergeben.',
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
      de: 'Wer die Anmeldung mit zusätzlichem Code eingerichtet hatte, wurde beim Anmelden nicht danach gefragt — das Passwort allein genügte. Das ist behoben: Der Code wird jetzt verlangt, bevor die Anmeldung abgeschlossen ist. Wenn Sie ein Gerät als vertrauenswürdig markiert haben, bleibt es dabei.',
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
      de: 'Eine Veranstaltung lässt sich im Testmodus mit bis zu 25 Bestellungen ausprobieren, ohne etwas zu bezahlen. Erst wenn Sie darüber hinaus verkaufen wollen, wird sie freigeschaltet.',
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
      de: 'Veranstaltungen werden jetzt direkt per Karte oder Lastschrift bezahlt. Die Rechnung kommt automatisch per E-Mail und liegt zusätzlich unter „Rechnungen" zum Herunterladen bereit.',
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
  '2026-09-24': '1.4',
  '2026-09-17': '1.3',
  '2026-09-16': '1.2',
  '2026-09-09': '1.1',
  '2026-09-02': '1.0',
};
