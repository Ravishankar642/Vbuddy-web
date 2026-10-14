/** Lets the sheet's lists drive the (lazily loaded) map. */
export const mapBus: {
  /** Fly to a network pilot and open their popup. */
  focus: (callsign: string) => void;
  /** Draw a saved flight's route and fit the map to it (points are [lat, lon]); null clears it. */
  showRoute: (points: Array<[number, number]> | null) => void;
  /** Slide the bottom sheet down so the map shows (phones only; the side panel on wide screens never covers the map). */
  lowerSheet: () => void;
} = { focus: () => {}, showRoute: () => {}, lowerSheet: () => {} };
