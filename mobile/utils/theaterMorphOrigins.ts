// Module-level cache of where each theater session's CARD is sitting on the
// chat screen at the moment Join is tapped. The theater screen reads this on
// mount to animate FROM those exact card coordinates UP TO a full-screen
// video area, then on close animates back DOWN to the same rect.
//
// Why a module-level Map and not router params: the rect mutates whenever the
// chat list scrolls, the screen rotates, or the card re-measures after a
// re-render. Router params are stringified URL state — we'd lose the freshness
// guarantee. A live in-memory Map keyed by sessionId stays in sync with the
// real DOM position right up to the moment of navigation, and the theater
// screen consults it synchronously during its first render.

export interface TheaterMorphRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

const origins = new Map<string, TheaterMorphRect>();

export const setTheaterMorphOrigin = (sessionId: string, rect: TheaterMorphRect) => {
    origins.set(sessionId, rect);
};

export const getTheaterMorphOrigin = (sessionId: string): TheaterMorphRect | null => {
    return origins.get(sessionId) || null;
};

export const clearTheaterMorphOrigin = (sessionId: string) => {
    origins.delete(sessionId);
};
