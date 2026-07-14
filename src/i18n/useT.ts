import { useMemo } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { makeTranslator, type Translator } from './index';

export function useT(): Translator {
  const language = useSettingsStore((s) => s.settings.language);
  return useMemo(() => makeTranslator(language), [language]);
}
