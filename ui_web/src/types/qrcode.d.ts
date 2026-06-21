/**
 * Minimal ambient types for the vendored `qrcode` ESM bundle
 * (src/lib/vendor/qrcode.esm.js). We only use toDataURL.
 */
declare module '*/qrcode.esm.js' {
  interface QrToDataUrlOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    color?: { dark?: string; light?: string };
  }
  const QRCode: {
    toDataURL(text: string, opts?: QrToDataUrlOptions): Promise<string>;
  };
  export default QRCode;
}
