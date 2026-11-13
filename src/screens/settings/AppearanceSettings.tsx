import { Check } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { useT } from '../../i18n/useT';
import type { AccentId } from '../../services/settings';

/** Swatch previews: the flat accent itself, matching the --accent tokens in
 *  global.css. 'satori' is first because it is the brand accent and the default. */
export const ACCENT_PREVIEW: Record<AccentId, string> = {
  satori: '#5a5aff',
  azure: '#4f7dff',
  violet: '#8b5cf6',
  cyan: '#22d3ee',
  emerald: '#34d399',
  amber: '#f59e0b',
  rose: '#fb7185',
};

/** Accent-color picker. Used by the live Settings → Appearance section. */
export function AccentSwatches() {
  const accent = useSettingsStore((s) => s.settings.accent);
  const update = useSettingsStore((s) => s.update);
  const t = useT();
  return (
    <div className="swatches">
      {(Object.keys(ACCENT_PREVIEW) as AccentId[]).map((id) => (
        <button
          key={id}
          type="button"
          className="swatch"
          style={{ background: ACCENT_PREVIEW[id] }}
          aria-pressed={accent === id}
          aria-label={t(`accent.${id}`)}
          title={t(`accent.${id}`)}
          data-testid={`accent-${id}`}
          onClick={() => void update({ accent: id })}
        >
          {accent === id && <Check size={15} />}
        </button>
      ))}
    </div>
  );
}
