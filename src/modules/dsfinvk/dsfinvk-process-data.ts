/**
 * Liest die an die TSE uebergebenen Prozessdaten (DSFinV-K Anhang I)
 * zurueck. Die signierten Betraege sind die Wahrheit fuer Bonkopf_USt und
 * Bonkopf_Zahlarten („Rechnungsdoppel“, Tz. 3.1.2).
 */

export interface ParsedKassenbeleg {
  type: string;
  /** Fuenf Steuer-Slots in Cent: 19 %, 7 %, 10,7 %, 5,5 %, 0 %. */
  slots: [number, number, number, number, number];
  payments: { type: 'Bar' | 'Unbar'; cents: number; currency: string }[];
}

const AMOUNT = /^-?\d+\.\d{2}$/;

function parseAmount(text: string): number | null {
  if (!AMOUNT.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, fraction] = text.replace('-', '').split('.');
  const value = Number(whole) * 100 + Number(fraction);
  return negative ? -value : value;
}

export function parseKassenbeleg(
  processData: string,
): ParsedKassenbeleg | null {
  const parts = processData.split('^');
  if (parts.length !== 3) return null;
  const [type, slotText, paymentText] = parts;
  const slotValues = slotText.split('_').map(parseAmount);
  if (slotValues.length !== 5 || slotValues.some((v) => v === null))
    return null;
  const payments: ParsedKassenbeleg['payments'] = [];
  if (paymentText) {
    for (const entry of paymentText.split('_')) {
      const [amount, kind, currency] = entry.split(':');
      const cents = parseAmount(amount ?? '');
      if (cents === null || (kind !== 'Bar' && kind !== 'Unbar')) return null;
      payments.push({ type: kind, cents, currency: currency || 'EUR' });
    }
  }
  return {
    type,
    slots: slotValues as ParsedKassenbeleg['slots'],
    payments,
  };
}

export interface ParsedOrderLine {
  quantity: number;
  name: string;
  unitCents: number;
}

/** `Bestellung-V1`: Zeilen mit CR, `<Menge>;"<Bezeichnung>";<Preis>`. */
export function parseBestellung(processData: string): ParsedOrderLine[] | null {
  if (!processData) return [];
  const lines: ParsedOrderLine[] = [];
  for (const row of processData.split('\r')) {
    const match = /^(-?\d+(?:\.\d+)?);"((?:[^"]|"")*)";(-?\d+\.\d{2})$/.exec(
      row,
    );
    if (!match) return null;
    const unit = parseAmount(match[3]);
    if (unit === null) return null;
    lines.push({
      quantity: Number(match[1]),
      name: match[2].replace(/""/g, '"'),
      unitCents: unit,
    });
  }
  return lines;
}
