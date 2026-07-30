export type MobileVisualContent = 'cover' | 'lyrics';

export interface MobileVisualState {
  content: MobileVisualContent;
  queueOpen: boolean;
}

export const initialMobileVisualState: MobileVisualState = {
  content: 'cover',
  queueOpen: false,
};

export function toggleMobileLyrics(state: MobileVisualState): MobileVisualState {
  return {
    content: state.content === 'lyrics' ? 'cover' : 'lyrics',
    queueOpen: false,
  };
}

export function toggleMobileQueue(state: MobileVisualState): MobileVisualState {
  return {
    ...state,
    queueOpen: !state.queueOpen,
  };
}
