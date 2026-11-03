import { createHash } from 'crypto';

import { officialTemplates } from './dsfinvk-export';
import { DSFINVK_TABLES } from './dsfinvk-schema';
import { parseIndexXml } from './dsfinvk-validator';

describe('DSFinV-K schema', () => {
  it('uses the unchanged official templates (DSFinV-K 2.4, BZSt)', () => {
    const { index, dtd } = officialTemplates();
    // Pruefsummen der Dateien aus dsfinv_k_v_2_4.zip (Ordner 02_index.xml).
    expect(
      createHash('sha256').update(Buffer.from(index, 'utf8')).digest('hex'),
    ).toBe('d0b1fed31a50dc6370d7a54528034a1e0ac2f982f82e3c0a9250a15c64c85160');
    expect(createHash('sha256').update(dtd).digest('hex')).toBe(
      'af3d4c5a19e991f2d8c53995bc708680bbd7ff9326fde539c55b7e2c63f848a2',
    );
  });

  it('matches the tables and columns of the official index.xml', () => {
    const official = parseIndexXml(officialTemplates().index);
    expect(official).toHaveLength(20);
    expect(
      DSFINVK_TABLES.map((t) => ({
        url: t.file,
        name: t.name,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type,
          maxLength: c.maxLength,
          accuracy: c.accuracy,
        })),
      })),
    ).toEqual(
      official.map((t) => ({
        url: t.url,
        name: t.name,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type,
          maxLength: c.type === 'alpha' ? c.maxLength : undefined,
          accuracy: c.type === 'numeric' ? c.accuracy : undefined,
        })),
      })),
    );
  });
});
