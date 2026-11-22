/**
 * ConversationStore: conversation + message persistence on AppDb.
 *
 * Replaces the in-memory Maps in main.ts. Messages are stored losslessly as
 * full ChatMessage JSON — one row per message, position-ordered — so tool
 * calls, tool results, and images round-trip exactly.
 *
 * main.ts replaces the transcript at the start of a turn, then appends
 * each assistant/tool message through the loop's onMessage callback.
 * Full transcripts therefore survive restart and remain available even
 * when the model's context is compacted.
 */

import type { AppDb } from "./db";
import type { ChatMessage, Conversation } from "../ipc";

interface ConvRow {
  id: string;
  connection_id: string;
  model_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export class ConversationStore {
  constructor(private readonly db: AppDb) {}

  list(connectionId?: string): Conversation[] {
    const rows = connectionId
      ? this.db.all<ConvRow>(
          "SELECT * FROM conversations WHERE connection_id = ? ORDER BY updated_at DESC",
          [connectionId],
        )
      : this.db.all<ConvRow>("SELECT * FROM conversations ORDER BY updated_at DESC");
    return rows.map(toConversation);
  }

  get(conversationId: string): Conversation | undefined {
    const row = this.db.get<ConvRow>("SELECT * FROM conversations WHERE id = ?", [conversationId]);
    return row ? toConversation(row) : undefined;
  }

  create(connectionId: string, modelId: string): Conversation {
    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const conv: Conversation = {
      id,
      connectionId,
      modelId,
      title: "new conversation",
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      "INSERT INTO conversations (id, connection_id, model_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      [id, connectionId, modelId, conv.title, now, now],
    );
    return conv;
  }

  /** Messages of a conversation, oldest first (empty if unknown). */
  load(conversationId: string): ChatMessage[] {
    const rows = this.db.all<{ json: string }>(
      "SELECT json FROM messages WHERE conversation_id = ? ORDER BY position",
      [conversationId],
    );
    return rows.map((r) => {
      try {
        return JSON.parse(r.json) as ChatMessage;
      } catch {
        return { role: "user" as const, content: r.json };
      }
    });
  }

  /** Replace a conversation's stored messages (start of a turn). */
  replaceMessages(conversationId: string, messages: ChatMessage[]): void {
    this.db.transaction(() => {
    this.db.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
    for (let i = 0; i < messages.length; i++) {
      this.db.run(
        "INSERT OR REPLACE INTO messages (conversation_id, position, role, json) VALUES (?,?,?,?)",
        [conversationId, i, messages[i].role, JSON.stringify(messages[i])],
      );
    }
    this.touch(conversationId);
    const first = messages.find(m => m.role === "user")?.content;
    if (first) this.db.run("UPDATE conversations SET title = ? WHERE id = ? AND title = ?", [first.slice(0, 70), conversationId, "new conversation"]);
    });
  }

  /** Append one message (the final assistant answer of a turn). */
  append(conversationId: string, msg: ChatMessage): void {
    const next =
      this.db
        .get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", [
          conversationId,
        ])
        ?.n ?? 0;
    this.db.run(
      "INSERT OR REPLACE INTO messages (conversation_id, position, role, json) VALUES (?,?,?,?)",
      [conversationId, next, msg.role, JSON.stringify(msg)],
    );
    this.touch(conversationId);
  }

  rename(conversationId:string,title:string):void {
    if(!title.trim() || title.length>120)throw Error("Use a title of 1–120 characters");
    this.db.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",[title.trim(),new Date().toISOString(),conversationId]);
  }

  delete(conversationId: string): void {
    this.db.run("DELETE FROM messages WHERE conversation_id = ?", [conversationId]);
    this.db.run("DELETE FROM conversations WHERE id = ?", [conversationId]);
  }

  private touch(conversationId: string): void {
    this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [
      new Date().toISOString(),
      conversationId,
    ]);
  }
}

function toConversation(r: ConvRow): Conversation {
  return {
    id: r.id,
    connectionId: r.connection_id,
    modelId: r.model_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
