/**
 * Mitgelieferte Vorlagen fuer den Kassenbeleg (mit TSE-Angaben), den
 * Gegenbeleg (Erstattung/Storno) und den Storno-Bon der Kueche. Gerendert wird im Drucker-Agenten (Jinja2, wie
 * `receipt` und `kitchen_ticket`). Der Agent bringt sie ab seiner naechsten
 * Version selbst mit; bis dahin liefert sie `GET /device-api/templates` aus
 * (der Agent holt die Vorlagen beim Start und speichert sie), sofern die
 * Organisation keine eigene Vorlage dieses Typs hat.
 */
export const RECEIPT_TEMPLATE = 'receipt';
export const REFUND_RECEIPT_TEMPLATE = 'refund_receipt';
export const CANCELLATION_TICKET_TEMPLATE = 'cancellation_ticket';
export const ORDER_TICKET_TEMPLATE = 'order_ticket';

/**
 * Bestellbon wie die Vorlage `order_ticket.jinja2` des Drucker-Agenten,
 * aber mit `hide_prices`: In der Betriebsart „Nur Bons“ (orders_only)
 * druckt er keine Betraege, keine Summe und keine Zahlart. Weil der Agent
 * Vorlagen vom Server vor seinen eigenen nimmt, braucht es dafuer keine
 * neue Agent-Version. Kuechen- und Abholbon des Agenten enthalten keine
 * Preise.
 */
const ORDER_TICKET_SOURCE = `{% set cols = 42 if paper_width|default(80) == 80 else 32 %}
{% set sep = "=" * cols %}
{% set line = "-" * cols %}
{% set no_prices = hide_prices|default(false) %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>*** TESTMODUS ***<</BIG>><</BOLD>><</CENTER>>

{% endif %}
<<CENTER>><<BIG>>BESTELLUNG<</BIG>><</CENTER>>
{{ sep }}
<<CENTER>><<BIG>>#{{ daily_number|default(order_number|default("---")) }}<</BIG>><</CENTER>>
{{ line }}
{% if table_number is defined and table_number %}
Tisch: {{ table_number }}
{% endif %}
{% if customer_name is defined and customer_name %}
Kunde: {{ customer_name }}
{% endif %}
Datum: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
{{ sep }}
{% for item in items|default([]) %}
{% if no_prices %}
{{ "%-3s"|format(item.quantity ~ "x") }} {{ item.name }}
{% else %}
{{ "%-3s"|format(item.quantity ~ "x") }} {{ item.name.ljust(cols - 14) }} {{ item.total|currency|rjust(10) }}
{% endif %}
{% if item.options is defined and item.options %}
{% for opt in item.options %}
     {{ opt }}
{% endfor %}
{% endif %}
{% if item.notes %}
     {{ item.notes }}
{% endif %}
{% endfor %}
{{ sep }}
{% if not no_prices %}
<<BOLD>>{{ "GESAMT:".ljust(cols - 12) }}{{ total|default(0)|currency|rjust(12) }}<</BOLD>>
{% if payment_method is defined %}
{{ line }}
Zahlungsart: {{ payment_label|default(payment_method) }}
{% endif %}
{% endif %}
<<FEED:3>>
<<CUT>>`;

/**
 * TSE-Angaben auf Kassenbeleg und Gegenbeleg (tse-swissbit-plan.md §8.6,
 * AEAO zu § 146a Nr. 2.2, DSFinV-K Anhang I): Kassen-ID (Client-ID),
 * TSE-Seriennummer und Signatur ungekuerzt (umbrochen), Transaktionsnummer,
 * Signaturzaehler, Start/Ende in UTC wie geliefert, QR-Code (V0). Ohne
 * Signatur nur „TSE ausgefallen“, bei Training der Trainingsvermerk. Ohne
 * `tse` im Auftrag druckt der Block nichts.
 *
 * Gleicher Text wie in `receipt.jinja2`/`refund_receipt.jinja2` des
 * Drucker-Agenten. Der Block ist eigenstaendig (braucht weder `cols` noch
 * `line`), damit er auch an eigene Vorlagen der Organisation gehaengt
 * werden kann ({@link withTseBlock}).
 */
export const TSE_PRINT_BLOCK = `{# TSE-Angaben nach AEAO zu § 146a Nr. 2.2 und DSFinV-K Anhang I (Vertrag:
   tse-swissbit-plan.md §8.6): Kassen-ID (Client-ID), TSE-Seriennummer und
   Signatur ungekuerzt (umbrochen), Transaktionsnummer, Signaturzaehler,
   Start/Ende in UTC wie von der TSE geliefert, QR-Code (V0). Ohne Signatur
   nur der Ausfallvermerk, bei Trainingsbuchungen der Trainingsvermerk.
   Eigenstaendig (braucht weder \`cols\` noch \`line\`), damit die API den
   Block auch an eigene Vorlagen haengen kann. #}
{% if tse is defined and tse %}
{% set tse_cols = cols if cols is defined else (42 if paper_width|default(80) == 80 else 32) %}
{{ "-" * tse_cols }}
{% if tse.failed %}
<<CENTER>><<BOLD>>TSE ausgefallen<</BOLD>><</CENTER>>
<<CENTER>>Beleg ohne Signatur<</CENTER>>
Kassen-ID: {{ tse.client_id }}
{% if tse.bon_number %}
Beleg-Nr.: {{ tse.bon_number }}
{% endif %}
{% if tse.serial_number %}
TSE-Seriennummer:
{{ tse.serial_number|wordwrap(tse_cols, true, "\\n") }}
{% endif %}
{% else %}
{% if tse.training %}
<<CENTER>><<BOLD>>TRAININGSBUCHUNG - KEIN VERKAUF<</BOLD>><</CENTER>>
{% endif %}
Kassen-ID: {{ tse.client_id }}
{% if tse.bon_number %}
Beleg-Nr.: {{ tse.bon_number }}
{% endif %}
TSE-Seriennummer:
{{ tse.serial_number|wordwrap(tse_cols, true, "\\n") }}
TSE-Transaktion: {{ tse.transaction_number }}
Signaturzaehler: {{ tse.signature_counter }}
Start: {{ tse.start_time }}
Ende:  {{ tse.finish_time }}
Algorithmus: {{ tse.signature_algorithm }}
Zeitformat: {{ tse.log_time_format }}
Signatur:
{{ tse.signature|wordwrap(tse_cols, true, "\\n") }}
{% if tse.qr_code %}
<<CENTER>><<QRCODE:{{ tse.qr_code }}>><</CENTER>>
{% endif %}
{% endif %}
{% endif %}
`;

/**
 * Kassenbeleg wie `receipt.jinja2` des Drucker-Agenten (ab 0.2.4) mit dem
 * TSE-Block. Der Server liefert ihn mit, damit auch aeltere Agenten die
 * TSE-Angaben drucken — der Agent nimmt Vorlagen vom Server vor seinen
 * eigenen.
 */
const RECEIPT_SOURCE =
  `{% set cols = 42 if paper_width|default(80) == 80 else 32 %}
{% set sep = "=" * cols %}
{% set line = "-" * cols %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>*** TESTMODUS ***<</BIG>><</BOLD>><</CENTER>>

{% endif %}
<<CENTER>><<BIG>>{{ organization.name|default("OpenEOS") }}<</BIG>><</CENTER>>
{% if organization.address is defined and organization.address %}
<<CENTER>>{{ organization.address }}<</CENTER>>
{% endif %}
{% if organization.phone is defined and organization.phone %}
<<CENTER>>Tel: {{ organization.phone }}<</CENTER>>
{% endif %}
<<CENTER>>{{ sep }}<</CENTER>>
{% if event_name is defined %}
<<CENTER>>{{ event_name }}<</CENTER>>
<<CENTER>>{{ line }}<</CENTER>>
{% endif %}
<<BOLD>>Bestellung #{{ order_number|default("---") }}<</BOLD>>
Datum: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
{% if table_number is defined and table_number %}
Tisch: {{ table_number }}
{% endif %}
{% if customer_name is defined and customer_name %}
Kunde: {{ customer_name }}
{% endif %}
{{ line }}
{% for item in items|default([]) %}
{{ "%-3s"|format(item.quantity ~ "x") }} {{ item.name.ljust(cols - 14) }} {{ item.total|currency|rjust(10) }}
{% if item.notes %}
     Hinweis: {{ item.notes }}
{% endif %}
{% endfor %}
{{ sep }}
{% if subtotal is defined %}
{{ "Zwischensumme:".ljust(cols - 12) }}{{ subtotal|currency|rjust(12) }}
{% endif %}
{# Preise sind brutto: ausgewiesen wird die enthaltene MwSt, je Satz eine
   Zeile. Bei gemischten Saetzen schickt die API keinen \`tax_rate\` — die alte
   Einzelzeile haette dann pauschal "19%" neben die Gesamtsumme geschrieben. #}
{% if tax_lines is defined and tax_lines %}
{% for tl in tax_lines %}
{{ ("enth. MwSt " ~ (tl.rate|int if tl.rate == tl.rate|int else tl.rate) ~ "%:").ljust(cols - 12) }}{{ tl.tax|currency|rjust(12) }}
{% endfor %}
{% elif tax_amount is defined %}
{{ ("enth. MwSt " ~ tax_rate|default("19") ~ "%:").ljust(cols - 12) }}{{ tax_amount|currency|rjust(12) }}
{% endif %}
<<BOLD>>{{ "GESAMT:".ljust(cols - 12) }}{{ total|default(0)|currency|rjust(12) }}<</BOLD>>
{{ line }}
{% if payment_method is defined %}
Zahlungsart: {{ payment_label|default(payment_method) }}
{% if paid_amount is defined %}
Bezahlt: {{ paid_amount|currency }}
{% endif %}
{% if change is defined and change > 0 %}
Rueckgeld: {{ change|currency }}
{% endif %}
{% endif %}
` +
  TSE_PRINT_BLOCK +
  `{{ line }}
{% if qr_url is defined %}
<<CENTER>><<QRCODE:{{ qr_url }}>><</CENTER>>
{% endif %}
<<CENTER>>Vielen Dank fuer Ihren Einkauf!<</CENTER>>
<<CENTER>>{{ created_at|strftime("%d.%m.%Y %H:%M") }}<</CENTER>>
<<FEED:3>>
<<CUT>>
`;

/** Gegenbeleg wie `refund_receipt.jinja2` des Drucker-Agenten, mit TSE-Block. */
const REFUND_RECEIPT_SOURCE =
  `{% set cols = 42 if paper_width|default(80) == 80 else 32 %}
{% set sep = "=" * cols %}
{% set line = "-" * cols %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>*** TESTMODUS ***<</BIG>><</BOLD>><</CENTER>>

{% endif %}
<<CENTER>><<BIG>>{{ organization.name|default("OpenEOS") }}<</BIG>><</CENTER>>
{% if organization.address is defined and organization.address %}
<<CENTER>>{{ organization.address }}<</CENTER>>
{% endif %}
{% if organization.phone is defined and organization.phone %}
<<CENTER>>Tel: {{ organization.phone }}<</CENTER>>
{% endif %}
<<CENTER>>{{ sep }}<</CENTER>>
<<CENTER>><<BOLD>><<BIG>>{{ "STORNO" if refund_kind|default("refund") == "cancellation" else "ERSTATTUNG" }}<</BIG>><</BOLD>><</CENTER>>
<<CENTER>>Gegenbeleg<</CENTER>>
{% if reprint %}
<<CENTER>><<BOLD>>-- NACHDRUCK --<</BOLD>><</CENTER>>
{% endif %}
{{ line }}
<<BOLD>>Beleg {{ refund_number|default("---") }}<</BOLD>>
Datum: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
Zu Bestellung #{{ order_number|default("---") }}{% if daily_number is defined and daily_number %} (Nr. {{ daily_number }}){% endif %}

{% if original_created_at is defined and original_created_at %}
vom {{ original_created_at|strftime("%d.%m.%Y %H:%M") }}
{% endif %}
{% if table_number is defined and table_number %}
Tisch: {{ table_number }}
{% endif %}
{{ line }}
{% for item in items|default([]) %}
{{ "%-4s"|format("-" ~ item.quantity ~ "x") }}{{ item.name.ljust(cols - 15)[:cols - 15] }} {{ item.total|currency|rjust(10) }}
{% endfor %}
{% if pfand_amount is defined and pfand_amount %}
{{ "Pfand:".ljust(cols - 12) }}{{ pfand_amount|currency|rjust(12) }}
{% endif %}
{% if tip_amount is defined and tip_amount %}
{{ "Trinkgeld:".ljust(cols - 12) }}{{ tip_amount|currency|rjust(12) }}
{% endif %}
{{ sep }}
{% if tax_lines is defined and tax_lines %}
{% for tl in tax_lines %}
{{ ("enth. MwSt " ~ (tl.rate|int if tl.rate == tl.rate|int else tl.rate) ~ "%:").ljust(cols - 12) }}{{ tl.tax|currency|rjust(12) }}
{% endfor %}
{% endif %}
<<BOLD>>{{ "ERSTATTET:".ljust(cols - 12) }}{{ total|default(0)|currency|rjust(12) }}<</BOLD>>
{{ line }}
Rueckgabe: {{ payment_label|default(payment_method) }}
{% if refund_status is defined and refund_status == "manual" %}
(manuell erstattet)
{% endif %}
{% if provider_reference is defined and provider_reference %}
Transaktion: {{ provider_reference }}
{% endif %}
{% if reason is defined and reason %}
Grund: {{ reason }}
{% endif %}
{% if actor_name is defined and actor_name %}
Bediener: {{ actor_name }}
{% endif %}
{% if device_name is defined and device_name %}
Kasse: {{ device_name }}
{% endif %}
` +
  TSE_PRINT_BLOCK +
  `{{ line }}
<<CENTER>>Betrag erhalten:<</CENTER>>


<<CENTER>>________________________<</CENTER>>
<<CENTER>>Unterschrift<</CENTER>>
<<FEED:3>>
<<CUT>>
`;

/** Vorlagen, auf denen die TSE-Angaben stehen muessen. */
export const TSE_RECEIPT_TEMPLATES: readonly string[] = [
  RECEIPT_TEMPLATE,
  REFUND_RECEIPT_TEMPLATE,
];

/** Leerzeilen, Vorschub und Schnitt am Ende einer Vorlage. */
const TRAILING_CONTROL =
  /^(?:|<<(?:FEED(?::\d+)?|CUT)>>|\{\{(?:FEED(?::\d+)?|CUT)\}\})$/;

/**
 * Eigene Bon-Vorlage der Organisation (Designer) um den TSE-Block
 * ergaenzen, falls sie ihn nicht selbst enthaelt: Die TSE-Angaben sind bei
 * aktiver TSE Pflicht und nicht abwaehlbar. Eingefuegt wird vor Vorschub
 * und Schnitt am Ende, sonst ganz am Ende.
 */
export function withTseBlock(source: string): string {
  if (source.includes('tse.client_id')) return source;
  const lines = source.split('\n');
  let insertAt = lines.length;
  while (insertAt > 0 && TRAILING_CONTROL.test(lines[insertAt - 1].trim())) {
    insertAt--;
  }
  const head = lines.slice(0, insertAt).join('\n');
  const tail = lines.slice(insertAt).join('\n');
  return `${head}${head ? '\n' : ''}${TSE_PRINT_BLOCK}${tail}`;
}

/** `{{ payment_method }}` als reine Ausgabe (nicht in Bedingungen). */
const RAW_PAYMENT_METHOD = /\{\{\s*payment_method\s*\}\}/g;

/**
 * Eigene Vorlagen (Designer) druckten die Zahlart als Rohwert („cash“).
 * Die API schickt dazu `payment_label` („Bar“, „Karte (SumUp)“ …); die
 * Ausgabe nimmt ihn, wo vorhanden. Bedingungen auf `payment_method`
 * bleiben unberuehrt.
 */
export function withPaymentLabel(source: string): string {
  return source.replace(
    RAW_PAYMENT_METHOD,
    '{{ payment_label|default(payment_method) }}',
  );
}

export const BUILTIN_PRINT_TEMPLATES: Record<string, string> = {
  [ORDER_TICKET_TEMPLATE]: ORDER_TICKET_SOURCE,
  [REFUND_RECEIPT_TEMPLATE]: REFUND_RECEIPT_SOURCE,
  [RECEIPT_TEMPLATE]: RECEIPT_SOURCE,
  [CANCELLATION_TICKET_TEMPLATE]: `{% set cols = 42 if paper_width|default(80) == 80 else 32 %}
{% set sep = "=" * cols %}
{% set box = "#" * cols %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>*** TESTMODUS ***<</BIG>><</BOLD>><</CENTER>>

{% endif %}
{{ box }}
<<CENTER>><<BOLD>><<BIG>>STORNO<</BIG>><</BOLD>><</CENTER>>
<<CENTER>>Nicht zubereiten<</CENTER>>
{{ box }}

<<CENTER>><<BIG>>#{{ daily_number|default(order_number|default("---")) }}<</BIG>><</CENTER>>
{% if table_number is defined and table_number %}
<<CENTER>><<BOLD>>TISCH {{ table_number }}<</BOLD>><</CENTER>>
{% endif %}
{% if station_name is defined and station_name %}
<<CENTER>>Station: {{ station_name }}<</CENTER>>
{% endif %}
{{ sep }}
<<LEFT>>
{% for item in items|default([]) %}
<<BOLD>><<BIG>>-{{ item.quantity }}x {{ item.name }}<</BIG>><</BOLD>>
{% if item.options is defined and item.options %}
{% for opt in item.options %}
    {{ opt }}
{% endfor %}
{% endif %}

{% endfor %}
{{ sep }}
{% if reason is defined and reason %}
Grund: {{ reason }}
{% endif %}
{% if created_at is defined and created_at %}
Storniert: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
{% endif %}
<<FEED:3>>
<<CUT>>
`,
};
