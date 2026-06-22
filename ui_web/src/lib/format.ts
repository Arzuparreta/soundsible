/** Spanish track-count label with correct singular/plural: "1 pista" / "N pistas". */
export const trackCount = (n: number): string => `${n} ${n === 1 ? 'pista' : 'pistas'}`;
