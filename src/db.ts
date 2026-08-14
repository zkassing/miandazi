// db.ts — SQLite persistence for interview history + per-turn audio + markers.
//
// We use better-sqlite3 (synchronous, fast, single-file DB). All interview
// sessions and turns are written here in real time so a process restart
// doesn't lose history. The legacy in-memory `sessionStore` still drives
// the *active* interview (because it holds the LLM conversation state
// needed mid-flow), but it now mirrors to SQLite on every turn.

import Database, { type Database as DB } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '..', 'data')
const AUDIO_DIR = path.join(DATA_DIR, 'audio')
const DB_PATH = path.join(DATA_DIR, 'app.db')

// Ensure dirs exist before opening the DB.
fs.mkdirSync(AUDIO_DIR, { recursive: true })

let _db: DB | null = null
function getDb(): DB {
  if (_db) return _db
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  initSchema(_db)
  return _db
}

function initSchema(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      direction       TEXT NOT NULL,
      candidate_name  TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'active',  -- active | finished
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      end_reason      TEXT,
      total_rounds    INTEGER NOT NULL DEFAULT 0,
      final_score     REAL,
      verdict         TEXT,
      summary         TEXT,
      report_json     TEXT
    );

    CREATE TABLE IF NOT EXISTS turns (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      round           INTEGER NOT NULL,
      question        TEXT NOT NULL DEFAULT '',
      answer          TEXT NOT NULL DEFAULT '',
      topic           TEXT,
      sample_answer   TEXT,
      audio_path      TEXT,                            -- relative to data/audio/, e.g. "iv_x_1.wav"
      audio_bytes     INTEGER,
      stt_elapsed_ms  INTEGER,
      llm_elapsed_ms  INTEGER,
      tts_elapsed_ms  INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, round);

    CREATE TABLE IF NOT EXISTS markers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      round       INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      label       TEXT NOT NULL                       -- e.g. "已标记 @ 轮 2 14:23:11"
    );
    CREATE INDEX IF NOT EXISTS idx_markers_session ON markers(session_id, created_at);
  `)

  // Lightweight migration: add report_json to existing sessions tables
  // (idempotent — `ADD COLUMN` fails if the column already exists, so we
  // catch and ignore).
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN report_json TEXT`)
  } catch {
    /* already present */
  }
}

/* =========================================================
 *  Sessions
 * ========================================================= */

export interface SessionRow {
  id: string
  direction: string
  candidate_name: string
  status: 'active' | 'finished'
  started_at: number
  ended_at: number | null
  end_reason: string | null
  total_rounds: number
  final_score: number | null
  verdict: string | null
  summary: string | null
}

export function insertSession(s: Omit<SessionRow, 'total_rounds' | 'final_score' | 'verdict' | 'summary' | 'ended_at' | 'end_reason'>): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sessions
         (id, direction, candidate_name, status, started_at)
       VALUES (@id, @direction, @candidate_name, @status, @started_at)`,
    )
    .run({
      id: s.id,
      direction: s.direction,
      candidate_name: s.candidate_name,
      status: s.status,
      started_at: s.started_at,
    })
}

export function updateSessionFinished(
  id: string,
  ended_at: number,
  end_reason: string,
  total_rounds: number,
): void {
  getDb()
    .prepare(
      `UPDATE sessions
         SET status = 'finished', ended_at = ?, end_reason = ?, total_rounds = ?
       WHERE id = ?`,
    )
    .run(ended_at, end_reason, total_rounds, id)
}

export function updateSessionReport(
  id: string,
  score: number,
  verdict: string,
  summary: string,
): void {
  getDb()
    .prepare(
      `UPDATE sessions SET final_score = ?, verdict = ?, summary = ? WHERE id = ?`,
    )
    .run(score, verdict, summary, id)
}

/** Persist the full report JSON so history pages can show per-question
 *  details + radar even after the in-memory session has been dropped. */
export function saveFullReport(id: string, report: object): void {
  getDb()
    .prepare(`UPDATE sessions SET report_json = ? WHERE id = ?`)
    .run(JSON.stringify(report), id)
}

export function loadFullReport(id: string): object | null {
  const row = getDb()
    .prepare(`SELECT report_json FROM sessions WHERE id = ?`)
    .get(id) as { report_json: string | null } | undefined
  if (!row?.report_json) return null
  try {
    return JSON.parse(row.report_json)
  } catch {
    return null
  }
}

export function listSessions(): SessionRow[] {
  return getDb()
    .prepare(`SELECT * FROM sessions ORDER BY started_at DESC`)
    .all() as SessionRow[]
}

export function getSessionRow(id: string): SessionRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined
  return row || null
}

export function deleteSessionRow(id: string): void {
  // Cascades to turns + markers (FK ON DELETE CASCADE)
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
  // Best-effort: remove the audio files
  const audioFiles = getDb()
    .prepare(`SELECT audio_path FROM turns WHERE session_id = ? AND audio_path IS NOT NULL`)
    .all(id) as Array<{ audio_path: string }>
  for (const f of audioFiles) {
    const p = path.join(AUDIO_DIR, f.audio_path)
    try {
      fs.unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
}

/* =========================================================
 *  Turns
 * ========================================================= */

export interface TurnRow {
  id: number
  session_id: string
  round: number
  question: string
  answer: string
  topic: string | null
  sample_answer: string | null
  audio_path: string | null
  audio_bytes: number | null
  stt_elapsed_ms: number | null
  llm_elapsed_ms: number | null
  tts_elapsed_ms: number | null
  created_at: number
}

export function insertTurn(t: Omit<TurnRow, 'id'>): number {
  const info = getDb()
    .prepare(
      `INSERT INTO turns
         (session_id, round, question, answer, topic, sample_answer,
          audio_path, audio_bytes, stt_elapsed_ms, llm_elapsed_ms, tts_elapsed_ms, created_at)
       VALUES
         (@session_id, @round, @question, @answer, @topic, @sample_answer,
          @audio_path, @audio_bytes, @stt_elapsed_ms, @llm_elapsed_ms, @tts_elapsed_ms, @created_at)`,
    )
    .run(t)
  return Number(info.lastInsertRowid)
}

export function listTurns(sessionId: string): TurnRow[] {
  return getDb()
    .prepare(`SELECT * FROM turns WHERE session_id = ? ORDER BY round ASC, id ASC`)
    .all(sessionId) as TurnRow[]
}

/** Update a turn's answer + audio path after the candidate submits. */
export function updateTurnAnswer(
  sessionId: string,
  round: number,
  answer: string,
  audioPath: string | null,
  audioBytes: number | null,
  sttElapsedMs: number | null,
): void {
  getDb()
    .prepare(
      `UPDATE turns
         SET answer = ?, audio_path = ?, audio_bytes = ?, stt_elapsed_ms = ?
         WHERE session_id = ? AND round = ?`,
    )
    .run(answer, audioPath, audioBytes, sttElapsedMs, sessionId, round)
}

export function getTurnAudioPath(turnId: number): string | null {
  const row = getDb()
    .prepare(`SELECT audio_path FROM turns WHERE id = ?`)
    .get(turnId) as { audio_path: string | null } | undefined
  if (!row?.audio_path) return null
  return path.join(AUDIO_DIR, row.audio_path)
}

/* =========================================================
 *  Markers
 * ========================================================= */

export interface MarkerRow {
  id: number
  session_id: string
  round: number
  created_at: number
  label: string
}

export function insertMarker(sessionId: string, round: number, label: string, createdAt: number): MarkerRow {
  const info = getDb()
    .prepare(
      `INSERT INTO markers (session_id, round, created_at, label) VALUES (?, ?, ?, ?)`,
    )
    .run(sessionId, round, createdAt, label)
  return {
    id: Number(info.lastInsertRowid),
    session_id: sessionId,
    round,
    created_at: createdAt,
    label,
  }
}

export function listMarkers(sessionId: string): MarkerRow[] {
  return getDb()
    .prepare(`SELECT * FROM markers WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as MarkerRow[]
}

/* =========================================================
 *  Audio file storage
 * ========================================================= */

/** Write a WAV buffer to disk and return the relative path. */
export function writeAudioFile(sessionId: string, round: number, wav: Buffer): string {
  // Round is the candidate's answer round (1-indexed). Use round-1 since
  // there are typically (maxRounds) answers but rounds 1..N.
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const filename = `${safeId}_r${round}.wav`
  const fullPath = path.join(AUDIO_DIR, filename)
  fs.writeFileSync(fullPath, wav)
  return filename
}

export function getAudioDir(): string {
  return AUDIO_DIR
}
