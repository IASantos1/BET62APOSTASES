import type { LiveEvent, LiveOdds, LiveSelection } from "./types";

function sanitizeSelection(selection: LiveSelection): LiveSelection {
  const { sourceBookmaker: _sourceBookmaker, ...rest } = selection;
  return rest;
}

function sanitizeOdds(odds: LiveOdds): LiveOdds {
  const { sourceBookmaker: _sourceBookmaker, selections, ...rest } = odds;
  return {
    ...rest,
    selections: Object.fromEntries(
      Object.entries(selections ?? {}).map(([label, selection]) => [label, sanitizeSelection(selection)])
    ),
  };
}

export function sanitizePublicEvent(event: LiveEvent): LiveEvent {
  return {
    ...event,
    odds: (event.odds ?? []).map(sanitizeOdds),
  };
}

export function sanitizePublicEvents(events: LiveEvent[]): LiveEvent[] {
  return events.map(sanitizePublicEvent);
}
