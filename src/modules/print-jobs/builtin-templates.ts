/**
 * Mitgelieferte Vorlagen fuer den Kassenbeleg (mit TSE-Angaben), den
 * Gegenbeleg (Erstattung/Storno) und den Storno-Bon der Kueche. Gerendert wird im Drucker-Agenten (Jinja2, wie
 * `receipt` und `kitchen_ticket`). Der Agent bringt sie ab seiner naechsten
 * Version selbst mit; bis dahin liefert sie `GET /device-api/templates` aus
 * (der Agent holt die Vorlagen beim Start und speichert sie), sofern die
 * Organisation keine eigene Vorlage dieses Typs hat.
 *
 * Die Vorlagen sind Byte fuer Byte gleich den gleichnamigen
 * `src/templates/*.jinja2` des Agenten. Die Zeilenbreite `cols` kommt aus
 * `columns` (Zeichen pro Zeile des Druckers, vom Agenten gesetzt) oder aus
 * `paper_width` (80 mm = 42, 58 mm = 32); keine Zeile wird breiter.
 */
export const RECEIPT_TEMPLATE = 'receipt';
export const REFUND_RECEIPT_TEMPLATE = 'refund_receipt';
export const CANCELLATION_TICKET_TEMPLATE = 'cancellation_ticket';
export const ORDER_TICKET_TEMPLATE = 'order_ticket';
/** Beleg einer Pfand-Auszahlung („Pfandrückgabe“, openeos-web#116). */
export const PFAND_RETURN_RECEIPT_TEMPLATE = 'pfand_return_receipt';
/** Kellnerabrechnung bzw. Zwischenstand (bedienungen-plan.md §9). */
export const WAITER_SETTLEMENT_TEMPLATE = 'waiter_settlement';
/** Bewirtungsbeleg (openeos-web#9). */
export const HOSPITALITY_RECEIPT_TEMPLATE = 'hospitality_receipt';
/** Verkauf bzw. Ruecktausch von Wertmarken. */
export const TOKEN_RECEIPT_TEMPLATE = 'token_receipt';

/**
 * Bewirtungsbeleg: Die API schickt den fertigen Aufbau als `blocks`
 * (dieselben Bausteine wie Beleg-Seite, PDF und Mail, Text ohne Umlaute);
 * die Vorlage setzt ihn auf die Zeilenbreite. Nur vom Server ausgeliefert.
 */
const HOSPITALITY_RECEIPT_SOURCE = `{# Zeichen pro Zeile: \`columns\` des Druckers, sonst 42 (80 mm) bzw. 32 (58 mm).
   Keine Zeile darf breiter sein, BIG zaehlt doppelt. #}
{% set cols = columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}
{% for b in blocks|default([]) %}
{% if b.type == "banner" %}
<<CENTER>><<BOLD>>{{ ("** " ~ b.text ~ " **")|wordwrap(cols, true, "\\n") }}<</BOLD>><</CENTER>>
{% elif b.type == "heading" %}
<<CENTER>><<BOLD>><<BIG>>{{ b.text|wordwrap(cols // 2, true, "\\n") }}<</BIG>><</BOLD>><</CENTER>>
{% elif b.type == "title" %}
<<CENTER>><<BOLD>>{{ b.text|wordwrap(cols, true, "\\n") }}<</BOLD>><</CENTER>>
{% elif b.type == "center" %}
<<CENTER>>{{ b.text|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% elif b.type == "text" and b.bold %}
<<BOLD>>{{ b.text|wordwrap(cols, true, "\\n") }}<</BOLD>>
{% elif b.type == "text" or b.type == "note" %}
{{ b.text|wordwrap(cols, true, "\\n") }}
{% elif b.type == "row" %}
{% set label = b.label ~ ":" %}
{% if label|length + b.value|length + 1 <= cols %}
{% if b.bold %}
<<BOLD>>{{ label }}{{ b.value|rjust(cols - label|length) }}<</BOLD>>
{% else %}
{{ label }}{{ b.value|rjust(cols - label|length) }}
{% endif %}
{% else %}
{{ label|wordwrap(cols, true, "\\n") }}
{% if b.value|length <= cols %}
{{ b.value|rjust(cols) }}
{% else %}
{{ b.value|wordwrap(cols, true, "\\n") }}
{% endif %}
{% endif %}
{% elif b.type == "item" %}
{% set qty = "%-3s"|format(b.qty) %}
{% set name_width = cols - qty|length - b.amount|length - 2 %}
{% set name_lines = (b.name|wordwrap(name_width, true, "\\n")).split("\\n") %}
{{ qty }} {{ name_lines[0].ljust(name_width) }} {{ b.amount }}
{% for rest in name_lines[1:] %}
{{ " " * (qty|length + 1) }}{{ rest }}
{% endfor %}
{% elif b.type == "rule" %}
{{ ("=" if b.double else "-") * cols }}
{% elif b.type == "mono" %}
{% if b.label %}
{{ (b.label ~ ":")|wordwrap(cols, true, "\\n") }}
{% endif %}
{{ b.text|wordwrap(cols, true, "\\n") }}
{% elif b.type == "qr" %}
<<CENTER>><<QRCODE:{{ b.value }}>><</CENTER>>
{% elif b.type == "fill" %}

{{ (b.label ~ ":")|wordwrap(cols, true, "\\n") }}
{% for n in range(b.lines) %}

{{ "_" * cols }}
{% endfor %}
{% endif %}
{% endfor %}
<<FEED:3>>
<<CUT>>
`;

/**
 * Bestellbon wie die Vorlage `order_ticket.jinja2` des Drucker-Agenten,
 * mit `hide_prices`: In der Betriebsart „Nur Bons“ (orders_only) druckt er
 * keine Betraege, keine Summe und keine Zahlart. Weil der Agent Vorlagen
 * vom Server vor seinen eigenen nimmt, gilt das auch fuer aeltere Agenten.
 * Kuechen- und Abholbon des Agenten enthalten keine Preise.
 */
const ORDER_TICKET_SOURCE = `{# Zeichen pro Zeile: \`columns\` des Druckers, sonst 42 (80 mm) bzw. 32 (58 mm).
   Keine Zeile darf breiter sein, BIG zaehlt doppelt. #}
{% set cols = columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}
{% set sep = "=" * cols %}
{% set line = "-" * cols %}
{% macro row(label, value) %}{{ label }}{{ value|rjust(cols - label|length) }}{% endmacro %}
{% set no_prices = hide_prices|default(false) %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>** TESTMODUS **<</BIG>><</BOLD>><</CENTER>>

{% endif %}
<<CENTER>><<BIG>>BESTELLUNG<</BIG>><</CENTER>>
{{ sep }}
<<CENTER>><<BIG>>#{{ daily_number|default(order_number|default("---")) }}<</BIG>><</CENTER>>
{{ line }}
{% if table_number is defined and table_number %}
{{ ("Tisch: " ~ table_number)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if customer_name is defined and customer_name %}
{{ ("Kunde: " ~ customer_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
Datum: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
{{ sep }}
{% for item in items|default([]) %}
{% set qty = "%-3s"|format(item.quantity ~ "x") %}
{% set amount = "" if no_prices else item.total|currency %}
{% set name_width = cols - qty|length - amount|length - (1 if no_prices else 2) %}
{% set name_lines = (item.name|wordwrap(name_width, true, "\\n")).split("\\n") %}
{% if no_prices %}
{{ qty }} {{ name_lines[0] }}
{% else %}
{{ qty }} {{ name_lines[0].ljust(name_width) }} {{ amount }}
{% endif %}
{% for rest in name_lines[1:] %}
{{ " " * (qty|length + 1) }}{{ rest }}
{% endfor %}
{% if item.options is defined and item.options %}
{% for opt in item.options %}
     {{ opt|wordwrap(cols - 5, true, "\\n     ") }}
{% endfor %}
{% endif %}
{% if item.notes %}
     {{ item.notes|wordwrap(cols - 5, true, "\\n     ") }}
{% endif %}
{% endfor %}
{{ sep }}
{% if not no_prices %}
<<BOLD>>{{ row("GESAMT:", total|default(0)|currency) }}<</BOLD>>
{% if payment_method is defined %}
{{ line }}
{{ ("Zahlungsart: " ~ payment_label|default(payment_method))|wordwrap(cols, true, "\\n") }}
{% endif %}
{% endif %}
<<FEED:3>>
<<CUT>>
`;

/**
 * TSE-Angaben auf Kassenbeleg und Gegenbeleg (tse-swissbit-plan.md §8.6,
 * AEAO zu § 146a Nr. 2.2, DSFinV-K Anhang I): Kassen-ID (Client-ID),
 * Beleg-Nr., TSE-Seriennummer und Signatur ungekuerzt (umbrochen), Transaktionsnummer,
 * Signaturzaehler, Start/Ende in UTC wie geliefert, QR-Code (V0), bei
 * Bestellungen vorher der Bestellbeginn (DSFinV-K Tz. 2.7.3). Ohne
 * Signatur nur „TSE nicht erreichbar – Beleg ohne Signatur“ (Ausfallbeleg);
 * kam die Signatur erst nach der Ausgabe, nennt sie nur ein Nachdruck,
 * gekennzeichnet „Signatur nach Belegausgabe“ und ohne QR-Code. Bei
 * Training der Trainingsvermerk. Ohne `tse` im Auftrag druckt der Block
 * nichts.
 *
 * Gleicher Text wie in `receipt.jinja2`/`refund_receipt.jinja2` des
 * Drucker-Agenten. Der Block ist eigenstaendig (braucht weder `cols` noch
 * `line`), damit er auch an eigene Vorlagen der Organisation gehaengt
 * werden kann ({@link withTseBlock}).
 */
export const TSE_PRINT_BLOCK = `{# TSE-Angaben nach AEAO zu § 146a Nr. 2.2 und DSFinV-K Anhang I (Vertrag:
   tse-swissbit-plan.md §8.6): Kassen-ID (Client-ID), Beleg-Nr.,
   TSE-Seriennummer und Signatur ungekuerzt (umbrochen), Transaktionsnummer,
   Signaturzaehler, Start/Ende in UTC wie von der TSE geliefert, QR-Code
   (V0). Ohne Signatur nur der Ausfallvermerk, bei Trainingsbuchungen der
   Trainingsvermerk. Eigenstaendig (braucht weder \`cols\` noch \`line\`), damit
   die API den Block auch an eigene Vorlagen haengen kann. #}
{% if tse is defined and tse %}
{% set tse_cols = cols if cols is defined else columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}
{{ "-" * tse_cols }}
{% if tse.failed %}
<<CENTER>><<BOLD>>TSE nicht erreichbar<</BOLD>><</CENTER>>
<<CENTER>>Beleg ohne Signatur<</CENTER>>
{{ ("Kassen-ID: " ~ tse.client_id)|wordwrap(tse_cols, true, "\\n") }}
{% if tse.bon_number %}
{{ ("Beleg-Nr.: " ~ tse.bon_number)|wordwrap(tse_cols, true, "\\n") }}
{% endif %}
{% if tse.order_start_time is defined and tse.order_start_time %}
{{ ("Bestellbeginn: " ~ tse.order_start_time)|wordwrap(tse_cols, true, "\\n") }}
{% endif %}
{% if tse.serial_number %}
TSE-Seriennummer:
{{ tse.serial_number|wordwrap(tse_cols, true, "\\n") }}
{% endif %}
{% if tse.late_signature is defined and tse.late_signature %}
{{ ("Signatur nach Belegausgabe:")|wordwrap(tse_cols, true, "\\n") }}
{{ ("TSE-Transaktion: " ~ tse.late_signature.transaction_number)|wordwrap(tse_cols, true, "\\n") }}
{{ ("Signaturzaehler: " ~ tse.late_signature.signature_counter)|wordwrap(tse_cols, true, "\\n") }}
{{ ("Ende:  " ~ tse.late_signature.finish_time)|wordwrap(tse_cols, true, "\\n") }}
{% endif %}
{% else %}
{% if tse.training %}
<<CENTER>><<BOLD>>TRAININGSBUCHUNG - KEIN VERKAUF<</BOLD>><</CENTER>>
{% endif %}
{{ ("Kassen-ID: " ~ tse.client_id)|wordwrap(tse_cols, true, "\\n") }}
{% if tse.bon_number %}
{{ ("Beleg-Nr.: " ~ tse.bon_number)|wordwrap(tse_cols, true, "\\n") }}
{% endif %}
TSE-Seriennummer:
{{ tse.serial_number|wordwrap(tse_cols, true, "\\n") }}
{{ ("TSE-Transaktion: " ~ tse.transaction_number)|wordwrap(tse_cols, true, "\\n") }}
{{ ("Signaturzaehler: " ~ tse.signature_counter)|wordwrap(tse_cols, true, "\\n") }}
{% if tse.order_start_time is defined and tse.order_start_time %}
{{ ("Bestellbeginn: " ~ tse.order_start_time)|wordwrap(tse_cols, true, "\\n") }}
{% endif %}
{{ ("Start: " ~ tse.start_time)|wordwrap(tse_cols, true, "\\n") }}
{{ ("Ende:  " ~ tse.finish_time)|wordwrap(tse_cols, true, "\\n") }}
{{ ("Algorithmus: " ~ tse.signature_algorithm)|wordwrap(tse_cols, true, "\\n") }}
{{ ("Zeitformat: " ~ tse.log_time_format)|wordwrap(tse_cols, true, "\\n") }}
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
  `{# Zeichen pro Zeile: \`columns\` des Druckers, sonst 42 (80 mm) bzw. 32 (58 mm).
   Keine Zeile darf breiter sein, BIG zaehlt doppelt. #}
{% set cols = columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}
{% set sep = "=" * cols %}
{% set line = "-" * cols %}
{% macro row(label, value) %}{{ label }}{{ value|rjust(cols - label|length) }}{% endmacro %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>** TESTMODUS **<</BIG>><</BOLD>><</CENTER>>

{% endif %}
{% if reprint is defined and reprint %}
<<CENTER>><<BOLD>>-- NACHDRUCK --<</BOLD>><</CENTER>>
{% endif %}
<<CENTER>><<BIG>>{{ organization.name|default("OpenEOS")|wordwrap(cols // 2, true, "\\n") }}<</BIG>><</CENTER>>
{% if organization.address is defined and organization.address %}
<<CENTER>>{{ organization.address|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% endif %}
{% if organization.phone is defined and organization.phone %}
<<CENTER>>{{ ("Tel: " ~ organization.phone)|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% endif %}
<<CENTER>>{{ sep }}<</CENTER>>
{% if event_name is defined %}
<<CENTER>>{{ event_name|wordwrap(cols, true, "\\n") }}<</CENTER>>
<<CENTER>>{{ line }}<</CENTER>>
{% endif %}
<<BOLD>>{{ ("Bestellung #" ~ order_number|default("---"))|wordwrap(cols, true, "\\n") }}<</BOLD>>
Datum: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
{% if table_number is defined and table_number %}
{{ ("Tisch: " ~ table_number)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if customer_name is defined and customer_name %}
{{ ("Kunde: " ~ customer_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
{{ line }}
{# Betrag rechtsbuendig am Zeilenende, der Name nimmt den Rest und bricht
   in Folgezeilen um statt den Betrag zu verschieben. #}
{% for item in items|default([]) %}
{% set qty = "%-3s"|format(item.quantity ~ "x") %}
{% set amount = item.total|currency %}
{% set name_width = cols - qty|length - amount|length - 2 %}
{% set name_lines = (item.name|wordwrap(name_width, true, "\\n")).split("\\n") %}
{{ qty }} {{ name_lines[0].ljust(name_width) }} {{ amount }}
{% for rest in name_lines[1:] %}
{{ " " * (qty|length + 1) }}{{ rest }}
{% endfor %}
{% if item.notes %}
     {{ ("Hinweis: " ~ item.notes)|wordwrap(cols - 5, true, "\\n     ") }}
{% endif %}
{% endfor %}
{{ sep }}
{% if subtotal is defined %}
{{ row("Zwischensumme:", subtotal|currency) }}
{% endif %}
{% if discount_amount is defined and discount_amount and discount_amount|float > 0 %}
{{ row("Rabatt:", (0 - discount_amount|float)|currency) }}
{% endif %}
{# Pfand gehoert zum Entgelt und steckt in GESAMT und in der MwSt. #}
{% if pfand_total is defined and pfand_total and pfand_total|float > 0 %}
{{ row("Pfand:", pfand_total|float|currency) }}
{% endif %}
{# Servicegebuehr (Shop): eigene Leistung mit eigenem Satz, steckt in GESAMT. #}
{% if service_fee is defined and service_fee and service_fee|float > 0 %}
{{ row("Servicegebuehr:", service_fee|float|currency) }}
{% endif %}
{# Trinkgeld steckt in GESAMT; an den Verein ist es Entgelt und in der MwSt. #}
{% if tip_amount is defined and tip_amount and tip_amount|float > 0 %}
{{ row("Trinkgeld:", tip_amount|float|currency) }}
{% endif %}
{# Preise sind brutto: ausgewiesen wird die enthaltene MwSt, je Satz eine
   Zeile. Bei gemischten Saetzen schickt die API keinen \`tax_rate\` — die alte
   Einzelzeile haette dann pauschal "19%" neben die Gesamtsumme geschrieben. #}
{% if tax_lines is defined and tax_lines %}
{% for tl in tax_lines %}
{{ row("enth. MwSt " ~ (tl.rate|int if tl.rate == tl.rate|int else tl.rate) ~ "%:", tl.tax|currency) }}
{% endfor %}
{% elif tax_amount is defined %}
{{ row("enth. MwSt " ~ tax_rate|default("19") ~ "%:", tax_amount|currency) }}
{% endif %}
{% if vat_exempt_notice is defined and vat_exempt_notice %}
{{ vat_exempt_notice|replace("§", "Par.")|wordwrap(cols, true, "\\n") }}
{% endif %}
<<BOLD>>{{ row("GESAMT:", total|default(0)|currency) }}<</BOLD>>
{{ line }}
{# Wertmarken (Mehrzweck-/Einzweckgutschein): mit Marken bezahlter Teil,
   Wechselgeld in Marken gibt es nicht. #}
{% if tokens is defined and tokens %}
Bezahlt mit Wertmarken:
{% for t in tokens %}
{% set qty = "%-3s"|format(t.count_label|default(t.count) ~ "x") %}
{% set amount = t.amount|currency %}
{% set name_width = cols - qty|length - amount|length - 2 %}
{% set name_lines = ((t.name ~ " je " ~ t.unit_value|default(0)|currency)|wordwrap(name_width, true, "\\n")).split("\\n") %}
{{ qty }} {{ name_lines[0].ljust(name_width) }} {{ amount }}
{% for rest in name_lines[1:] %}
{{ " " * (qty|length + 1) }}{{ rest }}
{% endfor %}
{% endfor %}
{% if token_note is defined and token_note %}
{{ token_note|replace("§", "Par.")|wordwrap(cols, true, "\\n") }}
{% endif %}
{% endif %}
{% if payment_method is defined %}
{{ ("Zahlungsart: " ~ payment_label|default(payment_method))|wordwrap(cols, true, "\\n") }}
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
  `{# Zeichen pro Zeile: \`columns\` des Druckers, sonst 42 (80 mm) bzw. 32 (58 mm).
   Keine Zeile darf breiter sein, BIG zaehlt doppelt. #}
{% set cols = columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}
{% set sep = "=" * cols %}
{% set line = "-" * cols %}
{% macro row(label, value) %}{{ label }}{{ value|rjust(cols - label|length) }}{% endmacro %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>** TESTMODUS **<</BIG>><</BOLD>><</CENTER>>

{% endif %}
<<CENTER>><<BIG>>{{ organization.name|default("OpenEOS")|wordwrap(cols // 2, true, "\\n") }}<</BIG>><</CENTER>>
{% if organization.address is defined and organization.address %}
<<CENTER>>{{ organization.address|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% endif %}
{% if organization.phone is defined and organization.phone %}
<<CENTER>>{{ ("Tel: " ~ organization.phone)|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% endif %}
<<CENTER>>{{ sep }}<</CENTER>>
<<CENTER>><<BOLD>><<BIG>>{{ "STORNO" if refund_kind|default("refund") == "cancellation" else "ERSTATTUNG" }}<</BIG>><</BOLD>><</CENTER>>
<<CENTER>>Gegenbeleg<</CENTER>>
{% if reprint %}
<<CENTER>><<BOLD>>-- NACHDRUCK --<</BOLD>><</CENTER>>
{% endif %}
{{ line }}
<<BOLD>>{{ ("Beleg " ~ refund_number|default("---"))|wordwrap(cols, true, "\\n") }}<</BOLD>>
Datum: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
{{ ("Zu Bestellung #" ~ order_number|default("---") ~ ((" (Nr. " ~ daily_number ~ ")") if daily_number is defined and daily_number else ""))|wordwrap(cols, true, "\\n") }}
{% if original_created_at is defined and original_created_at %}
vom {{ original_created_at|strftime("%d.%m.%Y %H:%M") }}
{% endif %}
{% if table_number is defined and table_number %}
{{ ("Tisch: " ~ table_number)|wordwrap(cols, true, "\\n") }}
{% endif %}
{{ line }}
{# Wie auf dem Kassenbeleg: Betrag rechtsbuendig, der Name bricht um. #}
{% for item in items|default([]) %}
{% set qty = "%-3s"|format("-" ~ item.quantity ~ "x") %}
{% set amount = item.total|currency %}
{% set name_width = cols - qty|length - amount|length - 2 %}
{% set name_lines = (item.name|wordwrap(name_width, true, "\\n")).split("\\n") %}
{{ qty }} {{ name_lines[0].ljust(name_width) }} {{ amount }}
{% for rest in name_lines[1:] %}
{{ " " * (qty|length + 1) }}{{ rest }}
{% endfor %}
{% endfor %}
{% if pfand_amount is defined and pfand_amount %}
{{ row("Pfand:", pfand_amount|currency) }}
{% endif %}
{% if tip_amount is defined and tip_amount %}
{{ row("Trinkgeld:", tip_amount|currency) }}
{% endif %}
{{ sep }}
{% if tax_lines is defined and tax_lines %}
{% for tl in tax_lines %}
{{ row("enth. MwSt " ~ (tl.rate|int if tl.rate == tl.rate|int else tl.rate) ~ "%:", tl.tax|currency) }}
{% endfor %}
{% endif %}
{% if vat_exempt_notice is defined and vat_exempt_notice %}
{{ vat_exempt_notice|replace("§", "Par.")|wordwrap(cols, true, "\\n") }}
{% endif %}
<<BOLD>>{{ row("ERSTATTET:", total|default(0)|currency) }}<</BOLD>>
{{ line }}
{{ ("Rueckgabe: " ~ payment_label|default(payment_method))|wordwrap(cols, true, "\\n") }}
{% if refund_status is defined and refund_status == "manual" %}
(manuell erstattet)
{% endif %}
{% if provider_reference is defined and provider_reference %}
{{ ("Transaktion: " ~ provider_reference)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if reason is defined and reason %}
{{ ("Grund: " ~ reason)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if actor_name is defined and actor_name %}
{{ ("Bediener: " ~ actor_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if device_name is defined and device_name %}
{{ ("Kasse: " ~ device_name)|wordwrap(cols, true, "\\n") }}
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

/**
 * Beleg einer Pfand-Auszahlung: negative Betraege je Pfandart, MwSt je
 * Satz (Rueckgabe mindert das Entgelt, § 17 UStG; fehlt bei
 * steuerbefreiten Organisationen), Zahlart Bar, Kasse/Bediener, Datum,
 * Belegnummer und — mit Cloud-TSE — der TSE-Block. Nur vom Server
 * ausgeliefert (der Agent kennt die Vorlage nicht selbst).
 */
const PFAND_RETURN_RECEIPT_SOURCE =
  `{# Zeichen pro Zeile: \`columns\` des Druckers, sonst 42 (80 mm) bzw. 32 (58 mm).
   Keine Zeile darf breiter sein, BIG zaehlt doppelt. #}
{% set cols = columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}
{% set sep = "=" * cols %}
{% set line = "-" * cols %}
{% macro row(label, value) %}{{ label }}{{ value|rjust(cols - label|length) }}{% endmacro %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>** TESTMODUS **<</BIG>><</BOLD>><</CENTER>>

{% endif %}
<<CENTER>><<BIG>>{{ organization.name|default("OpenEOS")|wordwrap(cols // 2, true, "\\n") }}<</BIG>><</CENTER>>
{% if organization.address is defined and organization.address %}
<<CENTER>>{{ organization.address|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% endif %}
{% if organization.phone is defined and organization.phone %}
<<CENTER>>{{ ("Tel: " ~ organization.phone)|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% endif %}
<<CENTER>>{{ sep }}<</CENTER>>
<<CENTER>><<BOLD>><<BIG>>PFAND<</BIG>><</BOLD>><</CENTER>>
<<CENTER>><<BOLD>>Rueckgabe / Auszahlung<</BOLD>><</CENTER>>
{% if reprint %}
<<CENTER>><<BOLD>>-- NACHDRUCK --<</BOLD>><</CENTER>>
{% endif %}
{{ line }}
<<BOLD>>{{ ("Beleg " ~ return_number|default("---", true))|wordwrap(cols, true, "\\n") }}<</BOLD>>
Datum: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
{{ line }}
{% for item in items|default([]) %}
{% set qty = "%-4s"|format("-" ~ item.quantity ~ "x") %}
{% set amount = item.total|currency %}
{% set name_width = cols - qty|length - amount|length - 2 %}
{% set name_lines = (item.name|wordwrap(name_width, true, "\\n")).split("\\n") %}
{{ qty }} {{ name_lines[0].ljust(name_width) }} {{ amount }}
{% for rest in name_lines[1:] %}
{{ " " * (qty|length + 1) }}{{ rest }}
{% endfor %}
{{ " " * (qty|length + 1) }}{{ ("je " ~ item.unit_amount|currency)|wordwrap(cols - qty|length - 1, true, "\\n") }}
{% endfor %}
{{ sep }}
{% if tax_lines is defined and tax_lines %}
{% for tl in tax_lines %}
{{ row("enth. MwSt " ~ (tl.rate|int if tl.rate == tl.rate|int else tl.rate) ~ "%:", tl.tax|currency) }}
{% endfor %}
{% endif %}
{% if vat_exempt_notice is defined and vat_exempt_notice %}
{{ vat_exempt_notice|replace("§", "Par.")|wordwrap(cols, true, "\\n") }}
{% endif %}
<<BOLD>>{{ row("AUSGEZAHLT:", total|default(0)|currency) }}<</BOLD>>
{{ line }}
{{ ("Zahlungsart: " ~ payment_label|default("Bar"))|wordwrap(cols, true, "\\n") }}
{% if actor_name is defined and actor_name %}
{{ ("Bediener: " ~ actor_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if device_name is defined and device_name %}
{{ ("Kasse: " ~ device_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if event_name is defined and event_name %}
{{ ("Veranstaltung: " ~ event_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
` +
  TSE_PRINT_BLOCK +
  `{{ line }}
<<CENTER>>Danke fuers Zurueckbringen!<</CENTER>>
<<CENTER>>{{ created_at|strftime("%d.%m.%Y %H:%M") }}<</CENTER>>
<<FEED:3>>
<<CUT>>
`;

/**
 * Beleg eines Verkaufs bzw. Ruecktauschs von Wertmarken: Marken je Typ mit
 * Art (Mehrzweck-Gutschein nicht steuerbar, Einzweck-Gutschein mit Satz),
 * MwSt nur fuer Einzweckgutscheine, Zahlart, Rueckgeld, Kasse/Bediener,
 * TSE-Block; Ruecktausch mit Grund und Unterschriftszeile. Nur vom Server
 * ausgeliefert (der Agent kennt die Vorlage nicht selbst).
 */
const TOKEN_RECEIPT_SOURCE =
  `{# Zeichen pro Zeile: \`columns\` des Druckers, sonst 42 (80 mm) bzw. 32 (58 mm).
   Keine Zeile darf breiter sein, BIG zaehlt doppelt. #}
{% set cols = columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}
{% set sep = "=" * cols %}
{% set line = "-" * cols %}
{% macro row(label, value) %}{{ label }}{{ value|rjust(cols - label|length) }}{% endmacro %}
{% set buyback = token_kind|default("sale") == "buyback" %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>** TESTMODUS **<</BIG>><</BOLD>><</CENTER>>

{% endif %}
<<CENTER>><<BIG>>{{ organization.name|default("OpenEOS")|wordwrap(cols // 2, true, "\\n") }}<</BIG>><</CENTER>>
{% if organization.address is defined and organization.address %}
<<CENTER>>{{ organization.address|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% endif %}
{% if organization.phone is defined and organization.phone %}
<<CENTER>>{{ ("Tel: " ~ organization.phone)|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% endif %}
<<CENTER>>{{ sep }}<</CENTER>>
<<CENTER>><<BOLD>><<BIG>>WERTMARKEN<</BIG>><</BOLD>><</CENTER>>
<<CENTER>><<BOLD>>{{ "Ruecktausch / Auszahlung" if buyback else "Verkauf" }}<</BOLD>><</CENTER>>
{% if reprint %}
<<CENTER>><<BOLD>>-- NACHDRUCK --<</BOLD>><</CENTER>>
{% endif %}
{{ line }}
<<BOLD>>{{ ("Beleg " ~ transaction_number|default("---", true))|wordwrap(cols, true, "\\n") }}<</BOLD>>
Datum: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
{{ line }}
{% for item in items|default([]) %}
{% set qty = "%-4s"|format(("-" if buyback else "") ~ item.count ~ "x") %}
{% set amount = item.total|currency %}
{% set name_width = cols - qty|length - amount|length - 2 %}
{% set name_lines = (item.name|wordwrap(name_width, true, "\\n")).split("\\n") %}
{{ qty }} {{ name_lines[0].ljust(name_width) }} {{ amount }}
{% for rest in name_lines[1:] %}
{{ " " * (qty|length + 1) }}{{ rest }}
{% endfor %}
{{ " " * (qty|length + 1) }}{{ ("je " ~ item.unit_value|currency)|wordwrap(cols - qty|length - 1, true, "\\n") }}
{{ " " * (qty|length + 1) }}{{ item.kind_label|replace("§", "Par.")|wordwrap(cols - qty|length - 1, true, "\\n" ~ " " * (qty|length + 1)) }}
{% endfor %}
{{ sep }}
{% if tax_lines is defined and tax_lines %}
{% for tl in tax_lines %}
{{ row("enth. MwSt " ~ (tl.rate|int if tl.rate == tl.rate|int else tl.rate) ~ "%:", tl.tax|currency) }}
{% endfor %}
{% endif %}
{% if token_note is defined and token_note %}
{{ token_note|replace("§", "Par.")|wordwrap(cols, true, "\\n") }}
{% endif %}
<<BOLD>>{{ row("AUSGEZAHLT:" if buyback else "GESAMT:", total|default(0)|currency) }}<</BOLD>>
{{ line }}
{{ ("Zahlungsart: " ~ payment_label|default(payment_method))|wordwrap(cols, true, "\\n") }}
{% if amount_received is defined and amount_received %}
Gegeben: {{ amount_received|currency }}
{% endif %}
{% if change is defined and change > 0 %}
Rueckgeld: {{ change|currency }}
{% endif %}
{% if reason is defined and reason %}
{{ ("Grund: " ~ reason)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if actor_name is defined and actor_name %}
{{ ("Bediener: " ~ actor_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if device_name is defined and device_name %}
{{ ("Kasse: " ~ device_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if event_name is defined and event_name %}
{{ ("Veranstaltung: " ~ event_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
` +
  TSE_PRINT_BLOCK +
  `{{ line }}
{% if buyback %}
<<CENTER>>Betrag erhalten:<</CENTER>>


<<CENTER>>________________________<</CENTER>>
<<CENTER>>Unterschrift<</CENTER>>
{% else %}
<<CENTER>>Marken sind kein Wechselgeld.<</CENTER>>
<<CENTER>>Viel Spass beim Fest!<</CENTER>>
{% endif %}
<<FEED:3>>
<<CUT>>
`;

/**
 * Kellnerabrechnung („ABRECHNUNG Nr. N“) bzw. Zwischenstand einer Bedienung:
 * Kopf (Verein, Veranstaltung, Bedienung, Zeitraum, Geraet, abgerechnet
 * von), Bloecke mit Zeilen (`blocks[].rows[]`: `label` und `amount` bzw.
 * `text`), Soll bar mit Schublade je Geraet, Gezaehlt/Differenz (falls
 * gezaehlt), offene Tische bzw. erzwungen mit Notiz, Training getrennt,
 * Unterschriftszeilen. Kein TSE-Block: Die Abrechnung ist kein Beleg
 * (die Buchungen haben ihre eigenen). Nur vom Server ausgeliefert; im
 * Bon-Editor erst spaeter bearbeitbar.
 */
const WAITER_SETTLEMENT_SOURCE = `{# Zeichen pro Zeile: \`columns\` des Druckers, sonst 42 (80 mm) bzw. 32 (58 mm).
   Keine Zeile darf breiter sein, BIG zaehlt doppelt. #}
{% set cols = columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}
{% set sep = "=" * cols %}
{% set line = "-" * cols %}
{% macro row(label, value) %}{{ label }}{{ value|rjust(cols - label|length) }}{% endmacro %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>** TRAINING **<</BIG>><</BOLD>><</CENTER>>

{% endif %}
<<CENTER>><<BIG>>{{ organization.name|default("OpenEOS")|wordwrap(cols // 2, true, "\\n") }}<</BIG>><</CENTER>>
<<CENTER>>{{ sep }}<</CENTER>>
<<CENTER>><<BOLD>><<BIG>>{{ title|default("ABRECHNUNG") }}<</BIG>><</BOLD>><</CENTER>>
{% if number is defined and number %}
<<CENTER>><<BOLD>>{{ "Nr. " ~ number }}<</BOLD>><</CENTER>>
{% endif %}
{% if copy is defined and copy %}
<<CENTER>><<BOLD>>-- KOPIE --<</BOLD>><</CENTER>>
{% elif reprint %}
<<CENTER>><<BOLD>>-- NACHDRUCK --<</BOLD>><</CENTER>>
{% endif %}
{{ line }}
<<BOLD>>{{ ("Bedienung: " ~ waiter_name|default("---", true))|wordwrap(cols, true, "\\n") }}<</BOLD>>
{% if event_name is defined and event_name %}
{{ ("Veranstaltung: " ~ event_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if period_from is defined and period_from %}
{{ ("Von: " ~ period_from)|wordwrap(cols, true, "\\n") }}
{% endif %}
{{ ("Bis: " ~ period_to|default(""))|wordwrap(cols, true, "\\n") }}
{% if device_name is defined and device_name %}
{{ ("Kasse: " ~ device_name)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if settled_by is defined and settled_by %}
{{ ("Abgerechnet von: " ~ settled_by)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% for block in blocks|default([]) %}
{{ line }}
<<BOLD>>{{ block.title|wordwrap(cols, true, "\\n") }}<</BOLD>>
{% for r in block.rows %}
{% set value = (r.amount|currency) if r.amount is not none else (r.text|default("", true)|string) %}
{% if r.label|length + value|length + 1 > cols %}
{{ r.label|wordwrap(cols, true, "\\n") }}
{{ value|rjust(cols) }}
{% else %}
{{ row(r.label, value) }}
{% endif %}
{% endfor %}
{% endfor %}
{% if cash_expected is defined and cash_expected is not none %}
{{ sep }}
<<BOLD>>{{ row("SOLL BAR:", cash_expected|currency) }}<</BOLD>>
{% for d in cash_by_device|default([]) %}
{{ ("  " ~ d.name ~ ": " ~ d.amount|currency)|wordwrap(cols, true, "\\n    ") }}
{% endfor %}
{% if cash_hint is defined and cash_hint %}
{{ cash_hint|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if cash_counted is defined and cash_counted is not none %}
{{ row("GEZAEHLT:", cash_counted|currency) }}
<<BOLD>>{{ row("DIFFERENZ:", difference|default(0)|currency) }}<</BOLD>>
{% endif %}
{% endif %}
{% if open_tables is defined and open_tables %}
{{ line }}
<<BOLD>>{{ ("OFFENE TISCHE (" ~ open_tables|length ~ ")")|wordwrap(cols, true, "\\n") }}<</BOLD>>
{% for t in open_tables %}
{{ ("  " ~ t.label)|wordwrap(cols, true, "\\n    ") }}
{% endfor %}
{% endif %}
{% if forced %}
{{ line }}
<<BOLD>>TROTZ OFFENER TISCHE ABGERECHNET<</BOLD>>
{% if note is defined and note %}
{{ ("Notiz: " ~ note)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% endif %}
{% if training is defined and training %}
{{ line }}
{{ ("Training (nicht im Geld): " ~ training)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if tse is defined and tse %}
{{ line }}
{% if tse.failed %}
<<BOLD>>TSE nicht erreichbar<</BOLD>>
{% endif %}
{% if tse.bon_number %}
{{ ("Beleg-Nr.: " ~ tse.bon_number)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if not tse.failed %}
{{ ("TSE-Transaktion: " ~ tse.transaction_number)|wordwrap(cols, true, "\\n") }}
{{ ("Signaturzaehler: " ~ tse.signature_counter)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% endif %}
{% if tip_payout is defined and tip_payout %}
{{ line }}
<<BOLD>>{{ row("TRINKGELD BAR AUSGEZAHLT:", tip_payout|currency) if cols >= 36 else "TRINKGELD AUSGEZAHLT:" }}<</BOLD>>
{% if cols < 36 %}
<<BOLD>>{{ tip_payout|currency|rjust(cols) }}<</BOLD>>
{% endif %}
{% endif %}
{% if signatures|default(true) %}
{{ sep }}


{{ "_" * (cols - 4) }}
Bedienung


{{ "_" * (cols - 4) }}
Kasse / Schichtleitung
{% endif %}
{{ line }}
<<CENTER>>{{ printed_at|default("") }}<</CENTER>>
<<FEED:3>>
<<CUT>>
`;

/** Vorlagen, auf denen die TSE-Angaben stehen muessen. */
export const TSE_RECEIPT_TEMPLATES: readonly string[] = [
  RECEIPT_TEMPLATE,
  REFUND_RECEIPT_TEMPLATE,
  PFAND_RETURN_RECEIPT_TEMPLATE,
  TOKEN_RECEIPT_TEMPLATE,
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
  [PFAND_RETURN_RECEIPT_TEMPLATE]: PFAND_RETURN_RECEIPT_SOURCE,
  [WAITER_SETTLEMENT_TEMPLATE]: WAITER_SETTLEMENT_SOURCE,
  [HOSPITALITY_RECEIPT_TEMPLATE]: HOSPITALITY_RECEIPT_SOURCE,
  [TOKEN_RECEIPT_TEMPLATE]: TOKEN_RECEIPT_SOURCE,
  [CANCELLATION_TICKET_TEMPLATE]: `{# Zeichen pro Zeile: \`columns\` des Druckers, sonst 42 (80 mm) bzw. 32 (58 mm).
   Keine Zeile darf breiter sein, BIG zaehlt doppelt. #}
{% set cols = columns|default(42 if paper_width|default(80) == 80 else 32, true)|int %}
{% set sep = "=" * cols %}
{% set box = "#" * cols %}
{% if is_test %}
<<CENTER>><<BOLD>><<BIG>>** TESTMODUS **<</BIG>><</BOLD>><</CENTER>>

{% endif %}
{{ box }}
<<CENTER>><<BOLD>><<BIG>>STORNO<</BIG>><</BOLD>><</CENTER>>
<<CENTER>>Nicht zubereiten<</CENTER>>
{{ box }}

<<CENTER>><<BIG>>#{{ daily_number|default(order_number|default("---")) }}<</BIG>><</CENTER>>
{% if table_number is defined and table_number %}
<<CENTER>><<BOLD>>{{ ("TISCH " ~ table_number)|wordwrap(cols, true, "\\n") }}<</BOLD>><</CENTER>>
{% endif %}
{% if station_name is defined and station_name %}
<<CENTER>>{{ ("Station: " ~ station_name)|wordwrap(cols, true, "\\n") }}<</CENTER>>
{% endif %}
{{ sep }}
<<LEFT>>
{% for item in items|default([]) %}
<<BOLD>><<BIG>>{{ ("-" ~ item.quantity ~ "x " ~ item.name)|wordwrap(cols // 2, true, "\\n") }}<</BIG>><</BOLD>>
{% if item.options is defined and item.options %}
{% for opt in item.options %}
    {{ opt|wordwrap(cols - 4, true, "\\n    ") }}
{% endfor %}
{% endif %}

{% endfor %}
{{ sep }}
{% if reason is defined and reason %}
{{ ("Grund: " ~ reason)|wordwrap(cols, true, "\\n") }}
{% endif %}
{% if created_at is defined and created_at %}
Storniert: {{ created_at|strftime("%d.%m.%Y %H:%M") }}
{% endif %}
<<FEED:3>>
<<CUT>>
`,
};

/**
 * Vorlagen fuer den Drucker-Agenten (`GET /device-api/templates`, Push beim
 * Verbinden und nach dem Speichern): eigene Vorlagen der Organisation als
 * Jinja2-Quelltext (Designer: `generatedTemplate`), Zahlart als
 * Anzeigename, Bons mit TSE-Block; mitgelieferte Vorlagen, wo die
 * Organisation keine eigene hat (aeltere Agenten kennen sie bzw. den
 * TSE-Block noch nicht, z. B. `pfand_return_receipt`).
 */
export function agentTemplateMap(
  templates: { type: string; template: unknown }[],
): Record<string, string> {
  const templateMap: Record<string, string> = {};
  for (const t of templates) {
    const tpl = t.template as { generatedTemplate?: string } | string | null;
    // Zahlart als Anzeigename („Bar“) statt Rohwert („cash“), auch in
    // Vorlagen aus der Zeit vor `payment_label`.
    if (typeof tpl === 'string') {
      templateMap[t.type] = withPaymentLabel(tpl);
    } else if (tpl && typeof tpl.generatedTemplate === 'string') {
      templateMap[t.type] = withPaymentLabel(tpl.generatedTemplate);
    }
    // sonst: Agent nimmt seine eigene Vorlage dieses Typs.
  }
  // Eigene Bons bekommen die TSE-Angaben angehaengt: bei aktiver TSE
  // Pflicht und nicht abwaehlbar (ohne `tse` im Auftrag druckt der Block
  // nichts).
  for (const name of TSE_RECEIPT_TEMPLATES) {
    if (templateMap[name]) templateMap[name] = withTseBlock(templateMap[name]);
  }
  for (const [name, source] of Object.entries(BUILTIN_PRINT_TEMPLATES)) {
    if (!templateMap[name]) templateMap[name] = source;
  }
  return templateMap;
}
