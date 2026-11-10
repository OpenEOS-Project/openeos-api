# DSFinV-K (Kassenabschluss, Export, eigene Prüfung) und Kassenbuch

Eigene Umsetzung der **Digitalen Schnittstelle der Finanzverwaltung für Kassensysteme (DSFinV-K)** nach § 146a Abs. 1 S. 4 AO, § 4 KassenSichV — ohne Fremdbibliotheken und ohne fremde Prüfwerkzeuge, ausschließlich nach der amtlichen Spezifikation (Entscheidung 2026-11-03). Issue: openeos-api#102.

## Grundlage (Stand der Spezifikation)

| | |
|---|---|
| Spezifikation | **DSFinV-K Version 2.4**, Dokument `20231215_DSFinV_K_2_4.pdf` (Stand 15.12.2023; BMF-Schreiben vom 12.01.2024). Inhaltlich gleich 2.3 (Tz. 5: „Inhaltliche Änderungen zur Version 2.3 erfolgten nicht“). |
| USt-Schlüssel | Anlage 2 `20241205_DSFinV_K_Anlage2_UStSchluessel.pdf` (Stand 05.12.2024) |
| Bezugsquelle | BZSt, <https://www.bzst.de/DE/Unternehmen/Aussenpruefungen/DigitaleSchnittstelleFinV/digitaleschnittstellefinv_node.html> → `dsfinv_k_v_2_4.zip` (`…/dsfinv_k_v_2_4.zip?__blob=publicationFile&v=19`, abgerufen 03.11.2026, SHA-256 `efd6816f95d86d773015c38e8a80fd0c9eca1bc2bba9968b900cfd9564e7b1a7`) |
| Vendorte Dateien | `assets/dsfinvk/index.xml` (SHA-256 `d0b1fed3…5c85160`) und `assets/dsfinvk/gdpdu-01-09-2004.dtd` (SHA-256 `af3d4c5a…63f848a2`) unverändert aus `02_index.xml/` des ZIP; `dsfinvk-schema.spec.ts` prüft die Prüfsummen und dass `dsfinvk-schema.ts` genau dieselben Tabellen/Spalten beschreibt. |
| `TAXONOMIE_VERSION` | `2.4` |

## Aufbau

| Datei | Inhalt |
|---|---|
| `dsfinvk-schema.ts` | Die 20 Tabellen aus der amtlichen `index.xml` (Datei, Name, Spalten, Typ, Länge, Nachkommastellen). |
| `dsfinvk-format.ts` | CSV-Regeln der `index.xml`: UTF-8, `;`, CR LF, Textbegrenzer `"`, Kopfzeile (`Range From 2`), Dezimalkomma ohne Tausendertrenner, Beträge mit 2 Nachkommastellen (Tz. 4.1), Mengen mit 3, Zeitpunkte RFC 3339 (Ortszeit Berlin mit Versatz), TSE-Log-Zeiten `YYYY-MM-DDThh:mm:ss.fffZ`. |
| `dsfinvk-builder.ts` | Rein: ein Kassenabschluss → Zeilen aller 20 Tabellen + Summen. |
| `dsfinvk-export.ts`, `dsfinvk-zip.ts` | ZIP (eigener Schreiber/Leser, Deflate aus Node) mit 20 CSV + `index.xml` (nur `DataSupplier` gefüllt) + DTD; Inhalts-Prüfsumme je Abschluss. |
| `dsfinvk-validator.ts` | Eigene Prüfung (siehe unten), auch als `pnpm dsfinvk:validate <zip>`. |
| `cash-point-closing.service.ts` | Abschlüsse anlegen (Zeitplan, auf Knopfdruck), speichern, exportieren, ablegen. |
| `cashbook.service.ts` | Kassenbuch (Anfangsbestand, Einlage, Entnahme, Kassensturz). |
| `testing/dsfinvk-fixtures.ts` | Testvorgänge, gebaut mit denselben Funktionen wie im Verkauf. |

## Kasse, Abschluss, Vorgänge

- **Eine Kasse je Organisation** (tse-swissbit-plan.md §7): `Z_KASSE_ID` = `KASSE_SERIENNR` = TSE-Client-ID `OEOS-<12 Hex der Org-ID>` (ohne `/` und `_`). Geräte sind **Terminals** (`Stamm_Terminals`, `POS_TERMINAL_ID` je Position). `TERMINAL_ID` im Bonkopf bleibt leer, weil die TSE nur die Client-ID der Kasse kennt (Anhang E, TERMINAL_ID).
- **Ein Vorgang = ein Datensatz in `tse_transactions`** = ein Bonkopf. `BON_ID` = `BON_NR` = fortlaufende Nummer je Kasse, vergeben vom Datenbank-Trigger beim Einfügen (lückenlos, auch für Abgleich und Kassenbuch); sie steht als „Beleg-Nr.“ auf dem Bon (`tse.bon_number`).
- **Kassenabschluss** (`cash_point_closings`): je Geschäftstag 06:00–06:00 Europe/Berlin (`BUSINESS_DAY_START_HOUR`), stündlicher Lauf (`:20`) schließt abgelaufene Tage ab; „Kassenabschluss jetzt erstellen“ schließt bis jetzt ab (mehrere Abschlüsse je Tag sind erlaubt, Tz. 3/Anhang E Z_NR). `Z_NR` fortlaufend je Kasse. Jeder Vorgang steht in genau einem Abschluss (`tse_transactions.cash_point_closing_id`); laufende (`pending`) Vorgänge verschieben den Abschluss (409 `DSFINVK_PENDING_TRANSACTIONS`).
- **Unveränderlich**: Der Abschluss speichert die fertigen Zeilen aller Tabellen (`rows`), Summen (`totals`), Stammdaten zum Abschluss (`master_data`, Tz. 3: Stammdaten je Abschluss) und `content_sha256`; ein Trigger verbietet Änderungen und Löschen. Exporte setzen nur gespeicherte Zeilen zusammen → reproduzierbar.
- **Ablage**: je Abschluss ein ZIP unter `TSE_EXPORT_DIR/<org>/dsfinvk/Z<nr>_<datum>.zip` mit SHA-256 (`export_sha256`); `archived_at`/`archive_ref` bleiben für den ELeFANT-Upload frei.

## Abbildung (Mapping)

| OpenEOS (`tse_transactions.kind`) | BON_TYP | Positionen (GV_TYP) | Zahlart |
|---|---|---|---|
| `receipt` (Zahlung, Einzel/Split/Sammel/Tisch/Verwaltung) | `Beleg` (Testmodus: `AVTraining`) | `Umsatz` je Position (Varianten/Optionen in `Bonpos_Zusatzinfo`), `Pfand` je Position mit Pfand (USt-Schlüssel des Satzes der Pfandart), `TrinkgeldAG`/`TrinkgeldAN`, `Rabatt` je USt-Schlüssel für Bestellrabatte (gesonderte Zeile, Tz. 4.2.4) | `Bar`; Karte → `Unbar` „Kartenzahlung“ (Debit/Kredit unbekannt); PayPal/SumUp Online/Google Pay/Apple Pay → `ElZahlungsdienstleister` |
| `receipt` einer Online-Vorkasse (Shop mit SumUp Online, QR-Bestellung mit PayPal), nur mit aktiver Cloud-TSE | `Beleg` (Zeitpunkt: Zahlungseingang) | `Umsatz` je Position wie oben; keine `Anzahlungseinstellung`/`Anzahlungsaufloesung` | `ElZahlungsdienstleister` (ZAHLART_NAME „SumUp Online“, „PayPal“ …) |
| Teilzahlung nach Betrag | `Beleg` | je Satz „Teilzahlung Bestellung N“ (`Umsatz`), Positionen der Bestellung zur Erläuterung in `Bonpos_Zusatzinfo` | wie oben |
| Beleg über 0,00 | `Beleg` | Positionen + `Rabatt` auf 0 | `Bar` 0,00 |
| `refund` (Erstattung/Storno) | `Beleg`, `BON_STORNO = 1` bei vollständigem Storno, sonst 0; Verweis in `Bon_Referenzen` (`Transaktion`) | negative Mengen (Tz. 4.2.5); rabattierter Erstattungspreis mit Entstehung in `Bonpos_Preisfindung`; Kulanz ohne Positionen → `Rabatt` (nachträgliche Entgeltminderung) | wie die Erstattung |
| `deposit_return` (Pfand-Auszahlung) | `Beleg` | `PfandRueckzahlung` je Pfandart, negativ, USt-Schlüssel des Satzes der Pfandart | `Bar` negativ |
| `order` / `order_cancellation` (Bestellung ohne sofortige Zahlung: Tisch, Theke „Senden“, Verwaltung; Bestellung-V1) | `AVBestellung` | `Umsatz` (Storno mit negativer Menge, Tz. 4.2.3) | `Keine` |
| `abort` (Abgleich, AVBelegabbruch) | `AVBelegabbruch`, Verweis auf den abgebrochenen Vorgang | – | `Keine` |
| `cashbook` (Kassenbuch) | `Beleg` | `Anfangsbestand` (GV_NAME „Restbestand Vorabschluss“), `Geldtransit` („Wechselgeld aus Vereinskasse“ / „Abschöpfung an Vereinskasse“), `DifferenzSollIst` („Kassensturz“), USt-Schlüssel 5 | `Bar` |

- **Abrechnungskreis** (`Bonkopf_AbrKreis`): `Tisch <nr> / Bestellung <nr> (<8 Zeichen Bestell-ID>)` für alle Vorgänge einer Bestellung (Tz. 2.7, 3.1.2.2); die Zahlung verweist zusätzlich auf die Bestellvorgänge (`Bon_Referenzen`).
- **Beträge**: Bonkopf_USt und Bonkopf_Zahlarten kommen aus den signierten Prozessdaten (Rechnungsdoppel); die Positionen werden je USt-Schlüssel exakt darauf abgestimmt (Differenzen als `Rabatt`/`Aufschlag`, kleine Rundungen mit `GV_NAME` „Rundung“). USt = brutto × Satz / (100 + Satz), gerundet wie auf dem Bon.
- **USt-Schlüssel**: 19 % → 1, 7 % → 2, 0 % → 5 (nicht steuerbar); steuerbefreite Organisationen (`settings.vatExempt`, Kleinunternehmer) → 6 mit `UST_BESCHR` „steuerfrei – Kleinunternehmer § 19 UStG“ (Steuerberater 2026-11-10, Frage 9: § 19 Abs. 1 UStG n. F. „ist steuerfrei“, bleibt also steuerbar). Kassenbuch, TrinkgeldAN und Pfand-Altsaldo immer 5. Der 0-%-Slot der Prozessdaten gilt für 5, 6 und 7 gemeinsam; stehen mehrere davon auf einem Bon, wird `Bonkopf_USt` nach den Positionen aufgeteilt.
- **Kleinunternehmer → umsatzsteuerpflichtig**: `POST /organizations/:id/vat-status {vatExempt}` erstellt zuerst einen Kassenabschluss bis jetzt (alle bisherigen Vorgänge mit dem alten Status), dann Stammdatenwechsel (Tz. 3), Protokoll `vat_status_changed`, Verlauf `settings.vatStatusHistory`. Mit TSE-Vorgängen lehnt `PATCH /organizations/:id` einen Wechsel von `settings.vatExempt` ab (409 `VAT_STATUS_CHANGE_REQUIRES_CLOSING`). Warnung im Dashboard: `GET /organizations/:id/reports/small-business` (Umsatz laufendes/Vorjahr gegen 100.000 €/25.000 €).
- **Pfand** (ab 2026-11, openeos-web#116): Pfand gehört zum Entgelt (Abschn. 10.1 Abs. 8 UStAE), die Rückgabe mindert es (§ 17 UStG). Jede Pfandart hat einen Steuersatz (`pfand_types.vat_rate`, Standard 19 %); Verkauf, Erstattung und Auszahlung halten ihn als Snapshot fest (`order_items.deposit_tax_rate`, `refund_items.deposit_tax_rate`, `pfand_returns.lines[].vatRate`) und geben ihn in der TSE-Kopie weiter (`items[].depositTaxRate`, `composition.pfandByRate`, `pfandLines[].vatRate`). `Pfand`- und `PfandRueckzahlung`-Zeilen stehen beim USt-Schlüssel dieses Satzes, in den Prozessdaten im Slot des Satzes (Becher 2 € zu 19 %: `Beleg^2.00_…^2.00:Bar`, Rückgabe `Beleg^-2.00_0.00_0.00_0.00_0.00^-2.00:Bar`). Ein Satz je Pfandart; Pfand für Waren mit anderem Satz bekommt eine eigene Pfandart. Vorgänge von vor der Umstellung haben keinen Satz in der Kopie und bleiben, wie sie signiert wurden, im 0-%-Schlüssel 5. Steuerbefreite Organisationen: Schlüssel 6 wie alles andere. **Übergang (Steuerberater 2026-11-10, Frage 2, Variante A)**: Becher, die vor der Umstellung ohne USt verkauft wurden, dürfen bei der Rückgabe keine Steuer mindern. Je Organisation gibt es einen **Altsaldo** = ohne Satz verkauftes Pfand (bezahlt, nicht storniert/erstattet, ohne Test) − Rückgaben ohne Satz − schon gegen den Altsaldo gebuchte Rückgaben. Neue Rückgaben werden zuerst dagegen gebucht (`pfand_returns.lines[].legacyCents`, unter der Sperre der Belegnummer): Prozessdaten im 0-%-Slot, `PfandRueckzahlung` „(Altsaldo vor USt-Umstellung)“ mit Schlüssel 5, keine MwSt-Zeile auf dem Beleg, im Bericht bei 0 %; erst danach mit dem Satz der Pfandart. Kleinunternehmer: kein Verbrauch (keine Steuerwirkung). Offener Altsaldo: `GET /organizations/:id/pfand-types/legacy-balance`. Variante B (Altsaldo einmalig nachversteuern) bleibt mit dem Steuerberater zu klären.
- **Trinkgeld** (seit 2026-11-11, Steuerberater Fragen 3–5): an den umsatzsteuerpflichtigen Verein ist es Entgelt → `TrinkgeldAG` mit dem Satz der Hauptleistung; bei gemischten Bons im Verhältnis der Nettoentgelte der Waren je Satz (Pfand zählt nicht mit), Rundungsrest auf den größten Anteil (`tipByRate`). In den Prozessdaten in den Slots der Ware, in `Bonpos_USt` je Schlüssel 1/2, auf dem Bon in den MwSt-Zeilen, im Bericht „Umsatzsteuer“. `TrinkgeldAN` (Schlüssel 5, kein Entgelt) nur, wenn die kassierende Bedienung „Arbeitnehmer (Lohnkonto)“ ist (`waiters.is_employee`). Kleinunternehmer: `TrinkgeldAG` mit Schlüssel 6. Die TSE-Kopie trägt `tipRecipient` und `tipByRate`; Vorgänge ohne Kennzeichen (Bestand) bleiben, wie sie signiert wurden (0-%-Slot, GV_TYP nach der alten Einstellung `settings.dsfinvk.tipRecipient`). Erstattungen spiegeln den Ursprungsbeleg.
- **TSE-Ausfall**: Vorgang bleibt `Beleg`; `TSE_Transaktionen` mit `TSE_TA_FEHLER` „TSE ausgefallen: <Code> – <Text>“ (≤ 200 Zeichen), ohne Signatur; `BON_NOTIZ` „TSE ausgefallen“. Der Bon wird erst nach `finishTransaction` gedruckt (Zeitbudget `TSE_SIGN_BUDGET_MS`); bei Zeitlimit/Fehler ist er ein Ausfallbeleg „TSE nicht erreichbar – Beleg ohne Signatur“.
- **Signatur nach Belegausgabe** (seit 2026-11-10, Steuerberater Frage 16): findet der Abgleich eine verlorene Antwort (`recovered_at`), bleibt der Vorgang `failed` (der Bon war ein Ausfallbeleg, kein Nachsignieren, keine Umdeutung). `TSE_Transaktionen` enthält die echten Signaturdaten der TSE **und** `TSE_TA_FEHLER` „Signatur nach Belegausgabe (TSE nicht erreichbar: <Code> – <Text>)“; `BON_NOTIZ` „TSE ausgefallen; Signatur nach Belegausgabe“. Ein Nachdruck zeigt den Ausfallvermerk und darunter „Signatur nach Belegausgabe“ mit TA-Nr., Signaturzähler und Ende, ohne QR-Code. Bestand (vor 2026-11-10 als signiert übernommen, noch nicht abgeschlossen) stellt Migration `1842000000000` zurück auf `failed`.
- **Bestellungen vor dem Küchenbon** (Frage 19): jede Bestellung ohne sofortige Zahlung (Tisch, „Senden“ an der Theke, Verwaltung) wird vor dem Küchenbon als `Bestellung-V1` abgesichert; bei Sofortzahlung werden die Kassenbelege vor dem Küchenbon signiert. Der Beleg der Zahlung druckt den Beginn der ersten Bestellung (`tse.order_start_time`, Tz. 2.7.3).
- **TSE-Wechsel**: alle im Abschluss genutzten TSEs in `Stamm_TSE` (`TSE_ID` 1…n je Abschluss), Zertifikat aus Swissbit `certificateChain` (`tse_units.certificate`).
<<<<<<< HEAD
- **Online-Vorkasse** (Shop, QR mit PayPal): nicht über die Kasse erfasst und nicht signiert (BMF-FAQ Anwendungsbereich 10) → nicht in der DSFinV-K.
- **Trinkgeld-Empfänger**: je Bedienung (`waiters.is_employee`), nicht mehr je Organisation. `settings.dsfinvk.tipRecipient` gilt nur noch für Bestand ohne Kennzeichen.
=======
- **Online-Vorkasse** (Shop, QR mit PayPal) — seit 2026-11: **mit aktiver Cloud-TSE signiert und im Export**, ohne TSE (Betriebsarten „Bargeldlos“/„Nur Bons“) getrennt und TSE-frei. Hintergrund: Steuerberater 2026-11-10, Frage 20 — TSE-frei ist der Shop nur bei vollständiger Trennung von der Kasse mit Bargeld; Empfehlung für Vereine mit Bargeld: alles mitsignieren.
  - **Mit TSE**: Sobald die Zahlung erfasst ist (Shop: `settleCheckout` legt Bestellung und Zahlung an; QR: PayPal-Capture), signiert `TseSigningService.signPayment` einen Kassenbeleg-V1 (`Beleg^…^<betrag>:Unbar`) — nach dem Speichern, vor Küchen- und Kassenbon; der Bon trägt den TSE-Block. Nur der Aufruf, der die Zahlung anlegt bzw. auf `captured` setzt, signiert (Rückkehrseite und Webhook können doppelt kommen). Ein TSE-Ausfall blockiert nie (Vorgang `failed`, Bon mit Vermerk).
  - **Abbildung**: Eine vollständig vorausbezahlte Shop-Bestellung über bestimmte Waren ist ein `Beleg` mit `Umsatz` je Position zum Zeitpunkt der Zahlung — die USt auf Anzahlungen entsteht mit Vereinnahmung (§ 13 Abs. 1 Nr. 1 Buchst. a Satz 4 UStG) —, Zahlart `ElZahlungsdienstleister`. Keine `Anzahlungseinstellung`/`Anzahlungsaufloesung`: die Abholung ist kein weiterer kassenrelevanter Vorgang. QR-Zahlung genauso. Erstattungen laufen wie jede Erstattung (`refund`, Verweis auf den Online-Beleg, zurück an den Anbieter).
  - **Ohne TSE**: nichts signiert, nichts im Export; die harte Trennung sichern die Betriebsarten ab — keine Barzahlung auf Shop-/QR-Bestellungen in „Bargeldlos“ (`assertCashAllowed`), Erstattung immer auf die ursprüngliche Zahlart (es gibt keine Bar-Auszahlung), „Nur Bons“ nimmt gar keine Zahlung. Einzelaufzeichnung und Datenzugriff über den CSV-Export der Bestellungen (`GET …/orders/export`, mit Zahlungsanbieter, Zahlungs- und Erstattungsreferenz).
  - **Offen**: Die Servicegebühr des Shops ist keine Position; sie geht im Kassenbeleg wie eine Rundungsdifferenz in den Slot mit dem größten Warenanteil (DSFinV-K: Zeile `Aufschlag`).
- **Rabattgutscheine** (`src/modules/discount-vouchers`): kostenlose Vorlagen des Vereins, angewendet als Bestellrabatt (`discountAmount` + `discountReason`), nie als Zahlart → `Rabatt` je USt-Schlüssel, keine Gutschein-Einlösung, kein `GUTSCHEIN_NR`. Es wird nichts „an Geldes statt“ angenommen (AEAO zu § 146a Nr. 1.2). Verkaufte Wertmarken/Gutscheine gibt es in OpenEOS nicht; jede künftige Zahlart außerhalb der Positivliste (`CASHLESS_PAYMENT_METHODS`: Karte, SumUp-Terminal, SumUp Online, PayPal, Google Pay, Apple Pay) ist in „Bargeldlos“ gesperrt (403 `CASH_PAYMENTS_DISABLED`, Grund `PAYMENT_METHOD_NOT_ALLOWED_CASHLESS`) und gilt sonst wie Bargeld (TSE nötig).
- **Trinkgeld**: `settings.dsfinvk.tipRecipient` = `employer` (Standard, `TrinkgeldAG`, Trinkgeld an den Verein) oder `employee` (`TrinkgeldAN`).
>>>>>>> origin/dev
- **Stammdaten**: Name (`settings.legalName` oder Organisationsname), Anschrift (`settings.contact`), `settings.taxNumber`/`settings.vatId` (eins davon Pflicht, § 14 Abs. 4 Nr. 2 UStG; für die Cloud-TSE vorausgesetzt: 409 `TSE_MASTER_DATA_REQUIRED`), Land Alpha-3. Betriebsstätte (`Stamm_Orte`) = Sitz der Organisation.

## Kassenbuch

Steuerberater 2026-11-10, Frage 6: **Anfangsbestand** ist nur Bargeld, das bei der Eröffnung schon in der Kasse liegt (Restbestand aus dem Vorabschluss; `GET …/cashbook` liefert `openingBalanceSuggestion` = zuletzt gezählter Bestand). Wechselgeld aus der Vereinskasse ist **Geldtransit** „Wechselgeld aus Vereinskasse“ (`deposit`), die Abschöpfung am Ende Geldtransit „Abschöpfung an Vereinskasse“ (`withdrawal`). Eine Privateinlage gibt es beim e. V. nicht. Bestandsdaten bleiben gültig (gleiche Arten, nur neue GV_NAME).

`cashbook_entries` je Geschäftstag, nur wenn Bargeld erlaubt ist (`assertCashAllowed`). Jede Bargeldbewegung ≠ 0 ist ein eigener Kassenbeleg-V1 (`Beleg^0.00_0.00_0.00_0.00_<betrag>^<betrag>:Bar`, Beispiele Anhang I). Soll-Bestand je Gerät bzw. ganze Kasse = Kassenbuch + Barzahlungen (`captured`/`refunded`) + Bar-Erstattungen (negativ) − Pfand-Auszahlungen, jeweils ohne Testbuchungen. Der Kassensturz bucht die Differenz gezählt − Soll als `DifferenzSollIst` (bei 0 kein Beleg).

## Eigene Prüfung (`dsfinvk-validator.ts`, `pnpm dsfinvk:validate <zip> [--json] [--warnings]`)

1. Dateien: `index.xml`, DTD, alle 20 Tabellen der amtlichen `index.xml`.
2. `index.xml`: Tabellen, Spalten (Reihenfolge, Typ, Länge, Nachkommastellen), UTF8, DecimalSymbol, Trennzeichen, Textbegrenzer, Kopfzeile — Vergleich mit der amtlichen Vorlage.
3. CSV: Kopfzeile, Spaltenzahl, CR LF, UTF-8, Längen, Zahlenformat, ISO-8601/RFC-3339-Zeitpunkte, TSE-Zeitformat, Wertelisten (BON_TYP, GV_TYP, ZAHLART_TYP, REF_TYP, TYP, Signaturalgorithmus, Zeitformat, Kodierung, 0/1-Felder), Alpha-3/ISO-4217, Seriennummer ohne `/`/`_`, Pflichtfelder.
4. Beziehungen: Abschluss (Z_KASSE_ID, Z_ERSTELLUNG, Z_NR) in allen Tabellen, Bon/Position vorhanden, USt-Schlüssel/Terminal/TSE/Agentur in den Stammdaten, Referenzen auf vorhandene Vorgänge mit passendem `REF_DATUM`, genau eine Kasse/ein Ort je Abschluss, STNR oder USTID.
5. Summen: UMS_BRUTTO = Σ Bonkopf_USt = Σ Bonkopf_Zahlarten; Bonkopf_USt je Schlüssel = Σ Bonpos_USt; Netto + USt = Brutto; USt passt zum Satz (Hinweis); Preisfindung = Position; MENGE × STK_BR ≈ Position (Hinweis); Z_GV_Typ, Z_Zahlart, Z_SE_ZAHLUNGEN, Z_SE_BARZAHLUNGEN, Z_Waehrungen = Σ der Belege; AV-Vorgänge nur Zahlart „Keine“; Training ohne Wirkung auf den Abschluss.
6. Folgen: Z_NR und BON_ID lückenlos, Z_START_ID/Z_ENDE_ID.
7. TSE: jeder Vorgang hat eine Zeile in `TSE_Transaktionen` mit vollständiger Signatur oder `TSE_TA_FEHLER`; Transaktionsnummern eindeutig; `TSE_VORGANGSDATEN` passt zu BON_TYP, Bonkopf_USt (Slot je Schlüssel) und Zahlarten (Bar/Unbar) bzw. bei Bestellung-V1 zur Summe.

Die Tests (`dsfinvk-export.spec.ts`, `dsfinvk.db.spec.ts`) prüfen erzeugte Exporte für: mehrere Steuersätze, Rabatte, Varianten, Pfand + Pfandrückgabe, Trinkgeld (AG/AN), Storno/Erstattung (auch über Abschlüsse hinweg, Kulanz, rabattierte Positionen), Training, TSE-Ausfall + AVBelegabbruch, Tischbetrieb (AVBestellung), Kassenbuch, Rabattgutschein als `Rabatt`, mehrere Terminals, TSE-Wechsel, leeren Tag, Split/Teilzahlung/0-€-Beleg, Determinismus — und Negativfälle (fehlende Datei, falsche Kopfzeile, Dezimalpunkt, falsche Summen, Lücke in BON_ID, fehlende TSE-Zeile, falsche Prozessdaten, fehlende Steuernummer). `dsfinvk.db.spec.ts` läuft mit `TEST_DSFINVK_DATABASE_URL=postgres://…/<name>_scratch` gegen eine Wegwerf-Datenbank, ebenso `online-prepayment.db.spec.ts` (bezahlte Shop-Bestellung → signierter Beleg, Erstattung mit Verweis, Abschluss und Export mit `ElZahlungsdienstleister`; `DSFINVK_SPEC_ZIP_DIR=<ordner>` legt die ZIPs für `pnpm dsfinvk:validate` ab).

## Endpunkte

| Methode / Pfad | Wer | Zweck |
|---|---|---|
| `GET /organizations/:id/dsfinvk?from=&to=` bzw. `?zFrom=&zTo=` | Admin | ZIP (20 CSV + index.xml + DTD), Header `X-Checksum-SHA256` |
| `GET /organizations/:id/dsfinvk/closings` | Admin | Abschlüsse + offene Vorgänge |
| `POST /organizations/:id/dsfinvk/closings` | Admin | Kassenabschluss jetzt |
| `GET /organizations/:id/dsfinvk/closings/:closingId/download` | Admin | ZIP eines Abschlusses (Archiv) |
| `GET /organizations/:id/tse/exports/bundle?from=&to=` | Admin | TSE-TAR-Exporte des Zeitraums in einem ZIP |
| `GET`/`POST /organizations/:id/cashbook` | Admin | Kassenbuch eines Tages / Buchung für die ganze Kasse |
| `GET`/`POST /device-api/cashbook` | Gerät | Kassenbuch an der Kasse |

## Offene Fragen (Steuerberatung)

- **S1 Pfand**: Übergangsregel umgesetzt 2026-11-11 (Altsaldo, siehe Pfand); entschieden 2026-11-09 — Pfand ist Teil des Entgelts und trägt den Satz seiner Pfandart (Standard 19 %), die Rückgabe mindert Umsatz und USt zum selben Satz (siehe oben). Rest-Frage für die Steuerberatung: Rückgaben von Bechern, die vor der Umstellung ohne USt verkauft wurden, werden mit dem Satz der Pfandart gebucht (nur im Übergang nach der Umstellung).
- **S2 Trinkgeld**: beantwortet 2026-11-10 — siehe „Trinkgeld“ oben.
- **S3 Kleinunternehmer**: beantwortet 2026-11-10 — Schlüssel 6.
- **Erstattung über mehrere Sätze**: Aufteilung anteilig nach dem Ursprungsbeleg — so umgesetzt.
- **Kassenbuch**: beantwortet 2026-11-10 — siehe „Kassenbuch“.
