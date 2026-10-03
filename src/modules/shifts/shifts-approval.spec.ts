import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import {
  ShiftRegistration,
  ShiftRegistrationStatus,
  User,
} from '../../database/entities';
import { EmailService } from '../email/email.service';
import { ShiftsService } from './shifts.service';

jest.mock('uuid', () => ({
  v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID(),
}));

function registration(): ShiftRegistration {
  return {
    id: 'reg-1',
    registrationGroupId: 'group-1',
    name: 'Erika',
    email: 'erika@example.org',
    status: ShiftRegistrationStatus.PENDING_APPROVAL,
    shift: {
      startTime: '10:00',
      endTime: '12:00',
      date: '2026-10-24',
      job: {
        name: 'Theke',
        shiftPlan: { name: 'Sommerfest', organizationId: 'org-1' },
      },
    },
  } as unknown as ShiftRegistration;
}

const admin = {
  id: 'user-1',
  firstName: 'Max',
  lastName: 'Muster',
  email: 'max@example.org',
} as User;

describe('ShiftsService.approveRegistration', () => {
  function setup() {
    const reg = registration();
    const registrationRepository = {
      findOne: jest.fn(() => Promise.resolve(reg)),
      find: jest.fn(() => Promise.resolve([reg])),
      save: jest.fn((r: ShiftRegistration) => Promise.resolve(r)),
    } as unknown as Repository<ShiftRegistration>;
    const sendShiftConfirmationEmail = jest.fn(() => Promise.resolve(true));
    const emailService = {
      sendShiftConfirmationEmail,
    } as unknown as EmailService;
    // approveRegistration only touches the registration repository.
    const none = {} as never;
    const service = new ShiftsService(
      none,
      none,
      none,
      registrationRepository,
      none,
      none,
      emailService,
    );
    return { service, sendShiftConfirmationEmail };
  }

  it('passes the approval message and the approving user to the email', async () => {
    const { service, sendShiftConfirmationEmail } = setup();

    await service.approveRegistration('org-1', 'reg-1', admin, 'Bis Samstag!');

    expect(sendShiftConfirmationEmail).toHaveBeenCalledWith(
      'erika@example.org',
      'Erika',
      'Sommerfest',
      expect.any(String),
      { message: 'Bis Samstag!', senderName: 'Max Muster' },
    );
  });

  it('sends no note for an empty message', async () => {
    const { service, sendShiftConfirmationEmail } = setup();

    await service.approveRegistration('org-1', 'reg-1', admin, '   ');

    const calls = sendShiftConfirmationEmail.mock
      .calls as unknown as unknown[][];
    expect(calls[0][4]).toBeUndefined();
  });
});

describe('EmailService.sendShiftConfirmationEmail', () => {
  function setup() {
    const config = { get: () => undefined } as unknown as ConfigService;
    const service = new EmailService(config);
    const sendEmail = jest.spyOn(service, 'sendEmail').mockResolvedValue(true);
    const html = () => {
      const calls = sendEmail.mock.calls;
      return calls[0][0].html ?? '';
    };
    return { service, html };
  }

  it('includes the escaped message and sender', async () => {
    const { service, html } = setup();

    await service.sendShiftConfirmationEmail(
      'erika@example.org',
      'Erika',
      'Sommerfest',
      '<p>Theke</p>',
      { message: 'Bitte <b>pünktlich</b>\nsein', senderName: 'Max Muster' },
    );

    expect(html()).toContain('Bitte &lt;b&gt;pünktlich&lt;/b&gt;<br />sein');
    expect(html()).toContain('Nachricht von: Max Muster');
  });

  it('renders no note block without a message', async () => {
    const { service, html } = setup();

    await service.sendShiftConfirmationEmail(
      'erika@example.org',
      'Erika',
      'Sommerfest',
      '<p>Theke</p>',
    );

    expect(html()).not.toContain('Nachricht von:');
  });
});
