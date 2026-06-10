/* =======================================================================
   notes.js — 페이지별 대본(노트) 저장 + 일괄 입력 + LLM 프롬프트
   - 노트는 HTML 문자열로 저장(서식 툴바 지원). 기본값은 빈 문자열.
   - deckId 는 PDF 별로 분리(파일명 기반). setDeck() 으로 동적 전환.
   - JSON 내보내기/가져오기, 일괄 붙여넣기 파싱, LLM 프롬프트 생성.
   ======================================================================= */
(function (global) {
  const cfg = global.PROMPTER_CONFIG || {};
  const FS_KEY = 'promptFs';
  const DECK_KEY = 'currentDeck';

  let deckId = localStorage.getItem(DECK_KEY) || 'default';
  let PREFIX, TPREFIX, MPREFIX;
  function rebuild() { PREFIX = `note:${deckId}:`; TPREFIX = `time:${deckId}:`; MPREFIX = `media:${deckId}:`; }
  rebuild();

  function setDeck(id) {
    deckId = (id || 'default').replace(/[^a-zA-Z0-9가-힣_.-]/g, '_').slice(0, 60);
    rebuild();
    try { localStorage.setItem(DECK_KEY, deckId); } catch (e) {}
    return deckId;
  }

  function get(idx) {
    try { return localStorage.getItem(PREFIX + idx) || ''; } catch (e) { return ''; }
  }
  function set(idx, html) {
    try {
      if (html && html.trim().length) localStorage.setItem(PREFIX + idx, html);
      else localStorage.removeItem(PREFIX + idx);
    } catch (e) {}
  }
  function isEmpty(idx) {
    const v = get(idx);
    return !v || !v.replace(/<[^>]*>/g, '').trim().length;
  }

  /* ---------- 페이지별 권장시간 ---------- */
  function getTime(idx) {
    try { const v = localStorage.getItem(TPREFIX + idx); return v ? parseInt(v, 10) : null; } catch (e) { return null; }
  }
  function setTime(idx, sec) {
    try {
      sec = parseInt(sec, 10);
      if (sec && sec > 0) localStorage.setItem(TPREFIX + idx, String(sec));
      else localStorage.removeItem(TPREFIX + idx);
    } catch (e) {}
  }

  /* ---------- 페이지별 영상 메타 ---------- */
  function mediaKey(idx) { return `${deckId}:${idx}`; }
  function getMedia(idx) {
    try { const v = localStorage.getItem(MPREFIX + idx); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function setMedia(idx, obj) {
    try {
      if (obj) localStorage.setItem(MPREFIX + idx, JSON.stringify(obj));
      else localStorage.removeItem(MPREFIX + idx);
    } catch (e) {}
  }

  function dump() {
    const notes = {}, times = {}, media = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) notes[k.slice(PREFIX.length)] = localStorage.getItem(k);
        else if (k && k.startsWith(TPREFIX)) times[k.slice(TPREFIX.length)] = localStorage.getItem(k);
        else if (k && k.startsWith(MPREFIX)) media[k.slice(MPREFIX.length)] = localStorage.getItem(k);
      }
    } catch (e) {}
    return { deckId, exportedAt: new Date().toISOString(), notes, times, media };
  }
  function exportJSON() {
    const blob = new Blob([JSON.stringify(dump(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `prompter-notes-${deckId}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importJSON(fileOrText) {
    const text = (typeof fileOrText === 'string') ? fileOrText : await fileOrText.text();
    const parsed = JSON.parse(text);
    const notes = parsed.notes || parsed;
    let count = 0;
    Object.keys(notes).forEach((idx) => { set(idx, notes[idx]); count++; });
    if (parsed.times) Object.keys(parsed.times).forEach((idx) => setTime(idx, parsed.times[idx]));
    if (parsed.media) Object.keys(parsed.media).forEach((idx) => {
      try { setMedia(idx, JSON.parse(parsed.media[idx])); } catch (e) {}
    });
    return count;
  }

  /* ---------- 일괄 붙여넣기 파싱 ----------
     구분 기호: `=== 1 ===`, `--- 페이지 1 ---`, `# 3`, `[3]`, `<페이지 3>` 등
     숫자 = 1-based 페이지. 해당 페이지부터 다음 구분자 전까지가 본문. */
  // 페이지 구분자(+선택 시간): `=== 1 ===`, `--- 페이지 2 ---`, `# 3`, `=== 1 (60s) ===`, `[4] [90초]`
  const SEP = /^[\s>*#\[\]=\-]*(?:페이지|page|p|슬라이드|slide)?\s*[#:]?\s*(\d+)\s*(?:[\(\[]\s*(\d+)\s*(?:s|sec|초)?\s*[\)\]])?\s*[=\-.\]]*\s*$/i;

  function parseBulk(text) {
    const lines = (text || '').replace(/\r\n?/g, '\n').split('\n');
    const pages = {}, secs = {};
    let cur = null;
    for (const line of lines) {
      const m = line.match(SEP);
      if (m && /\d/.test(line)) {
        cur = parseInt(m[1], 10);
        pages[cur] = [];
        if (m[2]) secs[cur] = parseInt(m[2], 10);
      } else if (cur != null) {
        pages[cur].push(line);
      }
    }
    const notes = {}, times = {};
    Object.keys(pages).forEach((p) => {
      const idx = parseInt(p, 10) - 1;
      if (idx < 0) return;
      notes[idx] = plainToHTML(pages[p].join('\n').trim());
    });
    Object.keys(secs).forEach((p) => { const idx = parseInt(p, 10) - 1; if (idx >= 0) times[idx] = secs[p]; });
    return { notes, times };
  }
  /** 파싱 결과를 실제 노트/시간에 적용. 반환=적용된 대본 개수 */
  function applyBulk(text) {
    const { notes, times } = parseBulk(text);
    let n = 0;
    Object.keys(notes).forEach((idx) => { if (notes[idx]) { set(idx, notes[idx]); n++; } });
    Object.keys(times).forEach((idx) => setTime(idx, times[idx]));
    return n;
  }

  /** 평문 → HTML (이스케이프 + **굵게** + 줄바꿈) */
  function plainToHTML(text) {
    if (!text) return '';
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  }

  /* ---------- LLM 프롬프트 생성 ---------- */
  function llmPrompt(totalPages, targetSec) {
    const target = targetSec || cfg.targetSec || 18 * 60;
    const min = Math.floor(target / 60);
    const per = totalPages ? Math.round(target / totalPages) : 40;
    return [
      `당신은 발표 대본 작성 도우미입니다. 아래 조건에 맞춰 ${totalPages || 'N'}장짜리 슬라이드 발표 대본을 작성해 주세요.`,
      ``,
      `[발표 정보]`,
      `- 총 슬라이드: ${totalPages || 'N'}장`,
      `- 총 발표 시간: 약 ${min}분 (페이지당 평균 ${per}초)`,
      `- 말투: 실제 발표하듯 자연스러운 구어체, 한 문장이 너무 길지 않게.`,
      ``,
      `[출력 형식 — 반드시 지킬 것]`,
      `- 각 페이지를 아래 구분 기호로 시작합니다(다른 머리말 금지):`,
      `=== 1 ===`,
      `(1페이지 대본)`,
      `=== 2 ===`,
      `(2페이지 대본)`,
      `...`,
      `=== ${totalPages || 'N'} ===`,
      `(마지막 페이지 대본)`,
      ``,
      `- 강조할 핵심 단어는 **별표 두 개**로 감쌉니다.`,
      `- (선택) 페이지 권장 시간을 넣으려면 구분 기호에 초를 적습니다: \`=== 3 (60s) ===\``,
      `- 구분 기호 줄에는 페이지 번호(+선택 시간)만, 본문은 그 아래에.`,
      `- 슬라이드별 핵심 메시지 하나가 분명히 드러나게.`,
      ``,
      `먼저 각 슬라이드 이미지를 보고, 위 형식 그대로 1번부터 ${totalPages || 'N'}번까지 대본을 출력하세요.`
    ].join('\n');
  }

  function getFontSize() {
    const v = parseInt(localStorage.getItem(FS_KEY) || '42', 10);
    return isNaN(v) ? 42 : v;
  }
  function setFontSize(px) { try { localStorage.setItem(FS_KEY, String(px)); } catch (e) {} }

  global.Notes = {
    get, set, isEmpty, setDeck, getDeck: () => deckId,
    getTime, setTime, getMedia, setMedia, mediaKey,
    dump, exportJSON, importJSON,
    parseBulk, applyBulk, plainToHTML, llmPrompt,
    getFontSize, setFontSize
  };
})(window);
