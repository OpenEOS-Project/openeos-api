import { Injectable, Logger } from '@nestjs/common';
import {
  absatz,
  codeBlock,
  datenblock,
  ersatzlink,
  escapeHtml,
  escapeHtmlMitUmbruechen,
  hinweis,
  knopf,
  rahmen,
  stapeln,
  ueberschrift,
  zitat,
} from './email-template';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}



@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private readonly isEnabled: boolean;
  private readonly fromAddress: string;
  readonly appUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.isEnabled = this.configService.get<boolean>('email.enabled') === true;
    const fromEmail = this.configService.get<string>('email.from') || 'noreply@openeos.de';
    const fromName = this.configService.get<string>('email.fromName') || 'OpenEOS';
    this.fromAddress = `${fromName} <${fromEmail}>`;
    // Public app URL — used for verify links, registration confirmations, etc.
    // Fallback points at the hosted production frontend so a missing env var
    // doesn't leave helpers staring at `http://localhost:3000` links.
    this.appUrl = this.configService.get<string>('APP_URL') || 'https://app.openeos.de';

    if (this.isEnabled) {
      this.initializeTransporter();
    } else {
      this.logger.warn('Email service is disabled. Set EMAIL_ENABLED=true to enable.');
    }
  }

  private initializeTransporter(): void {
    const host = this.configService.get<string>('email.host');
    const port = this.configService.get<number>('email.port') || 587;
    const user = this.configService.get<string>('email.user');
    const pass = this.configService.get<string>('email.password');

    if (!host || !user || !pass) {
      this.logger.error('Email configuration incomplete. Check EMAIL_HOST, EMAIL_USER, EMAIL_PASSWORD.');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
    });

    // Verify connection on startup
    this.transporter.verify((error) => {
      if (error) {
        this.logger.error(`Email transporter verification failed: ${error.message}`);
      } else {
        this.logger.log('Email transporter is ready');
      }
    });
  }

  async sendEmail(options: SendEmailOptions): Promise<boolean> {
    if (!this.isEnabled) {
      this.logger.debug(`[DEV] Would send email to ${options.to}: ${options.subject}`);
      this.logger.debug(`[DEV] Content: ${options.text || options.html.substring(0, 200)}...`);
      return true;
    }

    if (!this.transporter) {
      this.logger.error('Email transporter not initialized');
      return false;
    }

    try {
      const info = await this.transporter.sendMail({
        from: this.fromAddress,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || this.stripHtml(options.html),
      });

      this.logger.log(`Email sent to ${options.to}: ${info.messageId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send email to ${options.to}: ${error.message}`);
      return false;
    }
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ============ Registration / Email Verification Templates ============

  async sendEmailVerificationEmail(options: {
    to: string;
    firstName: string;
    verifyUrl: string;
  }): Promise<boolean> {
    const subject = 'Bitte bestätige deine E-Mail-Adresse';
    const html = rahmen({
      kontext: 'Konto aktivieren',
      titel: 'OpenEOS — E-Mail bestätigen',
      preheader: 'Ein Klick, und dein OpenEOS-Konto ist einsatzbereit. Der Link gilt 24 Stunden.',
      empfaenger: options.to,
      appUrl: this.appUrl,
      inhalt: stapeln(
        ueberschrift(`Willkommen, ${options.firstName}.`) +
          absatz('Bestätige deine Adresse, dann steht dein Konto bereit.'),
        knopf(options.verifyUrl, 'E-Mail-Adresse bestätigen'),
        ersatzlink(options.verifyUrl),
        hinweis(
          'Nicht angefordert?',
          'Dann ignoriere diese Mail — ohne Bestätigung entsteht kein Konto. Der Link gilt 24 Stunden.',
        ),
      ),
    });

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendPasswordResetEmail(options: {
    to: string;
    firstName: string;
    resetUrl: string;
  }): Promise<boolean> {
    const subject = 'Passwort zurücksetzen';
    const html = rahmen({
      kontext: 'Passwort',
      titel: 'OpenEOS — Passwort zurücksetzen',
      preheader: 'Neues Passwort vergeben. Der Link gilt eine Stunde und funktioniert einmal.',
      empfaenger: options.to,
      appUrl: this.appUrl,
      inhalt: stapeln(
        ueberschrift('Neues Passwort vergeben.') +
          absatz(`Hallo ${options.firstName}, über diesen Link setzt du ein neues Passwort.`),
        knopf(options.resetUrl, 'Neues Passwort vergeben'),
        ersatzlink(options.resetUrl),
        hinweis(
          'Das warst du nicht?',
          'Dann ignoriere diese Mail — dein bisheriges Passwort bleibt unverändert. Der Link gilt eine Stunde.',
        ),
      ),
    });

    return this.sendEmail({ to: options.to, subject, html });
  }

  /**
   * Anmeldelink statt Passwort.
   *
   * Der Link steht auch im Klartext darunter: manche Postfaecher zeigen
   * kein HTML, und ein Anmeldeweg, den man nicht kopieren kann, ist fuer
   * diese Leute keiner.
   */
  async sendLoginMagicLinkEmail(options: {
    to: string;
    firstName: string;
    loginUrl: string;
    minutesValid: number;
  }): Promise<boolean> {
    const subject = 'Dein Anmeldelink für OpenEOS';
    const html = rahmen({
      kontext: 'Anmeldung',
      titel: 'OpenEOS — Dein Anmeldelink',
      preheader: `Ein Klick und du bist drin — ohne Passwort. Der Link gilt ${options.minutesValid} Minuten.`,
      empfaenger: options.to,
      appUrl: this.appUrl,
      inhalt: stapeln(
        ueberschrift('Hier ist dein Anmeldelink.') +
          absatz(
            `Hallo ${options.firstName}, ein Klick und du bist im OpenEOS-Admin — ganz ohne Passwort. Der Link funktioniert einmal und gilt ${options.minutesValid} Minuten.`,
          ),
        knopf(options.loginUrl, 'Jetzt anmelden'),
        ersatzlink(options.loginUrl),
        hinweis(
          'Das warst du nicht?',
          'Dann ignoriere diese Mail — ohne Klick passiert nichts.',
        ),
      ),
    });

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendTwoFactorOtpEmail(options: {
    to: string;
    code: string;
    /** Purpose-specific copy — kept generic to avoid importing EmailOtpPurpose into this module. */
    context: 'setup' | 'login';
  }): Promise<boolean> {
    const subject =
      options.context === 'setup'
        ? 'Bestätigungscode für die Einrichtung der Zwei-Faktor-Authentifizierung'
        : 'Dein Anmeldecode für OpenEOS';
    const intro =
      options.context === 'setup'
        ? 'Verwende den folgenden Code, um die E-Mail-Zwei-Faktor-Authentifizierung für dein Konto einzurichten:'
        : 'Verwende den folgenden Code, um dich bei OpenEOS anzumelden:';
    const html = rahmen({
      kontext: 'Bestätigungscode',
      titel: 'OpenEOS — Bestätigungscode',
      preheader: `Dein Code: ${options.code}. Gültig für 5 Minuten.`,
      empfaenger: options.to,
      appUrl: this.appUrl,
      inhalt: stapeln(
        ueberschrift('Dein Bestätigungscode.') + absatz(intro),
        codeBlock(options.code),
        hinweis(
          'Nicht angefordert?',
          'Dann ignoriere diese Mail. Ohne diesen Code kommt niemand hinein. Der Code gilt 5 Minuten.',
        ),
      ),
    });

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendAdminRegistrationNotification(options: {
    to: string;
    name: string;
    email: string;
    registeredAt: Date;
  }): Promise<boolean> {
    const subject = 'Neue Registrierung bei OpenEOS';
    const timestamp = options.registeredAt.toLocaleString('de-DE', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const html = rahmen({
      kontext: 'Neues Konto',
      titel: 'OpenEOS — Neue Registrierung',
      preheader: `${options.name} hat sich registriert.`,
      appUrl: this.appUrl,
      inhalt: stapeln(
        ueberschrift('Neue Registrierung.') +
          absatz('Jemand hat sich gerade ein OpenEOS-Konto angelegt.'),
        datenblock('Konto', [
          ['Name', options.name],
          ['E-Mail', options.email],
          ['Zeitpunkt', timestamp],
        ]),
        knopf(`${this.appUrl}/admin/users`, 'Im Adminbereich ansehen'),
      ),
    });

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendAdminOrganizationCreatedNotification(options: {
    to: string;
    organizationName: string;
    creatorEmail: string;
    createdAt: Date;
  }): Promise<boolean> {
    const subject = 'Neue Organisation bei OpenEOS';
    const timestamp = options.createdAt.toLocaleString('de-DE', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const html = rahmen({
      kontext: 'Neue Organisation',
      titel: 'OpenEOS — Neue Organisation',
      preheader: `${options.organizationName} wurde angelegt.`,
      appUrl: this.appUrl,
      inhalt: stapeln(
        ueberschrift('Neue Organisation.') +
          absatz('Es wurde gerade eine Organisation angelegt.'),
        datenblock('Organisation', [
          ['Name', options.organizationName],
          ['Erstellt von', options.creatorEmail],
          ['Zeitpunkt', timestamp],
        ]),
        knopf(`${this.appUrl}/admin/organizations`, 'Im Adminbereich ansehen'),
      ),
    });

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendAdminEventOrderedNotification(options: {
    to: string;
    organizationName: string;
    eventName: string;
    eventDate: Date | null;
    priceCharged: number;
    paymentMethod: 'invoice' | 'stripe';
    billingAddress?: { name?: string; company?: string; street: string; zip: string; city: string; country: string };
  }): Promise<boolean> {
    const perRechnung = options.paymentMethod === 'invoice';
    const subject = perRechnung
      ? 'Neue Veranstaltungs-Bestellung (auf Rechnung)'
      : 'Veranstaltung bezahlt (Stripe)';
    const einleitung = perRechnung
      ? 'Eine Organisation hat soeben eine Veranstaltung auf Rechnung bestellt:'
      : 'Eine Organisation hat soeben eine Veranstaltung über Stripe bezahlt:';
    const dateLabel = options.eventDate
      ? options.eventDate.toLocaleDateString('de-DE', { dateStyle: 'medium' })
      : '–';
    const priceLabel = `${options.priceCharged.toFixed(2).replace('.', ',')} €`;
    const addr = options.billingAddress;
    const addressLine = addr
      ? [addr.company, addr.name, addr.street, `${addr.zip} ${addr.city}`, addr.country]
          .filter((teil) => teil && teil.trim())
          .join(', ')
      : '';
    const addressRow = addressLine
      ? `<tr><td style="padding: 6px 0; color: #666;">Rechnungsadresse:</td><td style="padding: 6px 0;"><strong>${addressLine}</strong></td></tr>`
      : '';
    const html = this.getBaseTemplate(`
      <h1>${subject}</h1>
      <p>${einleitung}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 6px 0; color: #666;">Organisation:</td><td style="padding: 6px 0;"><strong>${options.organizationName}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Veranstaltung:</td><td style="padding: 6px 0;"><strong>${options.eventName}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Datum:</td><td style="padding: 6px 0;"><strong>${dateLabel}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Preis:</td><td style="padding: 6px 0;"><strong>${priceLabel}</strong></td></tr>
        ${addressRow}
      </table>
    `);

    return this.sendEmail({ to: options.to, subject, html });
  }

  /**
   * Antwort des Supports an den Fragesteller.
   *
   * Bis hierher lief die Benachrichtigung nur in eine Richtung: wer eine
   * Anfrage schrieb, loeste eine Mail an den Support aus — die Antwort
   * darauf erreichte niemanden. Der Fragesteller sah sie nur, wenn er von
   * sich aus den Chat oeffnete. Ein Kunde hat auf diese Weise zwei
   * Antworten nie zu Gesicht bekommen.
   *
   * Bewusst nur ein Auszug und ein Link statt der ganzen Antwort: der
   * Verlauf gehoert in den Chat, wo er vollstaendig steht und
   * weitergeschrieben werden kann.
   */
  async sendSupportReplyNotification(options: {
    to: string;
    recipientName: string;
    preview: string;
  }): Promise<boolean> {
    const subject = 'Antwort auf Ihre Support-Anfrage';
    const html = this.getBaseTemplate(`
      <h1>Wir haben geantwortet</h1>
      <p>Hallo ${escapeHtml(options.recipientName)},</p>
      <p>auf Ihre Support-Anfrage gibt es eine Antwort:</p>
      <p style="background: #f5f5f5; border-radius: 6px; padding: 12px 16px; color: #333;">${escapeHtmlMitUmbruechen(options.preview)}</p>
      <p style="margin: 24px 0;">
        <a href="${this.appUrl}/support" style="background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Antwort im Support-Chat lesen</a>
      </p>
      <p style="color: #666; font-size: 14px;">Dort können Sie direkt zurückschreiben.</p>
    `);

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendAdminSupportMessageNotification(options: {
    to: string;
    organizationName: string;
    senderName: string;
    preview: string;
    priority: boolean;
  }): Promise<boolean> {
    const subject = `${options.priority ? '🚨 ' : ''}Neue Support-Anfrage: ${options.organizationName}`;
    const html = this.getBaseTemplate(`
      <h1>Neue Support-Anfrage${options.priority ? ' (Priority)' : ''}</h1>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 6px 0; color: #666;">Organisation:</td><td style="padding: 6px 0;"><strong>${options.organizationName}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Von:</td><td style="padding: 6px 0;"><strong>${options.senderName}</strong></td></tr>
      </table>
      <p style="background: #f5f5f5; border-radius: 6px; padding: 12px 16px; color: #333;">${escapeHtml(options.preview)}</p>
      <p style="color: #666; font-size: 14px;">Antworten kannst du im Super-Admin-Bereich unter Support oder direkt im Telegram-Topic der Organisation.</p>
    `);

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendAdminContactRequestNotification(options: {
    to: string;
    type: 'demo' | 'contact' | 'hardware' | 'gateway' | 'feedback' | 'feature';
    name: string;
    email: string;
    organization?: string;
    message: string;
  }): Promise<boolean> {
    const typeLabels: Record<typeof options.type, string> = {
      demo: 'Demo-Anfrage',
      contact: 'Kontaktanfrage',
      hardware: 'Hardware-Miete',
      gateway: 'Kassen-Gateway',
      feedback: 'Rückmeldung',
      feature: 'Funktionswunsch',
    };
    const typeLabel = typeLabels[options.type];
    const subject = `Neue ${typeLabel} über die Website`;
    const html = this.getBaseTemplate(`
      <h1>Neue ${typeLabel}</h1>
      <p style="background: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 10px 14px; color: #92400e; font-weight: 600;">
        🌐 Website-Anfrage — NICHT authentifiziert
      </p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 6px 0; color: #666;">Typ:</td><td style="padding: 6px 0;"><strong>${typeLabel}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Name:</td><td style="padding: 6px 0;"><strong>${options.name}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">E-Mail:</td><td style="padding: 6px 0;"><strong><a href="mailto:${options.email}" style="color: #2563eb;">${options.email}</a></strong></td></tr>
        ${options.organization ? `<tr><td style="padding: 6px 0; color: #666;">Organisation:</td><td style="padding: 6px 0;"><strong>${options.organization}</strong></td></tr>` : ''}
      </table>
      <p style="background: #f5f5f5; border-radius: 6px; padding: 12px 16px; color: #333; white-space: pre-wrap;">${options.message}</p>
    `);

    return this.sendEmail({ to: options.to, subject, html });
  }

  // ============ Organization Invitation Email Templates ============

  async sendInvitationEmail(
    email: string,
    organizationName: string,
    inviterName: string,
    acceptUrl: string,
    role: string,
  ): Promise<boolean> {
    const roleLabel = role === 'admin' ? 'Administrator' : 'Mitglied';
    const subject = `Einladung: ${organizationName}`;
    const html = this.getBaseTemplate(`
      <h1>Sie wurden eingeladen!</h1>
      <p><strong>${inviterName}</strong> hat Sie als <strong>${roleLabel}</strong> zur Organisation <strong>${organizationName}</strong> eingeladen.</p>
      <p>Klicken Sie auf den folgenden Button, um die Einladung anzunehmen:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${acceptUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
          Einladung annehmen
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>
        <a href="${acceptUrl}" style="color: #2563eb;">${acceptUrl}</a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Die Einladung ist 7 Tage gültig. Falls Sie diese Einladung nicht erwartet haben, können Sie sie ignorieren.
      </p>
    `);

    return this.sendEmail({ to: email, subject, html });
  }

  // ============ Shift Registration Email Templates ============

  async sendShiftVerificationEmail(
    email: string,
    name: string,
    shiftPlanName: string,
    shiftsSummary: string,
    verifyUrl: string,
  ): Promise<boolean> {
    const subject = `Bitte bestätige deine Anmeldung: ${shiftPlanName}`;
    const html = this.getBaseTemplate(`
      <h1>Hallo ${name}!</h1>
      <p>Vielen Dank für deine Anmeldung zum <strong>${shiftPlanName}</strong>.</p>
      <p>Du hast dich für folgende Schichten angemeldet:</p>
      <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
        ${shiftsSummary}
      </div>
      <p>Bitte bestätige deine E-Mail-Adresse, indem du auf den folgenden Button klickst:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${verifyUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
          E-Mail bestätigen
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>
        <a href="${verifyUrl}" style="color: #2563eb;">${verifyUrl}</a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Nach der Bestätigung wird deine Anmeldung geprüft und du erhältst eine weitere E-Mail.
      </p>
    `);

    return this.sendEmail({ to: email, subject, html });
  }

  async sendShopOrderConfirmationEmail(options: {
    to: string;
    name: string;
    organizationName: string;
    eventName: string;
    orderNumber: string;
    tableNumber?: string | null;
    itemsHtml: string;
    totalFormatted: string;
  }): Promise<boolean> {
    const subject = `Bestellbestätigung ${options.orderNumber} – ${options.eventName}`;
    const html = this.getBaseTemplate(`
      <h1>Vielen Dank für deine Bestellung${options.name ? `, ${options.name}` : ''}!</h1>
      <p>
        Deine Zahlung ist eingegangen und die Bestellung
        <strong>${options.orderNumber}</strong> bei
        <strong>${options.organizationName}</strong> (${options.eventName}) wurde aufgenommen.
      </p>
      ${options.tableNumber ? `<p>Tisch: <strong>${options.tableNumber}</strong></p>` : ''}
      <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
        ${options.itemsHtml}
      </div>
      <p style="font-size: 16px;">
        <strong>Gesamtbetrag: ${options.totalFormatted}</strong><br>
        <span style="color: #666; font-size: 13px;">bezahlt per SumUp Online-Zahlung</span>
      </p>
      <p style="color: #666; font-size: 14px;">
        Diese E-Mail ist deine Bestellbestätigung und gilt als Zahlungsbeleg.
      </p>
    `);

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendShiftConfirmationEmail(
    email: string,
    name: string,
    shiftPlanName: string,
    shiftsSummary: string,
  ): Promise<boolean> {
    const subject = `Deine Schicht wurde bestätigt: ${shiftPlanName}`;
    const html = this.getBaseTemplate(`
      <h1>Hallo ${name}!</h1>
      <p>Gute Nachrichten! Deine Anmeldung zum <strong>${shiftPlanName}</strong> wurde bestätigt.</p>
      <p>Du bist für folgende Schichten eingeteilt:</p>
      <div style="background: #d1fae5; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #10b981;">
        ${shiftsSummary}
      </div>
      <p>Wir freuen uns auf dich!</p>
    `);

    return this.sendEmail({ to: email, subject, html });
  }

  async sendShiftRejectionEmail(
    email: string,
    name: string,
    shiftPlanName: string,
    reason?: string,
  ): Promise<boolean> {
    const subject = `Absage: ${shiftPlanName}`;
    const html = this.getBaseTemplate(`
      <h1>Hallo ${name},</h1>
      <p>Leider müssen wir dir mitteilen, dass deine Anmeldung zum <strong>${shiftPlanName}</strong> nicht berücksichtigt werden konnte.</p>
      ${reason ? `<p><strong>Grund:</strong> ${reason}</p>` : ''}
      <p>Bei Fragen kannst du dich gerne an die Organisatoren wenden.</p>
    `);

    return this.sendEmail({ to: email, subject, html });
  }

  async sendShiftReminderEmail(options: {
    to: string;
    helperName: string;
    planName: string;
    jobName: string;
    shiftDate: string;
    shiftTime: string;
  }): Promise<boolean> {
    const subject = `Erinnerung: Deine Schicht bei ${options.planName}`;
    const html = this.getBaseTemplate(`
      <h1>Hallo ${options.helperName}!</h1>
      <p>Dies ist eine freundliche Erinnerung an deine Schicht bei <strong>${options.planName}</strong>.</p>
      <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
        <p style="margin: 0;"><strong>${options.jobName}</strong></p>
        <p style="margin: 5px 0 0 0;">${options.shiftDate}</p>
        <p style="margin: 5px 0 0 0;">${options.shiftTime}</p>
      </div>
      <p>Wir freuen uns auf dich!</p>
    `);

    return this.sendEmail({ to: options.to, subject, html });
  }

  /** Multi-op proposal email: lists removed + added shifts with accept/decline
   *  buttons that link to the public response page. */
  /** Magic-link email that lets a helper open a token-based session and
   *  manage their own shifts in a plan without an account. */
  /** Sent on a schedule to helpers who haven't clicked their verification
   *  link yet — gentle nudge with the link re-attached. */
  async sendVerificationReminderEmail(
    email: string,
    name: string,
    shiftPlanName: string,
    verifyUrl: string,
    attempt: number,
    maxAttempts: number,
  ): Promise<boolean> {
    const subject = `Erinnerung: Bestätige deine Schichten — ${shiftPlanName}`;
    const html = this.getBaseTemplate(`
      <h1>Hallo ${name}!</h1>
      <p>Du hast dich für Schichten im Plan <strong>${shiftPlanName}</strong> angemeldet, aber deine E-Mail-Adresse noch nicht bestätigt.</p>
      <p>Damit deine Anmeldung gültig wird, klick bitte einmal auf den Bestätigungs-Link unten:</p>
      <div style="margin: 24px 0; text-align: center;">
        <a href="${verifyUrl}" style="display: inline-block; padding: 12px 24px; background: #10b981; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">E-Mail bestätigen</a>
      </div>
      <p style="color: #666; font-size: 13px;">Erinnerung ${attempt} von ${maxAttempts}. Wenn du dich doch nicht eintragen möchtest, ignorier diese Mail einfach.</p>
    `);
    return this.sendEmail({ to: email, subject, html });
  }

  async sendHelperMagicLinkEmail(
    email: string,
    name: string,
    planName: string,
    manageUrl: string,
  ): Promise<boolean> {
    const subject = `Schichten verwalten: ${planName}`;
    const html = this.getBaseTemplate(`
      <h1>Hallo${name ? ` ${name}` : ''}!</h1>
      <p>Du hast einen Link zum Verwalten deiner Schichten im Plan <strong>${planName}</strong> angefordert.</p>
      <div style="margin: 24px 0; text-align: center;">
        <a href="${manageUrl}" style="display: inline-block; padding: 12px 24px; background: #10b981; color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">Meine Schichten öffnen</a>
      </div>
      <p style="color: #666; font-size: 13px;">Der Link ist 24 Stunden gültig. Falls du den Link nicht angefordert hast, kannst du diese Mail ignorieren.</p>
    `);
    return this.sendEmail({ to: email, subject, html });
  }

  async sendShiftChangeProposalEmail(options: {
    to: string;
    name: string;
    shiftPlanName: string;
    removedShifts: string[];
    addedShifts: string[];
    message?: string;
    acceptUrl: string;
    declineUrl: string;
  }): Promise<boolean> {
    const subject = `Schichtvorschlag: ${options.shiftPlanName}`;
    const removedBlock = options.removedShifts.length
      ? `<table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
          <tr><td style="padding: 12px; background: #fee2e2; border-left: 4px solid #dc2626;">
            <div style="font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: .04em;">Wird entfernt</div>
            <ul style="margin: 6px 0 0; padding-left: 18px;">${options.removedShifts.map((l) => `<li>${l}</li>`).join('')}</ul>
          </td></tr>
        </table>`
      : '';
    const addedBlock = options.addedShifts.length
      ? `<table style="width: 100%; border-collapse: collapse; margin: 12px 0;">
          <tr><td style="padding: 12px; background: #d1fae5; border-left: 4px solid #10b981;">
            <div style="font-size: 12px; color: #065f46; text-transform: uppercase; letter-spacing: .04em;">Wird hinzugefügt</div>
            <ul style="margin: 6px 0 0; padding-left: 18px;">${options.addedShifts.map((l) => `<li>${l}</li>`).join('')}</ul>
          </td></tr>
        </table>`
      : '';
    const html = this.getBaseTemplate(`
      <h1>Hallo ${options.name}!</h1>
      <p>Die Organisation möchte deine Schichten im Plan <strong>${options.shiftPlanName}</strong> ändern.</p>
      ${removedBlock}
      ${addedBlock}
      ${options.message ? `<p><strong>Nachricht:</strong></p><div style="background: #eff6ff; padding: 12px; border-radius: 6px; border-left: 4px solid #3b82f6; white-space: pre-wrap;">${options.message}</div>` : ''}
      <div style="margin: 24px 0; text-align: center;">
        <a href="${options.acceptUrl}" style="display: inline-block; padding: 12px 24px; background: #10b981; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; margin-right: 8px;">✓ Annehmen</a>
        <a href="${options.declineUrl}" style="display: inline-block; padding: 12px 24px; background: #f3f4f6; color: #374151; text-decoration: none; border-radius: 8px; font-weight: 600;">✗ Ablehnen</a>
      </div>
      <p style="color: #666; font-size: 13px;">Klick einfach auf einen der Buttons. Bei Fragen melde dich bei den Organisatoren.</p>
    `);
    return this.sendEmail({ to: options.to, subject, html });
  }

  /** @deprecated Single-shift propose — kept only so old call sites don't
   *  break during refactor. New code should use sendShiftChangeProposalEmail. */
  async sendShiftMoveProposalEmail(options: {
    to: string;
    name: string;
    shiftPlanName: string;
    oldShiftLine: string;
    newShiftLine: string;
    message?: string;
    acceptUrl: string;
    declineUrl: string;
  }): Promise<boolean> {
    const subject = `Schichtvorschlag: ${options.shiftPlanName}`;
    const html = this.getBaseTemplate(`
      <h1>Hallo ${options.name}!</h1>
      <p>Die Organisation möchte deine Schicht im Plan <strong>${options.shiftPlanName}</strong> verschieben.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 12px; background: #fee2e2; border-left: 4px solid #dc2626;">
          <div style="font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: .04em;">Bisher</div>
          <div style="margin-top: 4px;">${options.oldShiftLine}</div>
        </td></tr>
        <tr><td style="height: 8px;"></td></tr>
        <tr><td style="padding: 12px; background: #d1fae5; border-left: 4px solid #10b981;">
          <div style="font-size: 12px; color: #065f46; text-transform: uppercase; letter-spacing: .04em;">Vorgeschlagen</div>
          <div style="margin-top: 4px;">${options.newShiftLine}</div>
        </td></tr>
      </table>
      ${options.message ? `<p><strong>Nachricht:</strong></p><div style="background: #eff6ff; padding: 12px; border-radius: 6px; border-left: 4px solid #3b82f6; white-space: pre-wrap;">${options.message}</div>` : ''}
      <div style="margin: 24px 0; text-align: center;">
        <a href="${options.acceptUrl}" style="display: inline-block; padding: 12px 24px; background: #10b981; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; margin-right: 8px;">✓ Annehmen</a>
        <a href="${options.declineUrl}" style="display: inline-block; padding: 12px 24px; background: #f3f4f6; color: #374151; text-decoration: none; border-radius: 8px; font-weight: 600;">✗ Ablehnen</a>
      </div>
      <p style="color: #666; font-size: 13px;">Klick einfach auf einen der Buttons. Bei Fragen melde dich bei den Organisatoren.</p>
    `);
    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendShiftUpdatedEmail(
    email: string,
    name: string,
    shiftPlanName: string,
    oldShiftLine: string,
    newShiftLine: string,
    note?: string,
  ): Promise<boolean> {
    const subject = `Schicht aktualisiert: ${shiftPlanName}`;
    const html = this.getBaseTemplate(`
      <h1>Hallo ${name}!</h1>
      <p>Deine Einteilung im Schichtplan <strong>${shiftPlanName}</strong> wurde aktualisiert.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr>
          <td style="padding: 12px; background: #fee2e2; border-left: 4px solid #dc2626; border-radius: 6px 0 0 6px;">
            <div style="font-size: 12px; color: #991b1b; text-transform: uppercase; letter-spacing: .04em;">Vorher</div>
            <div style="margin-top: 4px;">${oldShiftLine}</div>
          </td>
        </tr>
        <tr><td style="height: 8px;"></td></tr>
        <tr>
          <td style="padding: 12px; background: #d1fae5; border-left: 4px solid #10b981; border-radius: 6px 0 0 6px;">
            <div style="font-size: 12px; color: #065f46; text-transform: uppercase; letter-spacing: .04em;">Jetzt</div>
            <div style="margin-top: 4px;">${newShiftLine}</div>
          </td>
        </tr>
      </table>
      ${note ? `<p><strong>Hinweis:</strong></p><div style="background: #eff6ff; padding: 12px; border-radius: 6px; border-left: 4px solid #3b82f6; white-space: pre-wrap;">${note}</div>` : ''}
      <p>Bei Fragen melde dich gerne bei den Organisatoren.</p>
    `);

    return this.sendEmail({ to: email, subject, html });
  }

  async sendShiftMessageEmail(
    email: string,
    name: string,
    shiftPlanName: string,
    message: string,
    senderName: string,
  ): Promise<boolean> {
    const subject = `Nachricht zu: ${shiftPlanName}`;
    const html = this.getBaseTemplate(`
      <h1>Hallo ${name}!</h1>
      <p>Du hast eine Nachricht bezüglich <strong>${shiftPlanName}</strong> erhalten:</p>
      <div style="background: #eff6ff; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3b82f6;">
        <p style="white-space: pre-wrap;">${message}</p>
      </div>
      <p style="color: #666; font-size: 14px;">Gesendet von: ${senderName}</p>
    `);

    return this.sendEmail({ to: email, subject, html });
  }

  /** Free-form broadcast to a helper. Unlike sendShiftMessageEmail this does
   *  NOT prepend a "Hallo {name}" greeting or boilerplate — the admin controls
   *  the whole body via placeholders ({{name}}, {{plan}}, {{schichten}}), so we
   *  render it verbatim (HTML-escaped, newlines preserved). */
  async sendShiftBroadcastEmail(opts: {
    email: string;
    subject: string;
    body: string;
    senderName: string;
  }): Promise<boolean> {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = this.getBaseTemplate(`
      <div style="white-space: pre-wrap; font-size: 15px; color: #333;">${esc(opts.body)}</div>
      <p style="color: #a1a1aa; font-size: 13px; margin-top: 28px;">Gesendet von ${esc(opts.senderName)}</p>
    `);
    return this.sendEmail({ to: opts.email, subject: opts.subject, html });
  }

  /**
   * Übergangsweg für Mails, die noch altes Markup mitbringen.
   *
   * Die Vorlagen sind auf Bausteine umgestellt (siehe email-template.ts).
   * Siebzehn Mails — überwiegend rund um Schichtpläne — reichen ihren
   * Inhalt noch als HTML-Schnipsel herein. Statt sie aussehen zu lassen
   * wie vorher, während der Rest neu aussieht, übersetzt diese Funktion
   * die immer gleichen alten Muster auf die neue Typografie und setzt
   * sie in den neuen Rahmen.
   *
   * Das ist ausdrücklich eine Brücke, keine Lösung: Wer eine dieser
   * Mails anfasst, stellt sie bitte auf `rahmen()` und die Bausteine um
   * und nimmt sie damit aus diesem Weg heraus.
   */
  private getBaseTemplate(content: string, kontext = 'Benachrichtigung'): string {
    const angepasst = content
      // Überschrift
      .replace(
        /<h1[^>]*>([\s\S]*?)<\/h1>/g,
        '<h1 style="margin:0 0 12px;font-family:Arial, Helvetica, sans-serif;font-size:30px;line-height:1.1;font-weight:bold;letter-spacing:-0.9px;color:#14180f">$1</h1>',
      )
      // Der blaue Knopf aus der alten Vorlage
      .replace(
        /background:\s*#2563eb;\s*color:\s*white;\s*padding:[^;]+;\s*border-radius:[^;]+;\s*text-decoration:\s*none;\s*font-weight:\s*600;?/g,
        'background:#14180f;color:#f5f2ea;padding:11px 18px;border-radius:6px;text-decoration:none;font-weight:bold;font-family:Arial, Helvetica, sans-serif;font-size:14px;display:inline-block',
      )
      // Links in der alten Akzentfarbe
      .replace(/color:\s*#2563eb/g, 'color:#1e5433')
      // Kleingedrucktes
      .replace(
        /<p style="color:\s*#666;\s*font-size:\s*14px;">/g,
        '<p style="margin:0 0 12px;font-family:Arial, Helvetica, sans-serif;font-size:13px;line-height:1.6;color:#6b7068">',
      )
      // Fließtext ohne eigene Stile
      .replace(
        /<p>/g,
        '<p style="margin:0 0 14px;font-family:Arial, Helvetica, sans-serif;font-size:16px;line-height:1.55;color:#6b7068">',
      )
      // Label-Spalten der alten Datentabellen
      .replace(
        /<td style="padding:\s*6px 0;\s*color:\s*#666;">/g,
        '<td width="150" style="width:150px;padding:9px 12px 9px 0;font-family:\'Courier New\', Courier, monospace;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#6b7068;border-bottom:1px solid #e3ded1">',
      )
      .replace(
        /<td style="padding:\s*6px 0;">/g,
        '<td style="padding:9px 0;font-family:Arial, Helvetica, sans-serif;font-size:15px;font-weight:bold;color:#14180f;border-bottom:1px solid #e3ded1">',
      );

    return rahmen({
      kontext,
      preheader: '',
      appUrl: this.appUrl,
      inhalt: angepasst,
    });
  }
}
