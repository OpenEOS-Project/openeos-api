import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { ReceiptsService } from './receipts.service';

/**
 * Oeffentliche Beleg-Seite (`/beleg/<token>` in der Web-App) und PDF.
 * Ohne Anmeldung: Wer den Link hat, sieht den Beleg — mehr nicht.
 */
@ApiTags('Public Receipts')
@Controller('public/receipts')
@Public()
export class ReceiptsPublicController {
  constructor(private readonly receipts: ReceiptsService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @ApiOperation({
    summary: 'Digitalen Beleg anzeigen',
    description:
      'Beleg-Bausteine (wie gedruckter Bon) und die rechtlichen Angaben des Vereins. 404 `RECEIPT_LINK_NOT_FOUND`, wenn der Link abgelaufen oder unbekannt ist.',
  })
  async view(@Param('token') token: string) {
    return { data: await this.receipts.publicView(token) };
  }

  @Get(':token/pdf')
  @ApiOperation({ summary: 'Digitalen Beleg als PDF herunterladen' })
  async pdf(@Param('token') token: string, @Res() res: Response) {
    const { filename, pdf } = await this.receipts.publicPdf(token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(pdf);
  }
}
