/**
 * Minimal i18n: picks the OS/webview locale, falls back to English per key.
 */
import { de } from "./de";
import { en, type MessageKey, type Messages } from "./en";

export type { MessageKey };

const catalogs: Record<string, Partial<Messages>> = { en, de };

function detectLocale(): string {
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of candidates) {
    const base = tag?.toLowerCase().split("-")[0];
    if (base && base in catalogs) return base;
  }
  return "en";
}

export const locale = detectLocale();
const active = catalogs[locale] ?? en;

/** Translates `key`, replacing `{param}` placeholders. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = active[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatDate(ms: number): string {
  return dateFormat.format(new Date(ms));
}

export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${numberFormat.format(value)} ${UNITS[unit]}`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat(locale).format(n);
}
