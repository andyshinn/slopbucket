// Spoken-language detection for posts, without a model: the writing system for
// non-Latin scripts, then common short words for Latin-script languages. It runs
// on the title and the extracted text (README or article) the classifier already
// cached, so the language can be filled in for old posts without calling the model.

/** Languages the detector can name, in the order the queue filter lists them. `und` is undetermined. */
export const LANGUAGES = {
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  uk: "Ukrainian",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  vi: "Vietnamese",
  id: "Indonesian",
  ar: "Arabic",
  fa: "Persian",
  he: "Hebrew",
  hi: "Hindi",
  th: "Thai",
  el: "Greek",
  und: "Unknown",
} as const;
export type Language = keyof typeof LANGUAGES;
export const LANGUAGE_CODES = Object.keys(LANGUAGES) as Language[];

export const isLanguage = (code: unknown): code is Language => typeof code === "string" && Object.hasOwn(LANGUAGES, code);

/**
 * The name of a post's language when the queue should flag it: null for English,
 * undetermined, not detected yet, or a code the detector doesn't produce.
 */
export const foreignLanguageName = (code: string | null): string | null =>
  isLanguage(code) && code !== "en" && code !== "und" ? LANGUAGES[code] : null;

// Common words, lowercase. Overlaps between languages are fine: the words only
// one language uses decide between them.
const STOPWORDS: Partial<Record<Language, readonly string[]>> = {
  en: ["the", "and", "to", "of", "for", "with", "you", "your", "this", "that", "it", "on", "are", "be", "can", "from", "by", "an", "or", "not", "will", "which", "have", "has", "how", "into", "our", "we", "use", "using", "any", "all", "without", "when", "what", "its"],
  es: ["el", "los", "las", "del", "que", "para", "con", "una", "por", "como", "más", "es", "se", "su", "sus", "pero", "este", "esta", "puede", "también", "y", "usar", "cuando", "sin", "lo"],
  pt: ["os", "das", "dos", "não", "uma", "para", "com", "que", "em", "é", "um", "ao", "mais", "você", "seu", "sua", "também", "pode", "isso", "como", "na", "no", "ou", "são"],
  fr: ["le", "les", "des", "est", "pour", "une", "dans", "avec", "vous", "sur", "pas", "qui", "du", "au", "aux", "ce", "cette", "sont", "et", "votre", "peut", "ou", "il", "nous"],
  de: ["der", "die", "das", "und", "ist", "mit", "für", "nicht", "ein", "eine", "zu", "den", "auf", "sie", "ich", "wird", "werden", "auch", "von", "dem", "oder", "kann", "sich", "es", "wie"],
  it: ["il", "di", "che", "per", "con", "non", "è", "della", "del", "delle", "gli", "sono", "una", "questo", "anche", "come", "può", "nel", "alla", "le", "un", "si"],
  nl: ["de", "het", "een", "en", "van", "niet", "op", "voor", "met", "dat", "zijn", "je", "deze", "ook", "wordt", "kan", "naar", "bij", "te", "jouw"],
  pl: ["i", "w", "z", "na", "jest", "nie", "się", "do", "że", "oraz", "dla", "jak", "może", "przez", "czy", "jako", "lub", "aby"],
  tr: ["ve", "bir", "bu", "için", "ile", "olarak", "daha", "çok", "gibi", "değil", "olan", "veya", "her", "ise"],
  vi: ["của", "và", "là", "các", "cho", "với", "được", "này", "không", "một", "những", "để", "trong", "có", "bạn"],
  id: ["dan", "yang", "untuk", "dengan", "ini", "itu", "dari", "dalam", "tidak", "adalah", "akan", "bisa", "atau", "ke", "anda"],
};
const WORD_LANGS = new Map<string, Language[]>();
for (const [lang, words] of Object.entries(STOPWORDS) as [Language, string[]][]) {
  for (const w of words) WORD_LANGS.set(w, [...(WORD_LANGS.get(w) ?? []), lang]);
}

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

/** Markdown and code that say nothing about the spoken language: code blocks, inline code, URLs, HTML tags. */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/~~~[\s\S]*?(~~~|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]{0,500}>/g, " ");
}

/**
 * The main spoken language of `text`, or `und` when there is too little to tell.
 * A character of Chinese, Japanese, Korean or Thai counts as four letters (about
 * a word's worth). A non-Latin script wins once it is more than half the size of
 * the Latin text, because posts in other scripts are full of English product
 * names and commands: a Chinese README that names Claude Code is Chinese.
 */
export function detectLanguage(text: string): Language {
  const t = prose(text);
  const han = count(t, /\p{Script=Han}/gu);
  const kana = count(t, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(t, /\p{Script=Hangul}/gu);
  const thai = count(t, /\p{Script=Thai}/gu);
  const cyrillic = count(t, /\p{Script=Cyrillic}/gu);
  const arabic = count(t, /\p{Script=Arabic}/gu);
  const hebrew = count(t, /\p{Script=Hebrew}/gu);
  const devanagari = count(t, /\p{Script=Devanagari}/gu);
  const greek = count(t, /\p{Script=Greek}/gu);
  const latin = count(t, /\p{Script=Latin}/gu);

  const scripts: [Language, number, number][] = [
    // [language, weighted size, raw characters]
    // Japanese mixes kanji (Han) with kana; Chinese has no kana, so a couple of kana
    // mean Japanese even in a kanji-heavy title. Kanji alone can't be told from Chinese.
    [kana >= 2 ? "ja" : "zh", (han + kana) * 4, han + kana],
    ["ko", hangul * 4, hangul],
    ["th", thai * 4, thai],
    [count(t, /[іїєґІЇЄҐ]/gu) >= cyrillic * 0.02 ? "uk" : "ru", cyrillic, cyrillic],
    [count(t, /[پچژگکی]/gu) >= arabic * 0.02 ? "fa" : "ar", arabic, arabic],
    ["he", hebrew, hebrew],
    ["hi", devanagari, devanagari],
    ["el", greek, greek],
  ];
  const [lang, size, chars] = scripts.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (chars >= 2 && size * 2 > latin) return lang;
  return latinLanguage(t);
}

/** By common words; needs at least two hits. Ties go to English, the queue's usual language. */
function latinLanguage(text: string): Language {
  const hits = new Map<Language, number>();
  let total = 0;
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    const langs = WORD_LANGS.get(word);
    if (!langs) continue;
    total++;
    for (const l of langs) hits.set(l, (hits.get(l) ?? 0) + 1);
  }
  if (total < 2) return "und";
  let best: Language = "en";
  let bestHits = hits.get("en") ?? 0;
  for (const [l, n] of hits) if (n > bestHits) [best, bestHits] = [l, n];
  return bestHits >= 2 ? best : "und";
}

/** A post's language, from its title and extracted text (README or article; "" when none was fetched). */
export const postLanguage = (title: string, text: string | null): Language => detectLanguage(`${title}\n${text ?? ""}`);
