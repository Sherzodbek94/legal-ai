import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LegalActStatus, LegalActType } from '@legaltech/database';
import type { LegalCorpusSource, SourceAct } from './legal-source';

/**
 * Legislation read from a directory of text files.
 *
 * The working source, deliberately. lex.uz is the sole official publisher of
 * Uzbek legislation and documents no API, its terms of use are not published at
 * a stable URL, and the site is operated by a state institution — so this
 * repository does not ship a scraper for it. What it ships instead is a source
 * that ingests whatever text this deployment has lawfully obtained: a bulk
 * export agreed with the "Adolat" centre, an open-data set, or files downloaded
 * by hand.
 *
 * A lex.uz adapter is one class implementing `LegalCorpusSource`; nothing above
 * this layer changes when it arrives.
 *
 * ## Format
 *
 * One act per `.txt` or `.md` file, with a YAML-ish front-matter block:
 *
 *     ---
 *     externalId: -111181
 *     title: O'zbekiston Respublikasi Fuqarolik kodeksi
 *     type: CODE
 *     number: 163-I
 *     language: uz-Latn
 *     status: IN_FORCE
 *     adoptedAt: 1996-12-29
 *     url: https://lex.uz/docs/-111181
 *     ---
 *     346-modda. Majburiyatni bajarish
 *     ...
 *
 * Only `title` is required. `externalId` falls back to the filename, so a
 * directory of plainly-named files ingests without any front matter at all.
 */
@Injectable()
export class FileLegalSource implements LegalCorpusSource {
  readonly name = 'files';

  private readonly logger = new Logger(FileLegalSource.name);

  constructor(private readonly config: ConfigService) {}

  private get directory(): string {
    return this.config.get<string>('LEGAL_CORPUS_DIR', '');
  }

  isConfigured(): boolean {
    return Boolean(this.directory);
  }

  async *acts(): AsyncIterable<SourceAct> {
    if (!this.isConfigured()) return;

    const directory = this.directory;
    let entries: string[];

    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      // A misconfigured path is worth one clear line rather than a stack trace
      // per file: the whole run produces nothing either way.
      this.logger.error(
        `Cannot read LEGAL_CORPUS_DIR (${directory}): ${(error as Error)?.message ?? 'unknown error'}`,
      );
      return;
    }

    for (const entry of entries.sort()) {
      if (!/\.(txt|md)$/i.test(entry)) continue;

      const full = path.join(directory, entry);

      try {
        const raw = await fs.readFile(full, 'utf8');
        const act = parseActFile(entry, raw);
        if (act) yield act;
      } catch (error) {
        // One unreadable file must not abandon the rest of the statute book.
        this.logger.warn(
          `Skipped ${entry}: ${(error as Error)?.message ?? 'unknown error'}`,
        );
      }
    }
  }
}

/**
 * Parses one file into an act.
 *
 * Exported for tests, and because the format is the contract with whoever
 * prepares the corpus — it deserves to be exercised without a filesystem.
 */
export function parseActFile(filename: string, raw: string): SourceAct | null {
  const { meta, body } = splitFrontMatter(raw);

  if (!body.trim()) return null;

  const title = meta.title ?? path.basename(filename).replace(/\.(txt|md)$/i, '');

  return {
    // Falls back to the filename so a directory with no front matter still
    // ingests, and still re-ingests to the same rows next time.
    externalId: meta.externalId ?? path.basename(filename).replace(/\.(txt|md)$/i, ''),
    url: meta.url,
    type: parseType(meta.type),
    number: meta.number,
    title,
    // Guessed from the text when unstated: the alphabet is unambiguous, and
    // getting it wrong would file the Cyrillic and Latin texts of one act as
    // the same row.
    language: meta.language ?? detectLanguage(body),
    adoptedAt: parseDate(meta.adoptedAt),
    effectiveFrom: parseDate(meta.effectiveFrom),
    status: parseStatus(meta.status),
    // A content hash when the file states no revision, so a re-ingest of an
    // unchanged act costs nothing.
    revision: meta.revision ?? createHash('sha256').update(body).digest('hex').slice(0, 16),
    content: body,
  };
}

function splitFrontMatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};

  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '');

    if (key && value) meta[key] = value;
  }

  return { meta, body: raw.slice(match[0].length) };
}

function parseType(value: string | undefined): LegalActType {
  const upper = value?.trim().toUpperCase();

  if (upper && upper in LegalActType) {
    return LegalActType[upper as keyof typeof LegalActType];
  }

  return LegalActType.OTHER;
}

/**
 * Unknown status stays UNKNOWN rather than becoming IN_FORCE.
 *
 * Same rule as the counterparty registry, and it matters more here: citing a
 * repealed article is worse than finding nothing, because it is confidently
 * wrong inside a document somebody signs.
 */
function parseStatus(value: string | undefined): LegalActStatus {
  const upper = value?.trim().toUpperCase();

  if (upper && upper in LegalActStatus) {
    return LegalActStatus[upper as keyof typeof LegalActStatus];
  }

  return LegalActStatus.UNKNOWN;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Uzbek Cyrillic against Russian, by the letters only one of them uses.
 *
 * `ў`, `қ`, `ғ`, `ҳ` exist in Uzbek Cyrillic and not in Russian, which makes
 * the test cheap and decisive. Latin text is assumed Uzbek: this corpus is
 * Uzbek legislation, and English translations are the rare case that should
 * state their language in front matter.
 */
export function detectLanguage(text: string): string {
  const sample = text.slice(0, 4000);

  if (/[ЎўҚқҒғҲҳ]/.test(sample)) return 'uz-Cyrl';
  if (/[А-Яа-яЁё]/.test(sample)) return 'ru';

  return 'uz-Latn';
}
