import { en, type MessageKey, type Messages } from './en';
import { pl } from './pl';
import type { Language } from '../services/settings';

const DICTIONARIES: Record<Language, Messages> = { en, pl };

export type { MessageKey };

export type Translator = (key: MessageKey, params?: Record<string, string | number>) => string;

export function translate(
  language: Language,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  let text = DICTIONARIES[language][key] ?? en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export function makeTranslator(language: Language): Translator {
  return (key, params) => translate(language, key, params);
}
