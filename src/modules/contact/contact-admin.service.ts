import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { ContactRequest, type ContactRequestKind } from '../../database/entities';
import { ErrorCodes } from '../../common/constants/error-codes';

@Injectable()
export class ContactAdminService {
  constructor(
    @InjectRepository(ContactRequest)
    private readonly contactRequestRepository: Repository<ContactRequest>,
  ) {}

  async list(filter: {
    type?: ContactRequestKind;
    handled?: boolean;
  }): Promise<ContactRequest[]> {
    const where: Record<string, unknown> = {};
    if (filter.type) where.type = filter.type;
    if (filter.handled !== undefined) {
      where.handledAt = filter.handled ? Not(IsNull()) : IsNull();
    }

    return this.contactRequestRepository.find({
      where,
      order: { createdAt: 'DESC' },
      // Genug fuer die Durchsicht; wer weiter zurueck muss, filtert.
      take: 200,
    });
  }

  /** Haken setzen oder wieder entfernen — versehentliches Abhaken passiert. */
  async toggleHandled(id: string): Promise<ContactRequest> {
    const eintrag = await this.contactRequestRepository.findOne({ where: { id } });
    if (!eintrag) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: 'Zuschrift nicht gefunden',
      });
    }

    eintrag.handledAt = eintrag.handledAt ? null : new Date();
    return this.contactRequestRepository.save(eintrag);
  }
}
