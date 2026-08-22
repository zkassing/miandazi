// interviewOrchestrator.js — drives one turn of the interview.
//
// Flow per turn:
//   1. Take the candidate's audio, transcribe with MiMo ASR.
//   2. Append the transcript as a 'user' message to the DeepSeek conversation.
//   3. Ask DeepSeek for the next interviewer turn (JSON: { question, ...,
//      end_interview }).
//   4. Append the AI's 'question' as an 'assistant' message.
//   5. Synthesize the question with MiMo TTS and return everything to the
//      caller (HTTP handler) so the browser can play it.
//
// The first turn is special: there is no user message yet. We just call
// DeepSeek once to get the opening question.

import { transcribe, synthesize } from './mimoClient.ts';
import { deepseekChat, parseJsonLoose } from './deepseekClient.ts';
import {
  buildBaseSystemPrompt,
  REPORT_SYSTEM_PROMPT,
} from './interviewPrompts.ts';
import {
  createSession,
  getSession,
  touchSession,
  deleteSession,
} from './sessionStore.ts';
import {
  insertSession,
  insertTurn,
  updateSessionFinished,
  updateSessionReport,
  updateTurnAnswer,
  writeAudioFile,
  saveFullReport,
  getSessionRow,
  listTurns,
  loadFullReport,
} from './db.ts';

const OPENING_QUESTION_HINT =
  '这是面试的第一轮，请用一句简短的寒暄开场（比如"先简单介绍一下你自己吧"），然后给出你的问题。';

/**
 * Start a new interview session. Returns the session id and the first
 * question (text + synthesized audio).
 */
export async function startInterview({
  direction,
  jdText,
  candidateName,
  maxRounds, // accepted for backward-compat but ignored
  voice,
  ttsFormat,
}) {
  const systemPrompt = buildBaseSystemPrompt({
    direction,
    jdText,
    candidateName,
    maxRounds: Infinity,
  });
  const session = createSession({
    direction,
    jdText,
    candidateName,
    // No round cap — the interview runs until the candidate ends it.
    maxRounds: Infinity,
    voice: voice || 'mimo_default',
    ttsFormat: ttsFormat || 'wav',
    systemPrompt,
  });

  // Ask DeepSeek for the opening question.
  const messages = [
    ...session.messages,
    { role: 'user', content: OPENING_QUESTION_HINT },
  ];
  const llmT0 = Date.now();
  const { content } = await deepseekChat({
    messages,
    temperature: 0.7,
    jsonMode: true,
  });
  const llmElapsedMs = Date.now() - llmT0;
  const parsed = parseJsonLoose(content) || {};

  const question = String(parsed.question || '').trim()
    || '请先简单介绍一下你自己。';
  const endInterview = Boolean(parsed.end_interview);
  const topic = parsed.topic || 'behavioral';
  const sampleAnswer = String(parsed.sample_answer || '').trim();

  // Persist
  session.messages.push({ role: 'user', content: OPENING_QUESTION_HINT, meta: { kind: 'opening_hint' } });
  session.messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
  session.turns.push({
    round: 1,
    question,
    answer: '',
    sampleAnswer,
    createdAt: Date.now(),
    llmElapsedMs,
  });
  if (endInterview) {
    session.finished = true;
    session.endedAt = Date.now();
    session.endReason = 'candidate_request';
  }
  touchSession(session);

  // Persist to SQLite (real-time so a crash doesn't lose history).
  insertSession({
    id: session.id,
    direction: session.direction,
    candidate_name: session.candidateName || '',
    status: session.finished ? 'finished' : 'active',
    started_at: session.createdAt,
  });
  // Insert the first turn (the question AI just asked) with no answer yet.
  insertTurn({
    session_id: session.id,
    round: 1,
    question,
    answer: '',
    topic,
    sample_answer: sampleAnswer,
    audio_path: null,
    audio_bytes: null,
    stt_elapsed_ms: null,
    llm_elapsed_ms: llmElapsedMs,
    tts_elapsed_ms: null,
    created_at: Date.now(),
  });

  // TTS
  const ttsT0 = Date.now();
  const audio = await synthesize({
    text: question,
    voice: session.voice,
    format: session.ttsFormat,
  }).catch((err) => ({ error: err.message, fallbackText: question }));
  const ttsElapsedMs = Date.now() - ttsT0;

  return {
    sessionId: session.id,
    round: 1,
    question,
    topic,
    sampleAnswer,
    endInterview,
    tts: {
      audioBase64: audio.audioBase64 || null,
      mime: audio.mime || null,
      format: audio.format || session.ttsFormat,
      elapsedMs: ttsElapsedMs,
      fallbackText: audio.fallbackText || null,
      error: audio.error || null,
    },
    meta: {
      direction: session.direction,
      maxRounds: session.maxRounds,
    },
  };
}

/**
 * Submit the candidate's audio and get the next question (or the report).
 *
 * @param {string} sessionId
 * @param {object} opts
 * @param {Buffer} opts.audioBuffer
 * @param {string} opts.audioFilename
 * @param {string} [opts.language]  - 'zh' | 'en' | ''
 * @param {string} [opts.textOverride] - if the browser already produced
 *   text (e.g. via Web Speech API fallback) we can skip ASR by passing it
 *   here. The audio is still recorded for the transcript.
 */
export async function submitTurn(sessionId, { audioBuffer, audioFilename, language, textOverride }) {
  const session = getSession(sessionId);
  if (!session) {
    const e = new Error('Interview session not found or expired.');
    e.statusCode = 404;
    throw e;
  }
  if (session.finished) {
    return { sessionId, finished: true, question: null, tts: null, endInterview: true };
  }

  // 1. STT
  // NOTE: 这个变量必须在任何 return 之前声明。之前它声明在下面的「2. Fill the
  // answer」段落里，但上面的 no_speech_detected 分支就已经引用了 currentRound —— 命中
  // TDZ，抛 ReferenceError，被路由层变成 500。前端于是走进 catch 弹「提交失败」，
  // 而整段录音就此丢失。这是「录音在录但界面回到开始录制」的服务端侧成因之一。
  const currentRound = session.turns.length;
  let transcript = (textOverride || '').trim();
  let sttElapsedMs = 0;
  if (!transcript) {
    const sttT0 = Date.now();
    const r = await transcribe({
      buffer: audioBuffer,
      filename: audioFilename,
      language: language || 'zh',
    });
    sttElapsedMs = Date.now() - sttT0;
    transcript = (r.text || '').trim();
  }
  if (!transcript) {
    // STT returned an empty string. This usually means the recording was
    // effectively silent (or noise-only). We don't surface this as an
    // error — we let the front-end decide what to do (typically: show
    // a "didn't catch that" toast and let the user retry the same
    // question without burning a turn).
    return {
      sessionId: session.id,
      round: currentRound,
      question: null,
      topic: null,
      sampleAnswer: '',
      endInterview: false,
      transcript: '',
      emptyReason: 'no_speech_detected',
      tts: null,
    };
  }

  // 2. Fill the answer on the last turn
  const currentTurn = session.turns[currentRound - 1];
  if (currentTurn) {
    currentTurn.answer = transcript;
    currentTurn.audioBytes = audioBuffer?.length || 0;
    currentTurn.sttElapsedMs = sttElapsedMs;
  }

  // 2b. Persist audio + answer to SQLite. The browser already transcodes
  // to 16kHz mono WAV before upload (see composables/useRecorder.ts), so
  // we can write the buffer as-is.
  let audioPath: string | null = null;
  if (audioBuffer && audioBuffer.length > 0) {
    try {
      audioPath = writeAudioFile(session.id, currentRound, audioBuffer);
    } catch (err) {
      // Don't fail the turn if the disk is full — the report will just
      // not have audio for this round.
      console.warn('[orchestrator] failed to write audio file:', err);
    }
  }

  // 3. Append user message
  session.messages.push({ role: 'user', content: transcript });

  // 4. Ask DeepSeek
  const llmT0 = Date.now();
  const { content } = await deepseekChat({
    messages: session.messages,
    temperature: 0.7,
    jsonMode: true,
  });
  const llmElapsedMs = Date.now() - llmT0;
  const parsed = parseJsonLoose(content) || {};
  const question = String(parsed.question || '').trim();
  // The interview only ends when the candidate explicitly says so (the LLM
  // is instructed to only set end_interview=true in that case). There is
  // no round cap, so we don't force-end here.
  const endInterview = Boolean(parsed.end_interview);
  const topic = parsed.topic || 'behavioral';
  const sampleAnswer = String(parsed.sample_answer || '').trim();

  // 5. Append assistant message (we store the JSON form, not just the
  //    question, so the model can keep its internal state consistent on
  //    the next call).
  session.messages.push({ role: 'assistant', content: JSON.stringify(parsed) });

  // 6. Record the next turn
  const nextRound = currentRound + 1;
  if (!endInterview && question) {
    session.turns.push({
      round: nextRound,
      question,
      answer: '',
      sampleAnswer,
      createdAt: Date.now(),
    });
  }

  if (endInterview) {
    session.finished = true;
    session.endedAt = Date.now();
    session.endReason = 'candidate_request';
  }
  touchSession(session);

  // 6b. Persist the answered turn + (if any) the new question to SQLite.
  // The current turn's row was created at startInterview (or by the
  // previous turn), so we UPDATE it with the new answer + audio path.
  try {
    updateTurnAnswer(
      session.id,
      currentRound,
      transcript,
      audioPath,
      audioBuffer?.length || 0,
      sttElapsedMs,
    )
    if (!endInterview && question) {
      insertTurn({
        session_id: session.id,
        round: nextRound,
        question,
        answer: '',
        topic,
        sample_answer: sampleAnswer,
        audio_path: null,
        audio_bytes: null,
        stt_elapsed_ms: null,
        llm_elapsed_ms: llmElapsedMs,
        tts_elapsed_ms: null,
        created_at: Date.now(),
      })
    }
    if (endInterview) {
      updateSessionFinished(session.id, session.endedAt!, session.endReason!, session.turns.length)
    }
  } catch (err) {
    console.warn('[orchestrator] failed to mirror turn to SQLite:', err)
  }

  // 7. TTS — skip if ending
  let ttsResult = null;
  if (question) {
    const ttsT0 = Date.now();
    try {
      const audio = await synthesize({
        text: question,
        voice: session.voice,
        format: session.ttsFormat,
      });
      ttsResult = {
        audioBase64: audio.audioBase64,
        mime: audio.mime,
        format: audio.format,
        elapsedMs: Date.now() - ttsT0,
        fallbackText: null,
        error: null,
      };
    } catch (err) {
      // TTS failure shouldn't kill the interview. The browser can show the
      // text and use a local voice if needed.
      ttsResult = {
        audioBase64: null,
        mime: null,
        format: session.ttsFormat,
        elapsedMs: Date.now() - ttsT0,
        fallbackText: question,
        error: err.message,
      };
    }
  }

  return {
    sessionId: session.id,
    round: nextRound,
    question: question || null,
    topic,
    sampleAnswer,
    endInterview,
    transcript, // the candidate's last answer (echoed back for the UI)
    tts: ttsResult,
  };
}

/** 报告生成的单次请求硬超时。DeepSeek 推理模型正常 15-35s，90s 已经很宽裕。 */
const REPORT_TIMEOUT_MS = 90_000;
/** 报告生成的最大尝试次数（截断 / 超时 / JSON 解析失败都会重试）。 */
const REPORT_MAX_ATTEMPTS = 3;

/**
 * 兜底报告：LLM 彻底不可用时，用本地数据拼一个「无打分」的报告，
 * 保证前端一定能进报告页看到完整对话记录，而不是卡在 loading。
 * 通过 `degraded: true` 标记，前端据此提示「AI 评分未生成，可重试」。
 */
function buildLocalFallbackReport(session, reason: string) {
  const answered = session.turns.filter((t) => (t.answer || '').trim());
  return {
    degraded: true,
    degraded_reason: reason,
    scores: { logic: 0, expression: 0, depth: 0, relevance: 0, adaptability: 0, overall: 0 },
    per_question: session.turns.map((t, i) => ({
      round: t.round || i + 1,
      question: t.question || '',
      answer: (t.answer || '').trim(),
      score: 0,
      comment: '（AI 评分未生成）',
      better_answer: '',
    })),
    summary:
      `本场面试共 ${session.turns.length} 轮，其中 ${answered.length} 轮有回答。` +
      `AI 评分本次未能生成（${reason}），以下为完整对话记录，你可以点击「重新生成报告」重试。`,
    improvements: [],
    verdict: '',
  };
}

/**
 * 报告生成所需的最小会话视图。内存 session 有 30 分钟 TTL（config.sessionTtlMs），
 * 一场面试超过这个时长后点「结束面试」会拿到 404，前端就永远卡在「正在
 * 生成报告」。所以这里在内存未命中时回退到 SQLite——turns 是实时写入的，
 * 足够重建报告。
 */
function resolveReportSubject(sessionId: string) {
  const mem = getSession(sessionId);
  if (mem) return { kind: 'memory' as const, session: mem };

  const row = getSessionRow(sessionId);
  if (!row) return null;
  const rows = listTurns(sessionId);
  return {
    kind: 'sqlite' as const,
    session: {
      id: row.id,
      direction: row.direction || '',
      candidateName: row.candidate_name || '',
      finished: row.status === 'finished' || row.ended_at != null,
      turns: rows.map((t) => ({ round: t.round, question: t.question, answer: t.answer || '' })),
      report: loadFullReport(sessionId),
    } as any,
  };
}

/**
 * Generate the structured report for a finished session. Idempotent — we
 * cache the report on the session.
 *
 * 之前这里只调一次 DeepSeek 且 maxTokens=4096。deepseek-v4-flash 是推理模型，
 * 4096 经常被 reasoning_tokens 全部吃掉，返回 finish_reason='length' + 空
 * content，parseJsonLoose 得到 null → 抛 502 → 前端只弹一个 toast 不跳页，
 * 于是「结束面试后一直不结束」。现在：maxTokens 提到 16384、加硬超时、
 * 失败重试、最后本地兜底，保证这个接口一定在有限时间内返回可用结果。
 */
export async function generateReport(sessionId, { force = false } = {}) {
  const subject = resolveReportSubject(sessionId);
  if (!subject) {
    const e = new Error('Interview session not found or expired.');
    e.statusCode = 404;
    throw e;
  }
  const session = subject.session;
  const inMemory = subject.kind === 'memory';
  // 缓存命中：降级报告不算「已生成」，force 或缓存是降级的都重新跑一次。
  if (session.report && !force && !(session.report as any).degraded) {
    return session.report;
  }
  if (!session.finished) {
    const e = new Error('Interview is not finished yet. Finish the interview first.');
    e.statusCode = 400;
    throw e;
  }
  if (!session.turns.length) {
    const e = new Error('This interview has no recorded turns, so no report can be generated.');
    e.statusCode = 400;
    throw e;
  }

  // Build a transcript that the report LLM can consume.
  const transcriptText = session.turns
    .map((t, i) => {
      const a = t.answer ? `\n候选人回答: ${t.answer}` : '（候选人未作答或本轮无回答）';
      return `【第 ${i + 1} 轮】\n面试官提问: ${t.question}${a}`;
    })
    .join('\n\n');

  const messages = [
    { role: 'system', content: REPORT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `请基于以下完整面试记录生成评估报告。\n` +
        `方向: ${session.direction}\n` +
        `候选人姓名: ${session.candidateName || '未提供'}\n` +
        `总轮数: ${session.turns.length}\n\n` +
        `=== 面试记录 ===\n${transcriptText}`,
    },
  ];

  let report: object | null = null;
  let lastError: any = null;
  for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS; attempt++) {
    try {
      const { content, finishReason } = await deepseekChat({
        messages,
        temperature: 0.4,
        jsonMode: true,
        // 16384：给推理留足空间。实测同一份 8 轮记录在 4096 下会被推理吃光。
        maxTokens: 16384,
        timeoutMs: REPORT_TIMEOUT_MS,
      });
      const parsed = parseJsonLoose(content);
      if (!parsed || typeof parsed !== 'object') {
        const e = new Error(
          `Failed to parse report JSON from DeepSeek (finish_reason=${finishReason}).`,
        );
        e.statusCode = 502;
        e.upstream = { body: String(content || '').slice(0, 2000) };
        throw e;
      }
      report = parsed;
      break;
    } catch (err: any) {
      lastError = err;
      console.warn(
        `[orchestrator] report attempt ${attempt}/${REPORT_MAX_ATTEMPTS} failed:`,
        err.message,
      );
      // 4xx（配置错误 / 鉴权失败）重试没意义，直接跳出走兜底。
      const status = Number(err.statusCode || 0);
      if (status >= 400 && status < 500) break;
    }
  }

  let degraded = false;
  if (!report) {
    degraded = true;
    const reason = lastError?.timeout
      ? '生成超时'
      : lastError?.truncated
        ? '模型输出被截断'
        : lastError?.message || '未知错误';
    console.warn('[orchestrator] falling back to a local report:', reason);
    report = buildLocalFallbackReport(session, reason);
  }

  session.report = report;
  if (inMemory) touchSession(session as any);
  // Mirror the high-level report fields to SQLite so the history page can
  // show scores without re-running the LLM. 降级报告不写 SQLite 摘要 —— 否则
  // 历史页会永久留下一条 0 分记录。
  if (!degraded) {
    try {
      const scores = (report && (report as any).scores) || {}
      const overall = Number(scores.overall || 0)
      const verdict = String((report as any).verdict || '')
      const summary = String((report as any).summary || '')
      if (overall > 0) {
        updateSessionReport(session.id, overall, verdict, summary)
      }
      // Persist the FULL report (per-question + improvements) so the history
      // page can show it long after the in-memory session is gone.
      saveFullReport(session.id, report as object)
    } catch (err) {
      console.warn('[orchestrator] failed to save report summary to SQLite:', err)
    }
  }
  return report;
}

/**
 * For the front-end "view transcript" and report download. Returns a
 * serializable snapshot.
 */
export function getSessionSnapshot(sessionId) {
  const session = getSession(sessionId);
  if (!session) return null;
  return {
    id: session.id,
    direction: session.direction,
    jdText: session.jdText,
    candidateName: session.candidateName,
    maxRounds: session.maxRounds,
    voice: session.voice,
    finished: session.finished,
    endedAt: session.endedAt,
    endReason: session.endReason,
    turns: session.turns.map((t) => ({ ...t })),
    report: session.report || null,
  };
}

/**
 * Force-mark a session as finished. Used by the front-end ⏹ button when the
 * candidate decides to end the interview without explicitly telling the AI.
 */
export function forceFinishSession(sessionId, reason = 'candidate_manual_end') {
  const session = getSession(sessionId);
  if (!session) {
    // 内存 session 已过期（TTL 30min）—— 直接在 SQLite 里标完成，不要回 404，
    // 否则前端的 endManually 虽然吃下错误，后面 loadReport 也会 404 → 卡死。
    const row = getSessionRow(sessionId);
    if (!row) return null;
    const endedAt = row.ended_at || Date.now();
    const endReason = row.end_reason || reason;
    if (row.status !== 'finished') {
      try {
        updateSessionFinished(sessionId, endedAt, endReason, listTurns(sessionId).length);
      } catch (err) {
        console.warn('[orchestrator] forceFinishSession (sqlite-only) failed:', err);
      }
    }
    return { id: sessionId, endedAt, endReason, finished: true } as any;
  }
  if (!session.finished) {
    session.finished = true;
    session.endedAt = Date.now();
    session.endReason = reason;
  }
  touchSession(session);
  // Mirror to SQLite
  try {
    updateSessionFinished(session.id, session.endedAt!, session.endReason!, session.turns.length)
  } catch (err) {
    console.warn('[orchestrator] forceFinishSession SQLite mirror failed:', err)
  }
  return session;
}

export function dropSession(sessionId) {
  return deleteSession(sessionId);
}
