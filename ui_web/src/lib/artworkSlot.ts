import { createContext, type Accessor } from 'solid-js';

/**
 * The width of the artwork slot, when the surrounding collection already
 * knows it. A bounded grid reads its column width once per resize; without
 * this every card's image would measure its own slot when it mounts, which is
 * a forced layout per card while the grid scrolls.
 */
export const ArtworkWidthContext = createContext<Accessor<number>>();
