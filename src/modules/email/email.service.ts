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
  private readonly appUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.isEnabled = this.configService.get<boolean>('email.enabled') === true;
    const fromEmail = this.configService.get<string>('email.from') || 'noreply@openeos.de';
    this.fromAddress = `OpenEOS <${fromEmail}>`;
    this.appUrl = this.configService.get<string>('APP_URL') || 'http://localhost:3000';

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

  private getBaseTemplate(content: string): string {
    const logoUrl = `${this.appUrl}/logo_dark.png`;

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
