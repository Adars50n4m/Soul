import type { TheaterSessionMeta } from '../types';

/**
 * Theater Mode metadata round-trip codec.
 *
 * The `messages` table on Supabase + the local SQLite mirror only persist
 * flat media columns (media_url, media_type, media_thumbnail, media_caption,
 * media_duration). Anything richer than that is dropped at the DB boundary,
 * which means the nested `media.theater` object disappears the moment the
 * message gets read back via Realtime / fetch / poll.
 *
 * To survive that round-trip we hijack the otherwise-unused `media_caption`
 * column for theater_session messages and stuff the JSON-encoded meta there
 * with a versioned marker. The decode path detects the marker, restores
 * `media.theater`, and clears `media.caption` so user-facing UI doesn't show
 * the raw JSON blob.
 *
 * Versioning: bump V1 → V2 if we ever change the meta shape in a non-additive
 * way; the decode path stays backwards-compatible with both markers.
 */
export const THEATER_META_MARKER = '__THEATER_META_V1__:';

export const encodeTheaterMetaIntoCaption = (meta: TheaterSessionMeta | undefined): string => {
    if (!meta) return '';
    try {
        return `${THEATER_META_MARKER}${JSON.stringify(meta)}`;
    } catch {
        return '';
    }
};

export const decodeTheaterMetaFromCaption = (
    caption: string | null | undefined,
): { meta: TheaterSessionMeta | undefined; remainingCaption: string | undefined } => {
    if (!caption || typeof caption !== 'string') {
        return { meta: undefined, remainingCaption: caption ?? undefined };
    }
    if (!caption.startsWith(THEATER_META_MARKER)) {
        return { meta: undefined, remainingCaption: caption };
    }
    try {
        const json = caption.slice(THEATER_META_MARKER.length);
        const meta = JSON.parse(json) as TheaterSessionMeta;
        return { meta, remainingCaption: undefined };
    } catch (err) {
        console.warn('[TheaterMeta] decode failed:', err);
        return { meta: undefined, remainingCaption: undefined };
    }
};

/**
 * Apply the decode in place on a media object so callers don't have to wire
 * remainingCaption back manually. Mutates and returns the same object for
 * convenience.
 *
 * IMPORTANT: we deliberately do NOT clear `media.caption` after decoding.
 * The caption is the only persisted source of truth for theater meta — if
 * we strip it here, `persistRemoteMessageRow` writes NULL back to SQLite
 * and the next read can't repopulate `media.theater`, which makes
 * TheaterSessionCard treat the bubble as orphan → "Ended" forever. The
 * raw marker is hidden from the user inside MessageBubble's
 * `showStandaloneCaption` gate, so leaving it on `media.caption` is safe.
 */
export const hydrateTheaterMediaFromCaption = (media: any): any => {
    if (!media || media.type !== 'theater_session') return media;
    const { meta } = decodeTheaterMetaFromCaption(media.caption);
    if (meta) {
        media.theater = { ...(media.theater || {}), ...meta };
    }
    return media;
};
