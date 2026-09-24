/**
 * Die Bausteine für alle ausgehenden Mails.
 *
 * Warum Tabellen und durchgehend eingebettete Stile: E-Mail-Programme
 * sind keine Browser. Outlook rendert mit Word, Gmail entfernt
 * `<style>`-Blöcke, viele Clients kennen weder Flexbox noch Grid. Was
 * hier wie Technik von 2005 aussieht, ist der einzige Weg, der überall
 * gleich ankommt.
 *
 * Farben und Maße stammen aus den Designvorlagen und stehen bewusst als
 * Konstanten hier, nicht als Variablen im CSS — auch Custom Properties
 * fallen in den meisten Clients aus.
 */

const FARBE = {
  /** Seitenhintergrund, auch Kopf und Fuß. */
  papier: '#ece7d9',
  /** Die Karte in der Mitte. */
  flaeche: '#f5f2ea',
  ink: '#14180f',
  gruen: '#1e5433',
  mute: '#6b7068',
  linie: '#e3ded1',
  warnFlaeche: '#f7ead0',
  warnInk: '#c8871a',
  leise: '#a8ad9f',
} as const;

const SANS = "Arial, Helvetica, sans-serif";
const MONO = "'Courier New', Courier, monospace";

/** Fremdtext für HTML entschärfen. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wie escapeHtml, behält aber die Absätze.
 *
 * Nachrichten werden mit Zeilenumbrüchen geschrieben; in HTML gegossen
 * verschwinden sie, und aus einer gegliederten Antwort wird ein Block.
 */
export function escapeHtmlMitUmbruechen(text: string): string {
  return escapeHtml(text)
    .replace(/(?:\r?\n){2,}/g, '<br /><br />')
    .replace(/\r?\n/g, '<br />');
}

/** Überschrift — eine je Mail, die Kernaussage. */
export function ueberschrift(text: string): string {
  return `<h1 class="oe-h1" style="margin:0 0 12px;font-family:${SANS};font-size:30px;line-height:1.1;font-weight:bold;letter-spacing:-0.9px;color:${FARBE.ink}">${escapeHtml(text)}</h1>`;
}

/** Fließtext. `roh` nur für Text, der bereits entschärft ist. */
export function absatz(text: string, roh = false): string {
  return `<p style="margin:0 0 14px;font-family:${SANS};font-size:16px;line-height:1.55;color:${FARBE.mute};mso-line-height-rule:exactly">${roh ? text : escapeHtml(text)}</p>`;
}

/**
 * Die eine Hauptaktion.
 *
 * Als Tabelle mit `bgcolor`, nicht als gestaltetes `<a>`: Outlook
 * ignoriert `background` auf Links und zeigte sonst blauen Text auf
 * weißem Grund.
 */
export function knopf(url: string, beschriftung: string): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="${FARBE.ink}" style="border-radius:6px;padding:11px 18px">
<a href="${url}" style="display:block;font-family:${SANS};font-size:14px;font-weight:bold;line-height:1.1;color:${FARBE.flaeche};text-decoration:none">${escapeHtml(beschriftung)}</a>
</td></tr></table>`;
}

/** Label-Wert-Paare mit Trennlinien; Beschriftungen in Mono. */
export function datenblock(titel: string, zeilen: [string, string][]): string {
  const inhalt = zeilen
    .map(
      ([label, wert]) => `
    <tr>
      <td width="150" style="width:150px;padding:9px 12px 9px 0;font-family:${MONO};font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:${FARBE.mute};border-bottom:1px solid ${FARBE.linie}">${escapeHtml(label)}</td>
      <td style="padding:9px 0;font-family:${SANS};font-size:15px;font-weight:bold;color:${FARBE.ink};border-bottom:1px solid ${FARBE.linie}">${escapeHtml(wert)}</td>
    </tr>`,
    )
    .join('');

  return `
<p style="margin:0 0 14px;font-family:${MONO};font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:${FARBE.mute}">${escapeHtml(titel)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%">${inhalt}</table>`;
}

/** Abgesetzter Hinweis mit farbiger Kante. */
export function hinweis(titel: string, text: string, roh = false): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:${FARBE.warnFlaeche};border-radius:6px"><tr>
<td style="padding:14px 16px;border-left:3px solid ${FARBE.warnInk};font-family:${SANS}">
<p style="margin:0 0 3px;font-size:14px;font-weight:bold;color:${FARBE.warnInk}">${escapeHtml(titel)}</p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${FARBE.ink}">${roh ? text : escapeHtml(text)}</p>
</td></tr></table>`;
}

/** Ein Code zum Abtippen — groß, in Mono, mit Abstand zwischen den Zeichen. */
export function codeBlock(code: string): string {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:${FARBE.papier};border-radius:6px"><tr>
<td align="center" style="padding:18px 16px;font-family:${MONO};font-size:30px;font-weight:bold;letter-spacing:7px;color:${FARBE.ink}">${escapeHtml(code)}</td>
</tr></table>`;
}

/** Zitierter Fremdtext, etwa eine Support-Antwort. */
export function zitat(text: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background-color:${FARBE.papier};border-radius:6px"><tr>
<td style="padding:14px 16px;font-family:${SANS};font-size:14px;line-height:1.55;color:${FARBE.ink}">${escapeHtmlMitUmbruechen(text)}</td>
</tr></table>`;
}

/**
 * Die Adresse zum Selbstkopieren.
 *
 * Gehört unter jeden Knopf: Manche Clients öffnen Links nicht, und in
 * einer Weiterleitung geht der Knopf gern verloren.
 */
export function ersatzlink(url: string): string {
  const sichtbar = url.replace(/^https?:\/\//, '');
  return `<p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.6;color:${FARBE.mute}">Button funktioniert nicht? Diese Adresse im Browser öffnen:<br />
<a href="${url}" style="font-family:${MONO};font-size:12px;color:${FARBE.gruen};text-decoration:underline;word-break:break-all">${escapeHtml(sichtbar)}</a></p>`;
}

export interface RahmenOptionen {
  /** Steht im Kopf rechts, in Großbuchstaben — worum es geht. */
  kontext: string;
  /** Erscheint neben der Betreffzeile, etwa 85 Zeichen. */
  preheader: string;
  /** Der zusammengesetzte Inhalt. */
  inhalt: string;
  /** Für die Zeile „Diese Mail ging an …" unter der Karte. */
  empfaenger?: string;
  /** Titel im Browser, wenn die Mail dort geöffnet wird. */
  titel?: string;
  appUrl: string;
}

/**
 * Der Rahmen: Kopf mit Logo, Inhalt, Fuß mit Absender.
 *
 * Das Logo liegt auf openeos.de statt als Anhang — ein eingebettetes
 * Bild landet in manchen Clients als zweiter Anhang in der Liste, was
 * bei einer Rechnung unangenehm auffällt.
 */
export function rahmen(o: RahmenOptionen): string {
  const empfaengerZeile = o.empfaenger
    ? `<p style="margin:16px 0 0;font-family:${MONO};font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:${FARBE.leise}">Diese Mail ging an ${escapeHtml(o.empfaenger)}</p>`
    : '';

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(o.titel ?? 'OpenEOS')}</title>
<style>
@media only screen and (max-width:480px){
  .oe-w{width:100%!important}
  .oe-pad{padding-left:22px!important;padding-right:22px!important}
  .oe-h1{font-size:26px!important;line-height:1.15!important}
}
a{color:${FARBE.gruen}}
</style>
</head>
<body style="margin:0;padding:0;background-color:${FARBE.papier};-webkit-font-smoothing:antialiased">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all">${escapeHtml(o.preheader)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${FARBE.papier};width:100%">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="oe-w" style="width:600px;max-width:600px;background-color:${FARBE.flaeche};border-radius:10px;overflow:hidden">

<tr><td class="oe-pad" style="padding:22px 32px 20px;background-color:${FARBE.flaeche};border-bottom:2px solid ${FARBE.ink}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%"><tr>
    <td align="left"><a href="https://openeos.de" style="text-decoration:none"><img src="https://openeos.de/logo_dark_trans.png" width="110" height="33" alt="OpenEOS" style="display:block;width:110px;height:33px;border:0;outline:none;text-decoration:none" /></a></td>
    <td align="right" style="font-family:${MONO};font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:${FARBE.gruen}">${escapeHtml(o.kontext)}</td>
  </tr></table>
</td></tr>

<tr><td class="oe-pad" style="padding:32px 32px 24px">${o.inhalt}</td></tr>

<tr><td class="oe-pad" style="padding:22px 32px 26px;background-color:${FARBE.papier};border-top:1px solid ${FARBE.linie}">
  <p style="margin:0 0 8px;font-family:${MONO};font-size:11px;line-height:1.7;letter-spacing:0.6px;color:${FARBE.mute}">OPENEOS &middot; LUXCODE BY LUKAS LUKIC-SPITZNAGEL</p>
  <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${FARBE.mute}">
    <a href="https://openeos.de" style="color:${FARBE.gruen};text-decoration:underline">openeos.de</a> &nbsp;&middot;&nbsp;
    <a href="https://docs.openeos.de" style="color:${FARBE.gruen};text-decoration:underline">Handbuch</a> &nbsp;&middot;&nbsp;
    <a href="${o.appUrl}/settings" style="color:${FARBE.mute};text-decoration:underline">Benachrichtigungen</a>
  </p>
</td></tr>

</table>
${empfaengerZeile}
</td></tr>
</table>
</body>
</html>`;
}

/** Mehrere Bausteine mit passendem Abstand untereinander setzen. */
export function stapeln(...bloecke: (string | null | undefined | false)[]): string {
  return bloecke
    .filter((b): b is string => !!b)
    .join('\n<div style="height:22px;line-height:22px;font-size:0">&nbsp;</div>\n');
}
