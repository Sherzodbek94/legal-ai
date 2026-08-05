import { LegalActStatus, LegalActType } from '@legaltech/database';
import { detectLanguage, parseActFile } from './file-legal-source';

const WITH_FRONT_MATTER = `---
externalId: -111181
title: O'zbekiston Respublikasi Fuqarolik kodeksi
type: CODE
number: 163-I
language: uz-Latn
status: IN_FORCE
adoptedAt: 1996-12-29
url: https://lex.uz/docs/-111181
---
346-modda. Majburiyatni bajarish

Matn.`;

describe('parseActFile', () => {
  describe('front matter', () => {
    const act = parseActFile('civil-code.txt', WITH_FRONT_MATTER)!;

    it('reads every declared field', () => {
      expect(act).toMatchObject({
        externalId: '-111181',
        title: "O'zbekiston Respublikasi Fuqarolik kodeksi",
        type: LegalActType.CODE,
        number: '163-I',
        language: 'uz-Latn',
        status: LegalActStatus.IN_FORCE,
        url: 'https://lex.uz/docs/-111181',
      });
      expect(act.adoptedAt?.getUTCFullYear()).toBe(1996);
    });

    it('strips the front matter from the indexed text', () => {
      // Leaving it in would embed the YAML and let a search match on it.
      expect(act.content).not.toContain('externalId');
      expect(act.content.trimStart().startsWith('346-modda')).toBe(true);
    });
  });

  describe('without front matter', () => {
    it('falls back to the filename for identity and title', () => {
      // A directory of plainly-named files should ingest with no ceremony, and
      // re-ingest to the same rows next time.
      const act = parseActFile('mehnat-kodeksi.txt', '5-modda. Matn.')!;

      expect(act.externalId).toBe('mehnat-kodeksi');
      expect(act.title).toBe('mehnat-kodeksi');
      expect(act.content).toContain('5-modda');
    });

    it('classifies an unstated type as OTHER', () => {
      expect(parseActFile('x.txt', 'Matn.')!.type).toBe(LegalActType.OTHER);
    });

    it('classifies an unstated status as UNKNOWN, never IN_FORCE', () => {
      // Citing a repealed article is worse than finding nothing — it is
      // confidently wrong inside a document somebody signs.
      expect(parseActFile('x.txt', 'Matn.')!.status).toBe(LegalActStatus.UNKNOWN);
    });

    it('classifies an unrecognised status as UNKNOWN', () => {
      const act = parseActFile('x.txt', '---\nstatus: probably-fine\n---\nMatn.')!;

      expect(act.status).toBe(LegalActStatus.UNKNOWN);
    });
  });

  describe('revision', () => {
    it('hashes the body when the file states none', () => {
      const act = parseActFile('x.txt', 'Matn.')!;

      expect(act.revision).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is stable for identical text, so a re-ingest costs nothing', () => {
      const first = parseActFile('x.txt', 'Bir xil matn.')!;
      const second = parseActFile('x.txt', 'Bir xil matn.')!;

      expect(first.revision).toBe(second.revision);
    });

    it('changes when the text changes', () => {
      const before = parseActFile('x.txt', 'Eski matn.')!;
      const after = parseActFile('x.txt', "Yangi tahrirdagi matn.")!;

      expect(before.revision).not.toBe(after.revision);
    });

    it('prefers a stated revision over the hash', () => {
      const act = parseActFile('x.txt', '---\nrevision: 2026-04-01\n---\nMatn.')!;

      expect(act.revision).toBe('2026-04-01');
    });
  });

  it('skips a file with no body', () => {
    expect(parseActFile('empty.txt', '---\ntitle: Bo\'sh\n---\n\n  ')).toBeNull();
  });
});

describe('detectLanguage', () => {
  it('recognises Uzbek Cyrillic by letters Russian does not have', () => {
    expect(detectLanguage('Ўзбекистон Республикасининг Фуқаролик кодекси')).toBe(
      'uz-Cyrl',
    );
  });

  it('recognises Russian', () => {
    expect(detectLanguage('Гражданский кодекс Республики Узбекистан')).toBe('ru');
  });

  it('treats Latin as Uzbek, which is what this corpus is', () => {
    expect(detectLanguage("O'zbekiston Respublikasi Fuqarolik kodeksi")).toBe(
      'uz-Latn',
    );
  });

  it('does not mistake Uzbek Cyrillic for Russian', () => {
    // The failure this guards: filing the Cyrillic and Russian texts of one act
    // under the same language, which are different official texts.
    expect(detectLanguage('Мажбурият лозим даражада бажарилиши керак. Ҳуқуқ.')).toBe(
      'uz-Cyrl',
    );
  });
});
