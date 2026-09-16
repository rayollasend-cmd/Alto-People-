import { apiFetch } from './api';

/* ---- The in-app messenger ------------------------------------------ */

export interface MessagePerson {
  id: string;
  name: string;
  role: string;
  roleLabel: string;
  photoUrl: string | null;
}

export interface ConversationRow {
  id: string;
  kind: 'DIRECT' | 'GROUP' | 'STORE_CHANNEL';
  title: string;
  participants: MessagePerson[];
  lastMessageAt: string | null;
  lastPreview: string | null;
  unread: number;
}

export interface MessageRow {
  id: string;
  kind: 'TEXT' | 'SYSTEM';
  body: string;
  senderId: string | null;
  senderName: string | null;
  senderRole: string | null;
  mine: boolean;
  attachment: { url: string; name: string | null; type: string | null } | null;
  createdAt: string;
}

export interface ThreadPayload {
  id: string;
  kind: ConversationRow['kind'];
  title: string;
  participants: Array<MessagePerson & { lastReadAt: string | null }>;
  seenUpTo: string | null;
  hasMore: boolean;
  messages: MessageRow[];
}

export function listConversations(): Promise<{ conversations: ConversationRow[] }> {
  return apiFetch('/messages/conversations');
}

export function unreadMessages(): Promise<{ unread: number }> {
  return apiFetch('/messages/unread');
}

export function messageDirectory(q: string): Promise<{ people: Array<MessagePerson & { clientName: string | null }> }> {
  return apiFetch(`/messages/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`);
}

export function startConversation(body: {
  participantIds: string[];
  title?: string;
  body?: string;
}): Promise<{ id: string }> {
  return apiFetch('/messages/conversations', { method: 'POST', body });
}

export function getThread(id: string, before?: string): Promise<ThreadPayload> {
  return apiFetch(`/messages/conversations/${id}${before ? `?before=${encodeURIComponent(before)}` : ''}`);
}

export function sendMessage(id: string, body: string): Promise<{ id: string; createdAt: string }> {
  return apiFetch(`/messages/conversations/${id}/messages`, { method: 'POST', body: { body } });
}

export async function sendPhoto(id: string, file: File, caption: string): Promise<void> {
  const fd = new FormData();
  fd.append('file', file);
  if (caption) fd.append('body', caption);
  const res = await fetch(`/api/messages/conversations/${id}/attachments`, {
    method: 'POST',
    body: fd,
    credentials: 'include',
  });
  if (!res.ok) {
    let message = 'Could not send the photo.';
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      message = j.error?.message ?? message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
}

export function markRead(id: string): Promise<void> {
  return apiFetch<void>(`/messages/conversations/${id}/read`, { method: 'POST' });
}

export function searchMessages(q: string): Promise<{
  results: Array<{
    conversationId: string;
    conversationTitle: string;
    messageId: string;
    body: string;
    senderName: string | null;
    createdAt: string;
  }>;
}> {
  return apiFetch(`/messages/search?q=${encodeURIComponent(q)}`);
}

export function transcriptUrl(id: string): string {
  return `/api/messages/conversations/${id}/transcript.csv`;
}
