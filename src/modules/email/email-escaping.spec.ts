import { ConfigService } from '@nestjs/config';

import { ShiftRegistration } from '../../database/entities';
import { ShiftsService } from '../shifts/shifts.service';
import { EmailService } from './email.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

/** A value that would become markup if it were not escaped. */
const RAW = '<b data-x="1">Fest & Co</b>';
const ESCAPED = '&lt;b data-x=&quot;1&quot;&gt;Fest &amp; Co&lt;/b&gt;';

function setup() {
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new EmailService(config);
  const sendEmail = jest.spyOn(service, 'sendEmail').mockResolvedValue(true);
  const html = () => sendEmail.mock.calls[0][0].html ?? '';
  return { service, html };
}

type Case = [string, (s: EmailService) => Promise<boolean>, number];

/*
 * Every template that receives user-provided text, with that text set to
 * RAW. The number is how many places render it — each must be escaped.
 */
const cases: Case[] = [
  [
    'sendEmailVerificationEmail',
    (s) =>
      s.sendEmailVerificationEmail({
        to: 'a@b.de',
        firstName: RAW,
        verifyUrl: 'https://x',
      }),
    1,
  ],
  [
    'sendAdminRegistrationNotification',
    (s) =>
      s.sendAdminRegistrationNotification({
        to: 'a@b.de',
        name: RAW,
        email: 'c@d.de',
        registeredAt: new Date(0),
      }),
    2,
  ],
  [
    'sendAdminEventOrderedNotification',
    (s) =>
      s.sendAdminEventOrderedNotification({
        to: 'a@b.de',
        organizationName: RAW,
        eventName: RAW,
        eventDate: null,
        priceCharged: 10,
        paymentMethod: 'invoice',
        billingAddress: {
          name: RAW,
          street: 'Weg 1',
          zip: '1',
          city: 'X',
          country: 'DE',
        },
      }),
    3,
  ],
  [
    'sendAdminSupportMessageNotification',
    (s) =>
      s.sendAdminSupportMessageNotification({
        to: 'a@b.de',
        organizationName: RAW,
        senderName: RAW,
        preview: RAW,
        priority: false,
      }),
    3,
  ],
  [
    'sendAdminContactRequestNotification',
    (s) =>
      s.sendAdminContactRequestNotification({
        to: 'a@b.de',
        type: 'contact',
        name: RAW,
        email: RAW,
        organization: RAW,
        message: RAW,
      }),
    5,
  ],
  [
    'sendInvitationEmail',
    (s) => s.sendInvitationEmail('a@b.de', RAW, RAW, 'https://x', 'member'),
    2,
  ],
  [
    'sendShiftVerificationEmail',
    (s) => s.sendShiftVerificationEmail('a@b.de', RAW, RAW, '', 'https://x'),
    2,
  ],
  [
    'sendShopOrderConfirmationEmail',
    (s) =>
      s.sendShopOrderConfirmationEmail({
        to: 'a@b.de',
        name: RAW,
        organizationName: RAW,
        eventName: RAW,
        orderNumber: RAW,
        tableNumber: RAW,
        itemsHtml: '',
        totalFormatted: '1,00 €',
      }),
    5,
  ],
  [
    'sendShiftConfirmationEmail',
    (s) => s.sendShiftConfirmationEmail('a@b.de', RAW, RAW, ''),
    2,
  ],
  [
    'sendShiftRejectionEmail',
    (s) => s.sendShiftRejectionEmail('a@b.de', RAW, RAW, RAW),
    3,
  ],
  [
    'sendShiftReminderEmail',
    (s) =>
      s.sendShiftReminderEmail({
        to: 'a@b.de',
        helperName: RAW,
        planName: RAW,
        jobName: RAW,
        shiftDate: RAW,
        shiftTime: RAW,
      }),
    5,
  ],
  [
    'sendVerificationReminderEmail',
    (s) =>
      s.sendVerificationReminderEmail('a@b.de', RAW, RAW, 'https://x', 1, 3),
    2,
  ],
  [
    'sendHelperMagicLinkEmail',
    (s) => s.sendHelperMagicLinkEmail('a@b.de', RAW, RAW, 'https://x'),
    2,
  ],
  [
    'sendShiftChangeProposalEmail',
    (s) =>
      s.sendShiftChangeProposalEmail({
        to: 'a@b.de',
        name: RAW,
        shiftPlanName: RAW,
        removedShifts: [RAW],
        addedShifts: [RAW],
        message: RAW,
        acceptUrl: 'https://x',
        declineUrl: 'https://y',
      }),
    5,
  ],
  [
    'sendShiftMoveProposalEmail',
    (s) =>
      s.sendShiftMoveProposalEmail({
        to: 'a@b.de',
        name: RAW,
        shiftPlanName: RAW,
        oldShiftLine: RAW,
        newShiftLine: RAW,
        message: RAW,
        acceptUrl: 'https://x',
        declineUrl: 'https://y',
      }),
    5,
  ],
  [
    'sendShiftUpdatedEmail',
    (s) => s.sendShiftUpdatedEmail('a@b.de', RAW, RAW, '', '', RAW),
    3,
  ],
  [
    'sendShiftMessageEmail',
    (s) => s.sendShiftMessageEmail('a@b.de', RAW, RAW, RAW, RAW),
    4,
  ],
  [
    'sendShiftBroadcastEmail',
    (s) =>
      s.sendShiftBroadcastEmail({
        email: 'a@b.de',
        subject: 'Hallo',
        body: RAW,
        senderName: RAW,
      }),
    2,
  ],
];

describe('EmailService escapes user-provided text', () => {
  it.each(cases)('%s', async (_name, send, expected) => {
    const { service, html } = setup();

    await send(service);

    expect(html()).not.toContain(RAW);
    expect(html().split(ESCAPED).length - 1).toBe(expected);
  });
});

describe('ShiftsService.formatShiftsSummary', () => {
  it('escapes the job name in the HTML summary', () => {
    const none = {} as never;
    const service = new ShiftsService(none, none, none, none, none, none, none);
    const summary = (
      service as unknown as {
        formatShiftsSummary: (r: ShiftRegistration[]) => string;
      }
    ).formatShiftsSummary([
      {
        shift: {
          date: '2026-10-24',
          startTime: '10:00',
          endTime: '12:00',
          job: { name: RAW },
        },
      } as unknown as ShiftRegistration,
    ]);

    expect(summary).toContain(`<strong>${ESCAPED}</strong>`);
    expect(summary).not.toContain(RAW);
  });
});
