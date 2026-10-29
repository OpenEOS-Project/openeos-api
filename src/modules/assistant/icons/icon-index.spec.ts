import { IconIndex, normalize } from './icon-index';

describe('IconIndex (lexical icon matching)', () => {
  const index = new IconIndex();

  it('normalizes umlauts, case and punctuation', () => {
    expect(normalize('Crêpe mit Nutella')).toBe('crepe mit nutella');
    expect(normalize('Pommes rot-weiß')).toBe('pommes rot weiss');
    expect(normalize('Cola 0,33 l (Flasche)')).toBe('cola 0 33 l flasche');
  });

  it.each([
    ['Pils', 'pos-icon:pils'],
    ['Helles 0,5 l', 'pos-icon:pils'],
    ['Radler', 'pos-icon:radler'],
    ['Apfelschorle 0,5 l', 'pos-icon:apfelschorle'],
    ['Cola 0,33 l (Flasche)', 'pos-icon:cola-flasche'],
    ['Weinschorle rot 0,25 l', 'pos-icon:weinschorle-rot'],
    ['Mineralwasser 0,5 l', 'pos-icon:wasser'],
    ['Currywurst mit Pommes', 'pos-icon:currywurst-pommes'],
    ['Crêpe mit Nutella', 'pos-icon:crepes-nutella'],
    ['Grillwurst im Brötchen', 'pos-icon:grillwurst-brot'],
    ['Bratwurst', 'pos-icon:grillwurst'],
    ['Rotweinschorle', 'pos-icon:weinschorle-rot'],
  ])('matches "%s" to %s first', (name, icon) => {
    expect(index.match(name)[0]?.icon).toBe(icon);
  });

  it('prefers the compound icon over its parts and returns at most three', () => {
    const matches = index.match('Currywurst mit Pommes');
    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({
      icon: 'pos-icon:currywurst-pommes',
      score: 1,
    });
    expect(matches[1].score).toBeLessThan(1);
  });

  it('returns nothing for names without any lexical overlap', () => {
    expect(index.match('Kaffee')).toEqual([]);
  });

  it('scores unclear names below the model threshold', () => {
    expect(index.match('Hauswein')[0]?.score ?? 0).toBeLessThan(0.6);
  });
});
