// English by default; Chinese when the locale says so. ALR_LANG=zh|en overrides.
const pick = process.env.ALR_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
export const zh = /^zh/i.test(pick);
export const t = (en, zhText) => (zh ? zhText : en);
