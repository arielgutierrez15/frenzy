/** Client for the BAGZ social API. Every call that needs an account sends the session token. */
import { apiCall } from '../trading/api';
import { proxyBase } from '../providers/config';
import { getSession } from './session';

export interface UserSummary { id: string; username: string; avatarVer: number }
export interface Me extends UserSummary { bio: string; createdAt: number; complete: boolean }
export interface Stats { equity: number; deposits: number; pnl: number; pnlPct: number; realized: number; winRate: number; sells: number; trades: number; best: { symbol: string; pct: number } | null; updatedAt: number }
export type Activity = { id: number; t: number; user?: UserSummary } & (
  | { kind: 'trade'; side: 'BUY' | 'SELL'; mint: string; symbol: string; usd: number; price: number; pnl?: number }
  | { kind: 'thesis'; mint: string; symbol: string; bull: boolean; text: string });
export type Relation = 'self' | 'none' | 'requested' | 'incoming' | 'friends';
export interface Profile { user: UserSummary & { bio: string; createdAt: number }; stats: Stats | null; rank: number | null; friends: number; activity: Activity[]; relation: Relation }
export interface ChatSummary { id: string; name: string; members: UserSummary[]; memberCount: number; unread: number; lastAt: number; last: { body: string; username: string | null; t: number } | null }
export interface Message { id: number; body: string; t: number; system: boolean; user: UserSummary | null }

const tok = () => getSession().token || undefined;
const get = <T,>(path: string) => apiCall<T>(path, { token: tok() });
const post = <T,>(path: string, body: unknown, timeoutMs?: number) => apiCall<T>(path, { body, token: tok(), timeoutMs });

export const avatarUrl = (u: { id: string; avatarVer: number } | null | undefined) => {
  const base = proxyBase();
  return u && u.avatarVer > 0 && base ? `${base}/v1/avatars/${u.id}?v=${u.avatarVer}` : null;
};

export const signup = (username: string, password: string) => apiCall<{ token: string; expiresAt: number; user: Me }>('/auth/signup', { body: { username, password }, timeoutMs: 30_000 });
export const login = (username: string, password: string) => apiCall<{ token: string; expiresAt: number; user: Me }>('/auth/login', { body: { username, password }, timeoutMs: 30_000 });
export const logoutApi = () => post<{ ok: true }>('/auth/logout', {});
export const fetchMe = (token: string) => apiCall<{ user: Me }>('/me', { token });
export const uploadAvatar = (image: string) => post<{ user: Me }>('/me/avatar', { image }, 30_000);
export const saveBio = (bio: string) => post<{ user: Me }>('/me/profile', { bio });
export const deleteAccount = (password: string) => post<{ deleted: true }>('/me/delete', { password }, 30_000);
export const putStats = (s: unknown) => post<{ ok: true }>('/me/stats', s);
export const putActivity = (items: unknown[]) => post<{ added: number }>('/me/activity', { items });
export const getProfile = (username: string) => get<Profile>(`/users/${encodeURIComponent(username)}`);
export const searchUsers = (q: string) => get<{ users: UserSummary[] }>(`/users/search?q=${encodeURIComponent(q)}`);
export const getLeaderboard = (scope: 'global' | 'friends', sort: 'pnl_pct' | 'pnl' | 'win_rate') => get<{ rows: { rank: number; user: UserSummary; stats: Stats }[]; total: number; mine: { rank: number; stats: Stats } | null }>(`/leaderboard?scope=${scope}&sort=${sort}`);
export const getFriends = () => get<{ friends: UserSummary[]; incoming: UserSummary[]; outgoing: UserSummary[] }>('/friends');
export const requestFriend = (username: string) => post<{ status: Relation; user: UserSummary }>('/friends/request', { username });
export const respondFriend = (userId: string, accept: boolean) => post<{ status: Relation }>('/friends/respond', { userId, accept });
export const removeFriend = (userId: string) => post<{ status: Relation }>('/friends/remove', { userId });
export const friendsFeed = () => get<{ items: Activity[]; friends: number }>('/feed/friends');
export const listChats = () => get<{ chats: ChatSummary[]; unread: number }>('/chats');
export const createChat = (name: string, memberIds: string[]) => post<{ id: string }>('/chats', { name, memberIds });
export const getMessages = (id: string, after?: number) => get<{ chat: { id: string; name: string; members: UserSummary[] }; messages: Message[] }>(`/chats/${id}/messages${after ? `?after=${after}` : ''}`);
export const sendMessage = (id: string, body: string) => post<{ id: number; t: number }>(`/chats/${id}/messages`, { body });
export const addMembers = (id: string, userIds: string[]) => post<{ added: number }>(`/chats/${id}/members`, { userIds });
export const leaveChat = (id: string) => post<{ left: true }>(`/chats/${id}/leave`, {});
