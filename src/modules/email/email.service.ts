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

  constructor(private readonly configService: ConfigService) {
    this.isEnabled = this.configService.get<string>('EMAIL_ENABLED') === 'true';
    this.fromAddress = this.configService.get<string>('EMAIL_FROM') || 'noreply@openeos.de';

    if (this.isEnabled) {
      this.initializeTransporter();
    } else {
      this.logger.warn('Email service is disabled. Set EMAIL_ENABLED=true to enable.');
    }
  }

  private initializeTransporter(): void {
    const host = this.configService.get<string>('EMAIL_HOST');
    const port = this.configService.get<number>('EMAIL_PORT') || 587;
    const user = this.configService.get<string>('EMAIL_USER');
    const pass = this.configService.get<string>('EMAIL_PASSWORD');

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
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${content}
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px; text-align: center;">
    Diese E-Mail wurde automatisch von OpenEOS gesendet.<br>
    Bitte antworte nicht direkt auf diese E-Mail.
  </p>
</body>
</html>
    `.trim();
  }
}
