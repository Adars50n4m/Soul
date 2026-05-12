// Module-level cache of where each status' source thumbnail is sitting on
// screen at the moment the user taps to open it. The view-status screen
// reads this on mount and animates FROM those exact coordinates UP TO a
// full-bleed status layout, then on close animates back DOWN to the same
// rect. Mirrors the theater morph utility — see theaterMorphOrigins.ts for
// the rationale (router params are stringified state, this Map stays in
// sync with the live DOM position right up to navigation).

export interface StatusMorphRect {
    x: number;
    y: number;
    width: number;
    height: number;
    borderRadius?: number;
}

const origins = new Map<string, StatusMorphRect>();

export const setStatusMorphOrigin = (key: string, rect: StatusMorphRect) => {
    origins.set(key, rect);
};

export const getStatusMorphOrigin = (key: string): StatusMorphRect | null => {
    return origins.get(key) || null;
};

export const clearStatusMorphOrigin = (key: string) => {
    origins.delete(key);
};
