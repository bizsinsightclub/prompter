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

  /** 대본 HTML → 평문(태그 제거) */
  function plainText(idx) {
    const d = document.createElement('div');
    d.innerHTML = get(idx).replace(/<br\s*\/?>/gi, '\n');
    return (d.textContent || '').trim();
  }

  /* ---------- 대본 작성 프롬프트 ----------
     AI 자동 생성(Claude API)과 ‘프롬프트 복사’(다른 AI 채팅) 가 같은 지침을 쓴다.
     o = { totalPages, targetSec, lang:'ko'|'en', extra, mode:'api'|'manual', slideTexts:[...] } */
  function scriptPrompt(o) {
    o = o || {};
    const N = o.totalPages || 'N';
    const target = o.targetSec || cfg.targetSec || 18 * 60;
    const min = Math.round(target / 6) / 10;
    const per = o.totalPages ? Math.round(target / o.totalPages) : 40;
    const en = o.lang === 'en';
    const lines = [
      o.mode === 'api'
        ? `위에 첨부한 ${N}장의 슬라이드(페이지 이미지 + 추출 텍스트)를 보고, 발표자가 그대로 소리 내어 읽을 발표 대본을 작성해 주세요.`
        : `당신은 발표 대본 작성 도우미입니다. 첨부한 ${N}장짜리 슬라이드를 페이지별로 보고, 발표자가 그대로 소리 내어 읽을 발표 대본을 작성해 주세요.`,
      '',
      '[발표 정보]',
      `- 총 슬라이드: ${N}장`,
      `- 총 발표 시간: 약 ${min}분 = ${target}초 (페이지당 평균 ${per}초)`,
      en ? '- 대본 언어: 영어(English). 슬라이드가 한국어여도 영어로 발표합니다.'
         : '- 대본 언어: 한국어. 슬라이드의 영어 용어·제품명은 원어 그대로 둡니다.',
      o.extra ? `- 추가 요청: ${o.extra}` : null,
      '',
      '[대본 작성 원칙]',
      '- 슬라이드 글자를 그대로 읽지 말고, 청중에게 설명하듯 풀어서 말합니다.',
      '- 표·그래프·이미지는 "무엇을 보여주는지 → 그래서 무슨 의미인지" 순서로 해설합니다.',
      '- 페이지마다 핵심 메시지 하나가 분명히 드러나게 하고, 끝에는 다음 페이지로 넘어가는 연결 문장을 넣습니다.',
      '- 숫자·고유명사는 슬라이드 표기를 정확히 따르고, 슬라이드에 없는 사실은 지어내지 않습니다.',
      '- 표지는 인사와 주제 소개, 마지막 페이지는 요약과 마무리 인사로 합니다. 목차·간지는 짧게.',
      en ? '- Short spoken sentences, one idea per sentence.'
         : '- 문장은 짧게, 한 문장에 한 가지 내용만. 소리 내어 읽기 편한 존댓말 구어체(~입니다, ~합니다).',
      '- 무대 지시([클릭], (잠시 멈춤) 등)는 넣지 않습니다. 소리 내어 읽을 문장만 씁니다.',
      '',
      '[시간 배분]',
      `- 페이지의 중요도와 정보량에 따라 시간을 나누고, 모든 페이지 합계가 ${target}초가 되게 합니다.`,
      `- 대본 분량은 배정 시간에 맞춥니다: ${en ? '1분에 약 130~150단어' : '1초에 약 4~5음절(1분에 약 250~300자)'}.`,
      '',
      '[출력 형식 — 반드시 지킬 것]',
      '- 각 페이지를 아래 구분 기호로 시작합니다. 괄호 안은 그 페이지의 배정 시간(초)입니다.',
      '=== 1 (40s) ===', '(1페이지 대본)', '=== 2 (55s) ===', '(2페이지 대본)', '...', `=== ${N} (30s) ===`, '(마지막 페이지 대본)',
      '',
      '- 구분 기호 줄에는 페이지 번호와 시간만 씁니다. 머리말·맺음말·해설은 쓰지 않습니다.',
      '- 강조할 핵심 단어는 **별표 두 개**로 감쌉니다.',
      '',
      `1번부터 ${N}번까지 빠짐없이 위 형식 그대로 출력하세요.`
    ];
    if (o.mode !== 'api' && o.slideTexts && o.slideTexts.length) {
      lines.push('', '[참고 — 슬라이드별 추출 텍스트 (그림·차트 내용은 첨부한 슬라이드에서 확인)]');
      o.slideTexts.forEach((t, i) => lines.push(`--- ${i + 1} ---`, t || '(텍스트 없음)'));
    }
    return lines.filter((l) => l !== null).join('\n');
  }
  function llmPrompt(totalPages, targetSec) { return scriptPrompt({ totalPages, targetSec }); }

  function getFontSize() {
    const v = parseInt(localStorage.getItem(FS_KEY) || '42', 10);
    return isNaN(v) ? 42 : v;
  }
  function setFontSize(px) { try { localStorage.setItem(FS_KEY, String(px)); } catch (e) {} }

  global.Notes = {
    get, set, isEmpty, setDeck, getDeck: () => deckId,
    getTime, setTime, getMedia, setMedia, mediaKey,
    dump, exportJSON, importJSON,
    parseBulk, applyBulk, plainToHTML, plainText, llmPrompt, scriptPrompt,
    getFontSize, setFontSize
  };
})(window);
