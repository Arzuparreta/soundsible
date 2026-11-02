export type MobileVisualContent = 'cover' | 'lyrics';

export interface MobileVisualState {
  content: MobileVisualContent;
}

export const initialMobileVisualState: MobileVisualState = {
  content: 'cover',
};

export function toggleMobileLyrics(state: MobileVisualState): MobileVisualState {
  return {
    content: state.content === 'lyrics' ? 'cover' : 'lyrics',
  };
}
