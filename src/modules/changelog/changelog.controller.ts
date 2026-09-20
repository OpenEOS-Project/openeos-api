import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators';
import { CHANGELOG } from './changelog.data';

/**
 * Die Änderungsliste, öffentlich.
 *
 * Öffentlich, weil die Marketing-Website sie ebenso braucht wie die
 * angemeldete Oberfläche — und weil nichts darin geheim ist. Eine zweite
 * gepflegte Liste im Frontend wäre binnen weniger Wochen von dieser
 * abgewichen.
 */
@ApiTags('Changelog')
@Controller('public/changelog')
export class ChangelogController {
  @Public()
  @Get()
  @ApiOperation({
    summary: 'What changed, newest first',
    description:
      'Entries are plain-language and bilingual. `since` returns only what is ' +
      'newer than that date — the signed-in app uses it to show a user what ' +
      'arrived since their last visit.',
  })
  @ApiQuery({ name: 'since', required: false, description: 'JJJJ-MM-TT' })
  list(@Query('since') since?: string) {
    /* Reiner Zeichenkettenvergleich: bei JJJJ-MM-TT entspricht die
       alphabetische Ordnung der zeitlichen, und ein ungueltiges Datum
       filtert damit nichts weg statt alles. */
    const eintraege = since ? CHANGELOG.filter((e) => e.datum > since) : CHANGELOG;

    return {
      data: {
        entries: eintraege,
        /** Neuester Stand insgesamt — der Client merkt sich diesen Wert. */
        latest: CHANGELOG[0]?.datum ?? null,
      },
    };
  }
}
