/* =======================================================================
   ai-script.js — 슬라이드(페이지 이미지 + 글자)를 AI 가 읽고 발표 대본 작성
   - 제공사: Claude(Anthropic) · ChatGPT(OpenAI) · Gemini(Google), 모델·생각 깊이 선택.
   - 두 가지 호출 방식
     · 직접: 사용자의 API 키로 브라우저에서 각 사 API 를 바로 호출(키는 이 브라우저에만 저장).
       공식 SDK 를 필요할 때만 CDN(ESM)에서 불러온다.
     · 팀 서버: Vercel 에 배포하고 서버에 키를 넣어 두면 /api/generate 가 대신 호출.
       팀원은 키 없이 팀 암호만 입력. (GitHub Pages 에서는 이 방식이 자동으로 숨겨짐)
   - 제공사 호출 코드는 서버와 함께 쓰는 js/llm-core.mjs 에 있다.
   - 결과는 `=== 1 (40s) ===` 형식 텍스트로 흘려보내고(onText),
     실제 적용은 기존 ‘대본 적용’(Notes.applyBulk) 흐름을 그대로 쓴다.
   ======================================================================= */
(function (global) {
  const CORE_URL = new URL('js/llm-core.mjs', document.baseURI).href;
  const SDK_URLS = {
    anthropic: ['https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm', (m) => ({ Anthropic: m.default })],
    openai: ['https://cdn.jsdelivr.net/npm/openai@7.24.0/+esm', (m) => ({ OpenAI: m.default })],
    gemini: ['https://cdn.jsdelivr.net/npm/@google/genai@2.24.0/+esm', (m) => ({ GoogleGenAI: m.GoogleGenAI })]
  };
  // 슬라이드 이미지 크기 단계(긴 변 px, JPEG 품질) — 요청 한도를 넘으면 한 단계씩 줄인다
  const IMAGE_LEVELS = [[1280, 0.8], [1024, 0.72], [800, 0.65], [640, 0.6], [512, 0.55]];

  let corePromise = null;
  function core() {
    if (!corePromise) corePromise = import(CORE_URL).catch((e) => { corePromise = null; throw e; });
    return corePromise;
  }
  const sdkPromises = {};
  function loadSdk(provider) {
    if (!sdkPromises[provider]) {
      const [url, pick] = SDK_URLS[provider];
      sdkPromises[provider] = import(url).then(pick).catch((e) => { delete sdkPromises[provider]; throw e; });
    }
    return sdkPromises[provider];
  }

  /* ---------- 저장값(키·암호) ---------- */
  function store(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  // 예전 버전(Claude 전용)에서 저장한 키 옮기기
  if (!load('aiKey:anthropic') && load('anthropicKey')) { store('aiKey:anthropic', load('anthropicKey')); store('anthropicKey', ''); }
  function getKey(provider) { return load('aiKey:' + provider); }
  function saveKey(provider, key, remember) { store('aiKey:' + provider, remember ? key : ''); }
  function getPasscode() { return load('appPasscode'); }
  function savePasscode(code) { store('appPasscode', code); }

  /* ---------- 서버(Vercel) 확인 ---------- */
  let serverPromise = null;
  /** {enabled, providers:{anthropic:bool,…}, needsPasscode} 또는 null(정적 호스팅) */
  function serverConfig() {
    // 서버 함수가 없는 게 확실한 곳(GitHub Pages·로컬 파일)은 묻지 않음(콘솔 404 소음 방지)
    if (location.protocol === 'file:' || /\.github\.io$/.test(location.hostname)) return Promise.resolve(null);
    if (!serverPromise) {
      serverPromise = fetch('api/config', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j && j.server ? j : null))
        .catch(() => null);
    }
    return serverPromise;
  }
  /** 화면 준비: 모델 목록 + 서버 상태 */
  async function init() {
    const [C, server] = await Promise.all([core(), serverConfig()]);
    return { PROVIDERS: C.PROVIDERS, EFFORT_LABELS: C.EFFORT_LABELS, server };
  }

  /* ---------- 슬라이드 준비 ---------- */
  /** 페이지마다 글자 + JPEG 이미지. 전체 크기가 maxBytes 를 넘으면 이미지를 줄여 다시 */
  async function collectSlides(maxBytes, onStep, job) {
    const n = PdfRender.pageCount();
    const ar = await PdfRender.aspectRatio();
    const texts = [];
    for (let i = 0; i < n; i++) texts.push(await PdfRender.pageText(i, 1500));
    const textBytes = texts.reduce((a, t) => a + t.length * 3 + 200, 0);   // 한글 UTF-8 3바이트 + 머리말
    for (let level = 0; level < IMAGE_LEVELS.length; level++) {
      const [edge, quality] = IMAGE_LEVELS[level];
      const width = ar >= 1 ? edge : Math.round(edge * ar);
      const slides = [];
      let total = textBytes;
      for (let i = 0; i < n; i++) {
        if (job && job.cancelled) return null;
        if (onStep) onStep(i + 1, n, level);
        const url = await PdfRender.renderPageDataURL(i, width, { type: 'image/jpeg', quality });
        const data = url.slice(url.indexOf(',') + 1);
        total += data.length;
        if (total > maxBytes) break;
        slides.push({ text: texts[i], data });
      }
      if (slides.length === n) return slides;
    }
    throw Object.assign(new Error('슬라이드가 너무 많거나 커서 한 번에 보낼 수 없습니다. PDF 를 나눠서 시도하세요.'), { friendly: true });
  }

  /* ---------- 생성 ---------- */
  /**
   * o = { provider, model, effort, via:'direct'|'server', apiKey, passcode,
   *       targetSec, lang, extra, job, onStep(i,n,level), onStart(), onText(delta) }
   * job.abort() 로 중지. 반환: { status:'ok'|'max_tokens'|'refusal', model }
   */
  async function generate(o) {
    const C = await core();
    const p = C.PROVIDERS[o.provider];
    const maxBytes = o.via === 'server' ? C.SERVER_MAX_BYTES : p.maxBytes;
    const slides = await collectSlides(maxBytes, o.onStep, o.job);
    const ctrl = new AbortController();
    o.job.abort = () => ctrl.abort();
    o.job.signal = ctrl.signal;
    if (!slides || o.job.cancelled) { ctrl.abort(); throw new Error('cancelled'); }
    const prompt = Notes.scriptPrompt({ totalPages: slides.length, targetSec: o.targetSec, lang: o.lang, extra: o.extra, mode: 'api' });
    if (o.onStart) o.onStart();
    if (o.via === 'server') return viaServer(o, prompt, slides, ctrl.signal);
    const sdk = await loadSdk(o.provider);
    return C.generate(sdk, {
      provider: o.provider, apiKey: o.apiKey, model: o.model, effort: o.effort,
      system: C.SYSTEM_PROMPT, prompt, slides, onText: o.onText, signal: ctrl.signal
    });
  }

  /** 팀 서버(/api/generate) 경유 — 줄 단위 JSON 스트림을 읽는다 */
  async function viaServer(o, prompt, slides, signal) {
    const res = await fetch('api/generate', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-app-passcode': o.passcode || '' },
      body: JSON.stringify({ provider: o.provider, model: o.model, effort: o.effort, prompt, slides })
    });
    if (!res.ok) {
      let j = null;
      try { j = await res.json(); } catch (e) {}
      const msg = (j && j.message) || (res.status === 413 ? '보낼 슬라이드가 너무 큽니다.' : `서버 오류(${res.status})`);
      throw Object.assign(new Error(msg), { status: res.status, friendly: true });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'text') o.onText(ev.text);
        else if (ev.type === 'done') done = ev;
        else if (ev.type === 'error') throw Object.assign(new Error(ev.message), { status: ev.status, friendly: true });
      }
    }
    if (!done) throw Object.assign(new Error('서버 응답이 중간에 끊겼습니다. 다시 시도하세요.'), { friendly: true });
    return { status: done.status, model: done.model };
  }

  /** 오류 → 사용자용 한국어 안내 */
  async function explainError(err, job, via) {
    try {
      const C = await core();
      return C.explainError(err, { aborted: !!(job && (job.cancelled || (job.signal && job.signal.aborted))), server: via === 'server' });
    } catch (e) {
      return '모듈을 불러오지 못했습니다. 인터넷 연결을 확인하세요.';
    }
  }

  global.AIScript = { init, generate, explainError, getKey, saveKey, getPasscode, savePasscode };
})(window);
