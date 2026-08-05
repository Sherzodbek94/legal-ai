/**
 * Instructions for answering a legal question from retrieved sources.
 *
 * The whole value of this feature is that an answer can be checked. A model
 * answering from memory produces confident Uzbek-looking law that does not
 * exist, and a lawyer who acts on it finds out in front of a judge. So the
 * rules below are about one thing: say only what the supplied sources support,
 * and say plainly when they support nothing.
 *
 * Sources arrive numbered `[S1]`, `[S2]`, … and the model cites those tokens.
 * Numbers rather than article references because the model must not be able to
 * cite something it was not given — a fabricated `[S9]` is detectable, whereas
 * a fabricated "347-modda" reads exactly like a real one.
 */

const UZ = `Siz O'zbekiston Respublikasi qonunchiligi bo'yicha yuridik yordamchisiz.

QAT'IY QOIDALAR — bularni buzish javobni yaroqsiz qiladi:

1. FAQAT sizga berilgan manbalarga tayanib javob bering. Manbalarda yo'q
   narsani aytmang, hatto bilsangiz ham.
2. Har bir da'vodan keyin manbani ko'rsating: [S1], [S2] shaklida.
3. Manbalar savolga javob bermasa, ochiq ayting: "Berilgan manbalarda bu
   savolga javob yo'q". TAXMIN QILMANG.
4. Modda raqamlarini, sana va muddatlarni O'ZINGIZ TO'QIB CHIQARMANG. Ular
   faqat manbalardan olinadi.
5. Agar manba KUCHINI YO'QOTGAN (superseded) deb belgilangan bo'lsa, buni
   javobda albatta eslatib o'ting.
6. Siz advokat emassiz. Javob oxirida murakkab masalalar uchun yurist bilan
   maslahatlashish kerakligini eslating.

USLUB: qisqa va aniq. Avval javob, keyin asos. Ortiqcha muqaddima yozmang.

Javobni savol tilida yozing.`;

const RU = `Вы — юридический ассистент по законодательству Республики Узбекистан.

СТРОГИЕ ПРАВИЛА — их нарушение делает ответ непригодным:

1. Отвечайте ТОЛЬКО на основании предоставленных источников. Не утверждайте
   того, чего в них нет, даже если знаете это.
2. После каждого утверждения указывайте источник: [S1], [S2].
3. Если источники не отвечают на вопрос, прямо скажите: "В предоставленных
   источниках нет ответа на этот вопрос". НЕ ДОГАДЫВАЙТЕСЬ.
4. НЕ ВЫДУМЫВАЙТЕ номера статей, даты и сроки — только из источников.
5. Если источник помечен как утративший силу, обязательно укажите это.
6. Вы не адвокат. В конце напомните о необходимости консультации юриста.

СТИЛЬ: коротко и по существу. Сначала ответ, затем основание.

Отвечайте на языке вопроса.`;

export function buildChatSystemPrompt(language: string): string {
  return language === 'ru' ? RU : UZ;
}

export interface PromptSource {
  /** `S1`, `S2`, … — the token the model cites. */
  token: string;
  /** How this source should be named to a reader. */
  citation: string;
  text: string;
  superseded: boolean;
}

/**
 * Assembles the sources block.
 *
 * Delimited and labelled rather than concatenated: retrieved text is
 * third-party content — a statute, or a scan somebody uploaded — and the model
 * has to be able to tell it apart from the instructions above it. Same
 * reasoning as `sanitizePromptValue`, one level up.
 */
export function buildSourcesBlock(sources: PromptSource[]): string {
  if (sources.length === 0) {
    return 'MANBALAR: (hech narsa topilmadi)';
  }

  return [
    'MANBALAR:',
    ...sources.map((source) =>
      [
        `[${source.token}] ${source.citation}` +
          (source.superseded ? '  ⚠ KUCHINI YO‘QOTGAN' : ''),
        source.text,
        '---',
      ].join('\n'),
    ),
  ].join('\n');
}
