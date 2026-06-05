import Database from "better-sqlite3";
import { existsSync } from "fs";
import { activeStateDbPath } from "./utils";
import type { Attachment } from "../shared/attachments";
import { isImageMime, MAX_IMAGE_BYTES } from "../shared/attachments";

const TABLE = "desktop_message_attachments";

interface StoredAttachmentRow {
  message_id: number;
  ordinal: number;
  name: string;
  mime: string;
  size: number;
  data: Buffer;
}

function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'image',
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      data BLOB NOT NULL,
      created_at REAL NOT NULL DEFAULT (strftime('%s', 'now')),
      UNIQUE(message_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_session
      ON ${TABLE}(session_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_message
      ON ${TABLE}(message_id);
  `);
}

function tableExists(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(TABLE) as { name: string } | undefined;
  return !!row;
}

export function stripTrailingImagePlaceholders(text: string): string {
  let out = text || "";
  for (;;) {
    const next = out.replace(/(?:\s*\[(?:screenshot|image)\]\s*)$/i, "");
    if (next === out) return out.trim();
    out = next;
  }
}

function normalizedPromptText(text: string): string {
  return stripTrailingImagePlaceholders(text).replace(/\s+/g, " ").trim();
}

function hasTrailingImagePlaceholder(text: string): boolean {
  return /\[(?:screenshot|image)\]\s*$/i.test(text || "");
}

function parseImageDataUrl(dataUrl: string): { mime: string; data: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!match) return null;
  const mime = match[1].toLowerCase();
  if (!isImageMime(mime)) return null;
  const data = Buffer.from(match[2], "base64");
  if (data.length <= 0 || data.length > MAX_IMAGE_BYTES) return null;
  return { mime, data };
}

function imageAttachments(attachments?: Attachment[]): Attachment[] {
  return (attachments || []).filter(
    (a) => a.kind === "image" && typeof a.dataUrl === "string",
  );
}

function findMatchingUserMessageId(
  db: Database.Database,
  sessionId: string,
  promptText: string,
): number | null {
  const target = normalizedPromptText(promptText);

  const rows = db
    .prepare(
      `SELECT id, content
       FROM messages
       WHERE session_id = ? AND role = 'user'
       ORDER BY id DESC
       LIMIT 50`,
    )
    .all(sessionId) as Array<{ id: number; content: string | null }>;

  const hasAttachments = db.prepare(
    `SELECT 1 FROM ${TABLE} WHERE message_id = ? LIMIT 1`,
  );

  for (const row of rows) {
    const content = row.content || "";
    if (content.startsWith("\x00json:")) continue;
    if (normalizedPromptText(content) !== target) continue;
    if (!target && !hasTrailingImagePlaceholder(content)) continue;
    if (hasAttachments.get(row.id)) continue;
    return row.id;
  }

  return null;
}

export function persistPromptImageAttachments(
  sessionId: string | undefined,
  promptText: string,
  attachments?: Attachment[],
): void {
  if (!sessionId) return;
  const images = imageAttachments(attachments);
  if (images.length === 0) return;

  const dbPath = activeStateDbPath();
  if (!existsSync(dbPath)) return;

  const db = new Database(dbPath);
  try {
    ensureTable(db);
    const messageId = findMatchingUserMessageId(db, sessionId, promptText);
    if (!messageId) return;

    const insert = db.prepare(
      `INSERT OR REPLACE INTO ${TABLE}
       (message_id, session_id, ordinal, kind, name, mime, size, data)
       VALUES (?, ?, ?, 'image', ?, ?, ?, ?)`,
    );

    const tx = db.transaction(() => {
      images.forEach((attachment, index) => {
        const parsed = parseImageDataUrl(attachment.dataUrl || "");
        if (!parsed) return;
        insert.run(
          messageId,
          sessionId,
          index,
          attachment.name || `image-${index + 1}`,
          parsed.mime,
          attachment.size || parsed.data.length,
          parsed.data,
        );
      });
    });
    tx();
  } finally {
    db.close();
  }
}

export function loadPromptImageAttachments(
  db: Database.Database,
  sessionId: string,
): Map<number, Attachment[]> {
  const byMessageId = new Map<number, Attachment[]>();
  if (!tableExists(db)) return byMessageId;

  const rows = db
    .prepare(
      `SELECT message_id, ordinal, name, mime, size, data
       FROM ${TABLE}
       WHERE session_id = ? AND kind = 'image'
       ORDER BY message_id, ordinal`,
    )
    .all(sessionId) as StoredAttachmentRow[];

  for (const row of rows) {
    if (!isImageMime(row.mime)) continue;
    const bucket = byMessageId.get(row.message_id) || [];
    bucket.push({
      id: `db-att-${row.message_id}-${row.ordinal}`,
      kind: "image",
      name: row.name,
      mime: row.mime,
      size: row.size,
      dataUrl: `data:${row.mime};base64,${Buffer.from(row.data).toString("base64")}`,
    });
    byMessageId.set(row.message_id, bucket);
  }

  return byMessageId;
}

export function deletePromptImageAttachmentsForSession(
  db: Database.Database,
  sessionId: string,
): void {
  if (!tableExists(db)) return;
  db.prepare(`DELETE FROM ${TABLE} WHERE session_id = ?`).run(sessionId);
}
