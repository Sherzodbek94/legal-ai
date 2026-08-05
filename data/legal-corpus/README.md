# Legislation corpus

Drop the acts this deployment should be able to cite into this directory, then
ingest them:

```bash
curl -X POST http://localhost:4000/api/legal-corpus/ingest \
  -H 'content-type: application/json' -b cookies.txt -d '{}'
```

`LEGAL_CORPUS_DIR` points here. Ingestion is idempotent — a file whose contents
have not changed is skipped, so re-running after adding one act does not re-embed
the rest. Pass `{"force": true}` to rebuild everything.

## Where the text comes from — read this first

**This repository ships no lex.uz scraper, and adding one is not a shortcut to
be taken.** lex.uz is the sole official publisher of Uzbek legislation, it
documents no API, its terms of use are not published at a stable URL, and it is
operated by a state institution (the "Adolat" centre, under the Ministry of
Justice). Scraping it is a decision with legal weight, not an implementation
detail, and it is not one this codebase makes on an operator's behalf.

Put here only text this deployment has lawfully obtained:

- a bulk export agreed with the "Adolat" centre,
- an open-data set that permits redistribution, or
- files downloaded by hand for your own use.

**Act files are deliberately not committed** (see `.gitignore` beside this
file). What lands here is legislative text under someone else's terms, and a git
history is a redistribution. Keep it in the deployment, not in the repository.

## Format

One act per `.txt` or `.md` file. Front matter is optional — only `title`
matters, and `externalId` falls back to the filename, so a directory of plainly
named files ingests as-is.

```
---
externalId: -142859
title: O'zbekiston Respublikasi Mehnat kodeksi
type: CODE
number: ЎРҚ-798
language: uz-Latn
status: IN_FORCE
adoptedAt: 2022-10-28
url: https://lex.uz/docs/-142859
---
1-modda. Mehnat qonunchiligining vazifalari
...

2-modda. Mehnat munosabatlarini tartibga soluvchi asosiy tushunchalar
...
```

| Field | Values |
| --- | --- |
| `type` | `CODE`, `LAW`, `DECREE`, `RESOLUTION`, `REGULATION`, `OTHER` |
| `status` | `IN_FORCE`, `AMENDED`, `REPEALED` |
| `language` | `uz-Latn`, `uz-Cyrl`, `ru` — detected from the body when omitted |

### How the text is split

Chunks are article-aligned, so a citation names one article rather than "page
14". The splitter recognises `347-modda.`, `347-модда.`, `статья 347`, and
`article 347`, including inserted articles such as `347-1-modda`. It requires
the marker to start a line — a cross-reference mid-sentence
("...ushbu Kodeksning 347-moddasida nazarda tutilgan...") is not a boundary, and
treating it as one would cut an article in half at every reference to it.

So: keep one article per paragraph block, starting at the left margin. Text
reflowed into a single paragraph still ingests, but every chunk will be the
whole act and citations will stop being useful.

## Verifying

```bash
curl http://localhost:4000/api/legal-corpus/status -b cookies.txt
curl 'http://localhost:4000/api/legal-corpus/search?q=yillik+ta%27til' -b cookies.txt
```

`status` reports acts, articles and chunks. A search that returns article-level
hits with `externalId` and article numbers means the corpus is doing its job: the
legal chat can then answer from it and cite, instead of answering from the
model's own recollection of Uzbek law.
