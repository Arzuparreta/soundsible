interface Window {
  /** Internal handshake between the inline HTML launch screen and Solid. */
  __SOUNDSIBLE_BOOT__?: {
    stylesReady: Promise<void>;
    start(): void;
    styleLoaded(link: HTMLLinkElement): void;
    complete(): void;
    fail(): void;
  };
}
