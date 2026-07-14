import { create } from 'zustand';
import {
  DEFAULT_BRANDING,
  loadBranding,
  saveBranding,
  type BrandingConfig,
  type CustomLogo,
  type LogoSlot,
} from '../services/branding';

interface BrandingState {
  branding: BrandingConfig;
  loaded: boolean;
  load(): Promise<void>;
  update(patch: Partial<Omit<BrandingConfig, 'logos'>>): Promise<void>;
  setLogo(slot: LogoSlot, logo: CustomLogo | undefined): Promise<void>;
  replace(config: BrandingConfig): Promise<void>;
  resetAll(): Promise<void>;
}

export const useBrandingStore = create<BrandingState>((set, get) => ({
  branding: DEFAULT_BRANDING,
  loaded: false,

  async load() {
    set({ branding: await loadBranding(), loaded: true });
  },

  async update(patch) {
    const branding = { ...get().branding, ...patch };
    set({ branding });
    await saveBranding(branding);
  },

  async setLogo(slot, logo) {
    const current = get().branding;
    const logos = { ...current.logos };
    if (logo) logos[slot] = logo;
    else delete logos[slot];
    const branding = { ...current, logos };
    set({ branding });
    await saveBranding(branding);
  },

  async replace(config) {
    set({ branding: config });
    await saveBranding(config);
  },

  async resetAll() {
    set({ branding: DEFAULT_BRANDING });
    await saveBranding(DEFAULT_BRANDING);
  },
}));
