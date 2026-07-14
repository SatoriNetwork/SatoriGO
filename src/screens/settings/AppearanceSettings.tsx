import { Check } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { useT } from '../../i18n/useT';
import type { AccentId } from '../../services/settings';

/** Swatch previews. Each is a TONAL gradient inside one hue — matching how the
 *  Satori neuron renders its accent. The old two-hue previews (blue→violet,
 *  rose→purple) were the loudest part of the generic look. 'satori' is first
 *  because it is the brand accent and the default. */
export const ACCENT_PREVIEW: Record<AccentId, string> = {
  satori: 'linear-gradient(135deg, #5a5aff, #3a3acc)',
  azure: 'linear-gradient(135deg, #4f7dff, #3355cc)',
  violet: 'linear-gradient(135deg, #8b5cf6, #6d28d9)',
  cyan: 'linear-gradient(135deg, #22d3ee, #0e7490)',
  emerald: 'linear-gradient(135deg, #34d399, #047857)',
  amber: 'linear-gradient(135deg, #f59e0b, #b45309)',
  rose: 'linear-gradient(135deg, #fb7185, #be123c)',
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
