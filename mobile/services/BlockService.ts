import { SERVER_URL } from '../config/api';
import { supabase } from '../config/supabase';

export interface BlockRelationship {
  blockedByMe: boolean;
  blockedMe: boolean;
  eitherBlocked: boolean;
}

const EMPTY_RELATIONSHIP: BlockRelationship = {
  blockedByMe: false,
  blockedMe: false,
  eitherBlocked: false,
};

const toRelationship = (blockedByMe: boolean, blockedMe: boolean): BlockRelationship => ({
  blockedByMe,
  blockedMe,
  eitherBlocked: blockedByMe || blockedMe,
});

export const blockService = {
  async getRelationship(currentUserId: string, targetUserId: string): Promise<BlockRelationship> {
    if (!currentUserId || !targetUserId || currentUserId === targetUserId) {
      return EMPTY_RELATIONSHIP;
    }

    try {
      const res = await fetch(`${SERVER_URL}/api/blocks/status/${targetUserId}`, {
        headers: { 'x-user-id': currentUserId },
      });
      if (res.ok) {
        const data = (await res.json()) as { success?: boolean; blockedByMe?: boolean; blockedMe?: boolean };
        if (data?.success) {
          return toRelationship(!!data.blockedByMe, !!data.blockedMe);
        }
      }
    } catch (_) {}

    const { data } = await supabase
      .from('user_blocks')
      .select('blocker_id, blocked_id')
      .or(`and(blocker_id.eq.${currentUserId},blocked_id.eq.${targetUserId}),and(blocker_id.eq.${targetUserId},blocked_id.eq.${currentUserId})`);

    const blockedByMe = !!data?.some((row: any) => row.blocker_id === currentUserId && row.blocked_id === targetUserId);
    const blockedMe = !!data?.some((row: any) => row.blocker_id === targetUserId && row.blocked_id === currentUserId);
    return toRelationship(blockedByMe, blockedMe);
  },

  async getMyBlockMap(currentUserId: string): Promise<Record<string, BlockRelationship>> {
    if (!currentUserId) return {};

    try {
      const res = await fetch(`${SERVER_URL}/api/blocks`, {
        headers: { 'x-user-id': currentUserId },
      });
      if (res.ok) {
        const data = (await res.json()) as { success?: boolean; blocks?: any[] };
        if (data?.success && Array.isArray(data.blocks)) {
          return data.blocks.reduce((acc: Record<string, BlockRelationship>, row: any) => {
            const targetId = row.userId || row.id;
            if (!targetId) return acc;
            acc[targetId] = toRelationship(!!row.blockedByMe, !!row.blockedMe);
            return acc;
          }, {});
        }
      }
    } catch (_) {}

    const { data } = await supabase
      .from('user_blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${currentUserId},blocked_id.eq.${currentUserId}`);

    const next: Record<string, BlockRelationship> = {};
    for (const row of data || []) {
      const otherId = row.blocker_id === currentUserId ? row.blocked_id : row.blocker_id;
      const existing = next[otherId] || EMPTY_RELATIONSHIP;
      const blockedByMe = existing.blockedByMe || row.blocker_id === currentUserId;
      const blockedMe = existing.blockedMe || row.blocked_id === currentUserId;
      next[otherId] = toRelationship(blockedByMe, blockedMe);
    }
    return next;
  },

  async blockUser(currentUserId: string, targetUserId: string): Promise<void> {
    if (!currentUserId || !targetUserId || currentUserId === targetUserId) return;

    try {
      const res = await fetch(`${SERVER_URL}/api/blocks/${targetUserId}`, {
        method: 'POST',
        headers: {
          'x-user-id': currentUserId,
          'Content-Type': 'application/json',
        },
      });
      if (res.ok) return;
    } catch (_) {}

    const { error } = await supabase
      .from('user_blocks')
      .upsert({ blocker_id: currentUserId, blocked_id: targetUserId }, { onConflict: 'blocker_id,blocked_id' });
    if (error) throw error;
  },

  async unblockUser(currentUserId: string, targetUserId: string): Promise<void> {
    if (!currentUserId || !targetUserId || currentUserId === targetUserId) return;

    try {
      const res = await fetch(`${SERVER_URL}/api/blocks/${targetUserId}`, {
        method: 'DELETE',
        headers: { 'x-user-id': currentUserId },
      });
      if (res.ok) return;
    } catch (_) {}

    const { error } = await supabase
      .from('user_blocks')
      .delete()
      .match({ blocker_id: currentUserId, blocked_id: targetUserId });
    if (error) throw error;
  },
};
