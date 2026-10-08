import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PutTableAreaLayoutDto, UpdateTableAreaDto } from './table-area.dto';

const errorsOf = async (cls: new () => object, plain: object) => {
  const errors = await validate(plainToInstance(cls, plain));
  const flat: string[] = [];
  const walk = (list: typeof errors, path: string) =>
    list.forEach((e) => {
      const p = path ? `${path}.${e.property}` : e.property;
      if (e.constraints)
        flat.push(`${p}:${Object.keys(e.constraints).join(',')}`);
      walk(e.children ?? [], p);
    });
  walk(errors, '');
  return flat;
};

const pts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ x: i, y: i }));

describe('table area decor DTO', () => {
  it('accepts rectangles, polyline walls and zones in one layout', async () => {
    expect(
      await errorsOf(PutTableAreaLayoutDto, {
        tables: [],
        decor: [
          {
            id: 'd1',
            type: 'bar',
            x: 0,
            y: 0,
            width: 100,
            height: 40,
            rotation: 0,
          },
          {
            id: 'd2',
            type: 'wall',
            x: 0,
            y: 0,
            width: 100,
            height: 10,
            rotation: 0,
          },
          { id: 'w1', type: 'wall', points: pts(2), thickness: 10 },
          {
            id: 'z1',
            type: 'zone',
            zoneType: 'blocked',
            points: pts(3),
            label: 'Notausgang',
          },
        ],
        outline: pts(3),
      }),
    ).toEqual([]);
  });

  it('still requires position and size for rectangles', async () => {
    const errors = await errorsOf(PutTableAreaLayoutDto, {
      tables: [],
      decor: [{ id: 'd1', type: 'stage' }],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^decor\.0\.x:/),
        expect.stringMatching(/^decor\.0\.rotation:/),
      ]),
    );
  });

  it('requires points and a valid zone type for zones', async () => {
    const errors = await errorsOf(PutTableAreaLayoutDto, {
      tables: [],
      decor: [{ id: 'z1', type: 'zone', zoneType: 'pool' }],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^decor\.0\.points:/),
        expect.stringMatching(/^decor\.0\.zoneType:isIn/),
      ]),
    );
  });

  it('limits points to 100, integer coordinates within the size limit', async () => {
    const errors = await errorsOf(PutTableAreaLayoutDto, {
      tables: [],
      decor: [
        { id: 'w1', type: 'wall', points: pts(101) },
        {
          id: 'w2',
          type: 'wall',
          points: [
            { x: 1.5, y: 0 },
            { x: -1, y: 9999 },
          ],
        },
      ],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'decor.0.points:arrayMaxSize',
        expect.stringMatching(/^decor\.1\.points\.0\.x:isInt/),
        expect.stringMatching(/^decor\.1\.points\.1\.x:min/),
        expect.stringMatching(/^decor\.1\.points\.1\.y:max/),
      ]),
    );
  });

  it('allows outline null (reset) but not fewer than 3 points', async () => {
    expect(await errorsOf(UpdateTableAreaDto, { outline: null })).toEqual([]);
    expect(await errorsOf(UpdateTableAreaDto, { outline: pts(2) })).toEqual([
      'outline:arrayMinSize',
    ]);
    expect(await errorsOf(UpdateTableAreaDto, { outline: pts(101) })).toEqual([
      'outline:arrayMaxSize',
    ]);
  });
});
