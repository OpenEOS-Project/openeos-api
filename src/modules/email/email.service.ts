import { Injectable, Logger } from '@nestjs/common';
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
    this.fromAddress = `OpenEOS <${fromEmail}>`;
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
    const html = this.getBaseTemplate(`
      <h1>Hallo ${options.firstName}!</h1>
      <p>Vielen Dank für deine Registrierung bei OpenEOS. Bitte bestätige deine E-Mail-Adresse, indem du auf den folgenden Button klickst:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${options.verifyUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
          E-Mail-Adresse bestätigen
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>
        <a href="${options.verifyUrl}" style="color: #2563eb;">${options.verifyUrl}</a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Der Link ist 24 Stunden gültig. Falls du dich nicht registriert hast, kannst du diese E-Mail ignorieren.
      </p>
    `);

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendPasswordResetEmail(options: {
    to: string;
    firstName: string;
    resetUrl: string;
  }): Promise<boolean> {
    const subject = 'Passwort zurücksetzen';
    const html = this.getBaseTemplate(`
      <h1>Hallo ${options.firstName}!</h1>
      <p>Du hast angefordert, dein Passwort bei OpenEOS zurückzusetzen. Klicke auf den folgenden Button, um ein neues Passwort zu vergeben:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${options.resetUrl}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
          Neues Passwort vergeben
        </a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>
        <a href="${options.resetUrl}" style="color: #2563eb;">${options.resetUrl}</a>
      </p>
      <p style="color: #666; font-size: 14px;">
        Der Link ist 1 Stunde gültig. Falls du kein neues Passwort angefordert hast, kannst du diese E-Mail ignorieren — dein Passwort bleibt unverändert.
      </p>
    `);

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
    const html = this.getBaseTemplate(`
      <h1>Neue Registrierung</h1>
      <p>Es hat sich soeben ein neuer Benutzer bei OpenEOS registriert:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 6px 0; color: #666;">Name:</td><td style="padding: 6px 0;"><strong>${options.name}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">E-Mail:</td><td style="padding: 6px 0;"><strong>${options.email}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Zeitpunkt:</td><td style="padding: 6px 0;"><strong>${timestamp}</strong></td></tr>
      </table>
    `);

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
    const html = this.getBaseTemplate(`
      <h1>Neue Organisation</h1>
      <p>Es wurde soeben eine neue Organisation bei OpenEOS angelegt:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 6px 0; color: #666;">Organisation:</td><td style="padding: 6px 0;"><strong>${options.organizationName}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Erstellt von:</td><td style="padding: 6px 0;"><strong>${options.creatorEmail}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Zeitpunkt:</td><td style="padding: 6px 0;"><strong>${timestamp}</strong></td></tr>
      </table>
    `);

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendAdminEventOrderedNotification(options: {
    to: string;
    organizationName: string;
    eventName: string;
    eventDate: Date | null;
    priceCharged: number;
    billingAddress: { name?: string; company?: string; street: string; zip: string; city: string; country: string };
  }): Promise<boolean> {
    const subject = 'Neue Veranstaltungs-Bestellung (auf Rechnung)';
    const dateLabel = options.eventDate
      ? options.eventDate.toLocaleDateString('de-DE', { dateStyle: 'medium' })
      : '–';
    const priceLabel = `${options.priceCharged.toFixed(2).replace('.', ',')} €`;
    const addr = options.billingAddress;
    const addressLine = [addr.company, addr.name, addr.street, `${addr.zip} ${addr.city}`, addr.country]
      .filter(Boolean)
      .join(', ');
    const html = this.getBaseTemplate(`
      <h1>Neue Veranstaltungs-Bestellung (auf Rechnung)</h1>
      <p>Eine Organisation hat soeben eine Veranstaltung auf Rechnung bestellt:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 6px 0; color: #666;">Organisation:</td><td style="padding: 6px 0;"><strong>${options.organizationName}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Veranstaltung:</td><td style="padding: 6px 0;"><strong>${options.eventName}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Datum:</td><td style="padding: 6px 0;"><strong>${dateLabel}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Preis:</td><td style="padding: 6px 0;"><strong>${priceLabel}</strong></td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Rechnungsadresse:</td><td style="padding: 6px 0;"><strong>${addressLine}</strong></td></tr>
      </table>
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
      <p style="background: #f5f5f5; border-radius: 6px; padding: 12px 16px; color: #333;">${options.preview}</p>
      <p style="color: #666; font-size: 14px;">Antworten kannst du im Super-Admin-Bereich unter Support oder direkt im Telegram-Topic der Organisation.</p>
    `);

    return this.sendEmail({ to: options.to, subject, html });
  }

  async sendAdminContactRequestNotification(options: {
    to: string;
    type: 'demo' | 'contact' | 'hardware' | 'gateway';
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

  private getBaseTemplate(content: string): string {
    // Always serve the logo from the public marketing site so the asset is
    // reachable from any email client, regardless of how/where this API is
    // deployed (otherwise a localhost APP_URL leaves a broken image).
    const logoUrl = 'https://openeos.de/logo_dark_trans.png';

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom: 24px;">
              <a href="${this.appUrl}" style="text-decoration: none;">
                <img src="${logoUrl}" alt="OpenEOS" height="36" style="height: 36px; width: auto;" />
              </a>
            </td>
          </tr>
          <!-- Content Card -->
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 32px 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 24px;">
              <p style="color: #a1a1aa; font-size: 12px; margin: 0;">
                Diese E-Mail wurde automatisch von OpenEOS gesendet.<br>
                Bitte antworte nicht direkt auf diese E-Mail.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }
}
