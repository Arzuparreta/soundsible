/**
 * What the Windows desktop shell injects into its player window: the theme it
 * should paint its own frame with. Media controls stay with the browser's Media
 * Session; the native media bridge served only the Linux app, which is gone.
 */
export interface DesktopBridge {
  appearance(theme: string, colors: Record<string, string>): Promise<void>;
}

export function desktopBridge(): DesktopBridge | undefined {
  return (window as Window & { __SOUNDSIBLE_DESKTOP__?: DesktopBridge }).__SOUNDSIBLE_DESKTOP__;
}
