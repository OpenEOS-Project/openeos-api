import 'reflect-metadata';

/**
 * Mail- und Rechnungsdienst brauchen einander: der Rechnungsdienst
 * verschickt Mails, die Mail fuer die Rechnung nennt den § 19-Hinweis.
 * Liegt der Hinweis im Rechnungsdienst, entsteht ein Importkreis, und je
 * nach Ladereihenfolge ist EmailService beim Dekorieren von
 * StripeInvoiceService noch undefined — Nest startet dann nicht
 * ("Nest can't resolve dependencies ... index [7]"). Unit-Tests mit
 * direkt konstruierten Diensten merken davon nichts; dieser hier laedt in
 * der Reihenfolge des Starts.
 */
describe('StripeInvoiceService imports', () => {
  it('has every constructor dependency defined when the mail service loads first', () => {
    jest.isolateModules(() => {
      // Reihenfolge wie beim Start: das Mail-Modul kommt vor dem Events-Modul.
      require('../email/email.service');
      const { StripeInvoiceService } = require('./stripe-invoice.service') as {
        StripeInvoiceService: new (...args: unknown[]) => unknown;
      };
      const params = Reflect.getMetadata(
        'design:paramtypes',
        StripeInvoiceService,
      ) as unknown[];
      expect(params).toHaveLength(11);
      /* Ein Importkreis macht den Typ beim Dekorieren zu undefined; der
         TypeScript-Emit ersetzt ihn dann durch Object — und Object kann
         Nest nicht injizieren. */
      expect(params.map((p) => (p as { name?: string })?.name)).not.toContain(
        'Object',
      );
      expect((params[7] as { name?: string })?.name).toBe('EmailService');
    });
  });
});
