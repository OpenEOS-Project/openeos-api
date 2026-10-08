import { ChangelogController } from './changelog.controller';
import { CHANGELOG, RELEASES } from './changelog.data';

describe('ChangelogController', () => {
  const controller = new ChangelogController();

  it('returns the 1.6 entries first, with their version', () => {
    const { data } = controller.list();

    expect(data.latest).toBe('2026-10-08');
    expect(data.latestVersion).toBe('1.6');

    const release16 = data.entries.filter((e) => e.version === '1.6');
    expect(release16.length).toBeGreaterThan(0);
    expect(data.entries[0].version).toBe('1.6');
    expect(release16.every((e) => e.datum === '2026-10-08')).toBe(true);
  });

  it('only returns newer entries for since', () => {
    const { data } = controller.list('2026-10-03');

    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.entries.every((e) => e.version === '1.6')).toBe(true);
  });

  it('keeps the data consistent', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      expect(CHANGELOG[i - 1].datum >= CHANGELOG[i].datum).toBe(true);
    }

    for (const e of CHANGELOG) {
      expect(RELEASES[e.datum]).toBeDefined();
      expect(['neu', 'verbessert', 'behoben']).toContain(e.art);
      for (const feld of [e.titel, e.text, e.kurz]) {
        expect(feld?.de.trim()).toBeTruthy();
        expect(feld?.en.trim()).toBeTruthy();
      }
    }
  });
});
