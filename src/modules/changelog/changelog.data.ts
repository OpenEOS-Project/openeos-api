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
    datum: '2026-09-17',
    art: 'neu',
    titel: {
      de: 'Bildschirme per Code verbinden',
      en: 'Connect screens with a code',
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
  '2026-09-17': '1.3',
  '2026-09-16': '1.2',
  '2026-09-09': '1.1',
  '2026-09-02': '1.0',
};
