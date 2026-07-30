import { batchChunks, chunkText, estimateTokens } from './chunking';

describe('estimateTokens', () => {
  it('estimates Latin text at roughly four characters per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBeCloseTo(100, -1);
  });

  it('estimates Cyrillic higher per character than Latin', () => {
    // Cyrillic fragments badly under BPE vocabularies trained mostly on English,
    // so assuming 4 chars/token understates real usage by roughly a third.
    const latin = estimateTokens('a'.repeat(300));
    const cyrillic = estimateTokens('б'.repeat(300));
    expect(cyrillic).toBeGreaterThan(latin);
  });

  it('returns zero for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('never returns zero for non-empty input', () => {
    expect(estimateTokens('a')).toBeGreaterThan(0);
  });
});

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const chunks = chunkText('A short clause.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('A short clause.');
    expect(chunks[0].index).toBe(0);
  });

  it('splits text that exceeds the maximum', () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `${i + 1}. Clause number ${i + 1} setting out an obligation of the parties.`,
    ).join('\n');

    const chunks = chunkText(long, { targetTokens: 100, maxTokens: 150 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('numbers chunks densely from zero', () => {
    const long = 'Sentence about obligations. '.repeat(200);
    const chunks = chunkText(long, { targetTokens: 100, maxTokens: 150 });

    expect(chunks.map((chunk) => chunk.index)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  it('prefers a numbered-clause boundary over a mid-sentence cut', () => {
    // A clause split down the middle produces two passages that each answer half
    // a question and neither answers it well.
    const text = [
      '1. The Supplier shall deliver the Goods to the address specified in Annex 1 within thirty calendar days.',
      '2. The Buyer shall pay the price stated in clause 4 within ten banking days of delivery.',
      '3. Either party may terminate this Agreement on thirty days written notice.',
    ].join('\n');

    // Overlap off, to isolate boundary selection: with overlap on, a chunk
    // deliberately starts *before* the previous boundary, so its first characters
    // are mid-clause by design.
    const chunks = chunkText(text, {
      targetTokens: 30,
      maxTokens: 45,
      overlapTokens: 0,
    });

    // Every chunk after the first should begin at a clause number.
    for (const chunk of chunks.slice(1)) {
      expect(chunk.content).toMatch(/^\d+\./);
    }
  });

  it('recognises Russian and Uzbek article headings as boundaries', () => {
    const text = [
      'Статья 1. Предмет договора и общие положения сторон настоящего соглашения.',
      'Статья 2. Права и обязанности сторон по настоящему договору поставки.',
      'Статья 3. Ответственность сторон за неисполнение обязательств.',
    ].join('\n');

    const chunks = chunkText(text, {
      targetTokens: 25,
      maxTokens: 40,
      overlapTokens: 0,
    });
    for (const chunk of chunks.slice(1)) {
      expect(chunk.content).toMatch(/^Статья/);
    }
  });

  it('overlaps consecutive chunks', () => {
    // Overlap is what stops a fact straddling a boundary being lost by both
    // sides.
    const text = Array.from(
      { length: 40 },
      (_, i) => `Sentence ${i} carrying some contractual meaning about the parties.`,
    ).join(' ');

    const chunks = chunkText(text, {
      targetTokens: 60,
      maxTokens: 80,
      overlapTokens: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    // The second chunk starts before the first one ended.
    expect(chunks[1].offset).toBeLessThan(
      chunks[0].offset + chunks[0].content.length,
    );
  });

  it('records a character offset for each chunk', () => {
    const text = 'Clause text about obligations. '.repeat(100);
    const chunks = chunkText(text, { targetTokens: 60, maxTokens: 80 });

    expect(chunks[0].offset).toBe(0);
    for (const chunk of chunks) {
      expect(chunk.offset).toBeGreaterThanOrEqual(0);
      expect(chunk.offset).toBeLessThan(text.length);
    }
  });

  it('folds a tiny trailing fragment into its predecessor', () => {
    // A 12-token trailing fragment embeds to a vector that matches almost any
    // query weakly, displacing a real result.
    const text = `${'Substantive clause text about the obligations of the parties. '.repeat(40)}\nSigned.`;

    const chunks = chunkText(text, {
      targetTokens: 60,
      maxTokens: 80,
      minTokens: 30,
    });

    const last = chunks[chunks.length - 1];
    expect(last.tokenCount).toBeGreaterThanOrEqual(30);
  });

  it('always terminates, even on text with no boundaries at all', () => {
    // A wall of characters with no punctuation or newlines: the loop must not
    // stall waiting for a boundary that does not exist.
    const chunks = chunkText('x'.repeat(20_000), {
      targetTokens: 100,
      maxTokens: 150,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(500);
  });

  it('makes real progress when the overlap exceeds the chunk size', () => {
    // The degenerate case: an overlap larger than the chunk makes the naive
    // `end - overlap` fall behind `start`, the +1 floor takes over, and the
    // chunker advances one character at a time — thousands of near-identical
    // passages, each of which costs an embedding call.
    const text = 'word '.repeat(500);
    const chunks = chunkText(text, {
      targetTokens: 20,
      maxTokens: 25,
      overlapTokens: 100,
    });

    expect(chunks.length).toBeGreaterThan(0);
    // Overlap is clamped to half the chunk, so chunk count stays proportional to
    // the document rather than to its character count.
    expect(chunks.length).toBeLessThan(text.length / 10);
  });

  it('normalises Windows line endings', () => {
    const chunks = chunkText('First line.\r\nSecond line.');
    expect(chunks[0].content).not.toContain('\r');
  });

  it('covers the whole document across its chunks', () => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `${i + 1}. Distinctive marker phrase ${i + 1} appears exactly here.`,
    ).join('\n');

    const chunks = chunkText(text, { targetTokens: 40, maxTokens: 60 });
    const combined = chunks.map((chunk) => chunk.content).join(' ');

    // Every clause must appear somewhere; a lost clause is a lost search result.
    for (let i = 1; i <= 30; i++) {
      expect(combined).toContain(`marker phrase ${i} `);
    }
  });
});

describe('batchChunks', () => {
  const chunk = (tokenCount: number) => ({ tokenCount });

  it('groups everything into one batch when it fits', () => {
    expect(batchChunks([chunk(10), chunk(10)])).toHaveLength(1);
  });

  it('splits on the count limit', () => {
    const chunks = Array.from({ length: 250 }, () => chunk(10));
    const batches = batchChunks(chunks, 96);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(96);
  });

  it('splits on the token limit', () => {
    // Exceeding either limit rejects the whole batch rather than trimming it.
    const chunks = Array.from({ length: 10 }, () => chunk(60_000));
    const batches = batchChunks(chunks, 96, 250_000);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const total = batch.reduce((sum, item) => sum + item.tokenCount, 0);
      expect(total).toBeLessThanOrEqual(250_000);
    }
  });

  it('keeps a single oversized chunk rather than dropping it', () => {
    // Better to let the API reject one oversized input than to silently lose a
    // passage from the index.
    const batches = batchChunks([chunk(500_000)], 96, 250_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it('loses nothing', () => {
    const chunks = Array.from({ length: 200 }, (_, i) => chunk(i + 1));
    const batches = batchChunks(chunks, 96);
    expect(batches.flat()).toHaveLength(200);
  });

  it('returns nothing for no input', () => {
    expect(batchChunks([])).toEqual([]);
  });
});
