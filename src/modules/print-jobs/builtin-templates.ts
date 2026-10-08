/**
 * Mitgelieferte Vorlagen fuer den Gegenbeleg (Erstattung/Storno) und den
 * Storno-Bon der Kueche. Gerendert wird im Drucker-Agenten (Jinja2, wie
 * `receipt` und `kitchen_ticket`). Der Agent bringt sie ab seiner naechsten
 * Version selbst mit; bis dahin liefert sie `GET /device-api/templates` aus
 * (der Agent holt die Vorlagen beim Start und speichert sie), sofern die
 * Organisation keine eigene Vorlage dieses Typs hat.
 */
export const REFUND_RECEIPT_TEMPLATE = 'refund_receipt';
export const CANCELLATION_TICKET_TEMPLATE = 'cancellation_ticket';

export const BUILTIN_PRINT_TEMPLATES: Record<string, string> = {
  [REFUND_RECEIPT_TEMPLATE]: `{% set cols = 42 if paper_width|default(80) == 80 else 32 %}
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
{{ line }}
<<CENTER>>Betrag erhalten:<</CENTER>>


<<CENTER>>________________________<</CENTER>>
<<CENTER>>Unterschrift<</CENTER>>
<<FEED:3>>
<<CUT>>
`,
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
