/* =======================================================================
   ai-script.js — 슬라이드(페이지 이미지 + 글자)를 Claude 가 읽고 발표 대본 작성
   - 이 앱은 서버가 없는 정적 웹앱이므로, 사용자의 Anthropic API 키로
     브라우저에서 api.anthropic.com 을 직접 호출한다(키는 이 브라우저에만 저장).
   - 공식 SDK(@anthropic-ai/sdk)를 필요할 때만 CDN(ESM)에서 불러온다.
   - 결과는 `=== 1 (40s) ===` 형식 텍스트로 흘려보내고(onText),
     실제 적용은 기존 ‘대본 적용’(Notes.applyBulk) 흐름을 그대로 쓴다.
   ======================================================================= */
(function (global) {
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';
  const KEY_STORE = 'anthropicKey';
  const DEFAULT_MODEL = 'claude-opus-5-5';
  // 서버 측 거절 대비(fallbacks: "default")를 지원하는 모델 — Haiku 는 미지원
  const FALLBACK_OK = ['claude-opus-5-5', 'claude-sonnet-5-5'];

  const SYSTEM = '당신은 프레젠테이션 발표 코치이자 대본 작가입니다. ' +
    '슬라이드를 꼼꼼히 보고, 발표자가 그대로 소리 내어 읽을 자연스러운 발표 대본을 씁니다. ' +
    '요청된 출력 형식(페이지 구분 기호)을 정확히 지키고, 형식 밖의 설명은 덧붙이지 않습니다.';

  let _sdk = null;
  function loadSdk() {
    if (!_sdk) _sdk = import(SDK_URL).then((m) => m.default).catch((e) => { _sdk = null; throw e; });
    return _sdk;
  }

  function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function saveKey(key, remember) {
    try { if (remember && key) localStorage.setItem(KEY_STORE, key); else localStorage.removeItem(KEY_STORE); } catch (e) {}
  }

  /** 페이지마다 글자 + 이미지(JPEG, 긴 변 ≤ 1568px) 준비 */
  async function collectSlides(onStep) {
    const n = PdfRender.pageCount();
    const ar = await PdfRender.aspectRatio();
    const width = ar >= 1 ? 1280 : Math.round(1568 * ar);   // 가로형 1280px, 세로형은 높이 1568px
    const slides = [];
    for (let i = 0; i < n; i++) {
      if (onStep) onStep(i + 1, n);
      const text = await PdfRender.pageText(i, 1500);
      const url = await PdfRender.renderPageDataURL(i, width, { type: 'image/jpeg', quality: 0.8 });
      slides.push({ text, data: url.slice(url.indexOf(',') + 1) });
    }
    return slides;
  }

  /**
   * 대본 생성(스트리밍).
   * o = { apiKey, model, lang, extra, targetSec, job, onStep(i,n), onStart(), onText(delta) }
   * job.abort() 로 중지 가능. 반환: { stopReason, model }
   */
  async function generate(o) {
    const Anthropic = await loadSdk();
    const slides = await collectSlides(o.onStep);
    if (o.job && o.job.cancelled) throw new Anthropic.APIUserAbortError();

    const content = [];
    slides.forEach((s, i) => {
      content.push({ type: 'text', text: `[슬라이드 ${i + 1}]\n` + (s.text ? `추출 텍스트:\n${s.text}` : '(추출된 텍스트 없음 — 이미지로 판단)') });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.data } });
    });
    content.push({ type: 'text', text: Notes.scriptPrompt({ totalPages: slides.length, targetSec: o.targetSec, lang: o.lang, extra: o.extra, mode: 'api' }) });

    const model = o.model || DEFAULT_MODEL;
    const client = new Anthropic({ apiKey: o.apiKey, dangerouslyAllowBrowser: true });
    const params = {
      model,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: SYSTEM,
      messages: [{ role: 'user', content }]
    };
    if (FALLBACK_OK.includes(model)) {
      // 안전 분류기가 드물게 요청을 거절하면 서버가 권장 모델로 자동 재시도
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    const stream = client.beta.messages.stream(params);
    if (o.job) o.job.abort = () => stream.abort();
    if (o.onStart) o.onStart();
    stream.on('text', (delta) => { if (o.onText) o.onText(delta); });
    const msg = await stream.finalMessage();
    return { stopReason: msg.stop_reason, model: msg.model };
  }

  /** 오류 → 사용자용 한국어 안내 */
  async function explainError(err) {
    let A = null;
    try { A = await loadSdk(); } catch (e) {}
    if (!A) return '라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.';
    if (err instanceof A.APIUserAbortError) return '생성을 중지했습니다.';
    if (err instanceof A.AuthenticationError) return 'API 키가 올바르지 않습니다. 키를 다시 확인하세요.';
    if (err instanceof A.PermissionDeniedError) return '이 키로는 선택한 모델을 쓸 수 없습니다. 다른 모델을 고르거나 콘솔 권한을 확인하세요.';
    if (err instanceof A.NotFoundError) return '모델을 찾을 수 없습니다. 다른 모델을 골라 보세요.';
    if (err instanceof A.RateLimitError) return '요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.';
    if (err instanceof A.BadRequestError) return '요청이 거부되었습니다: ' + (err.message || '') + ' (크레딧 잔액·PDF 크기를 확인하세요)';
    if (err instanceof A.APIConnectionError) return 'Anthropic API에 연결하지 못했습니다. 인터넷 연결을 확인하세요.';
    if (err instanceof A.APIError) return `API 오류(${err.status || '?'}): ${err.message || ''}`;
    return '오류: ' + (err && err.message ? err.message : String(err));
  }

  global.AIScript = { generate, explainError, getKey, saveKey, DEFAULT_MODEL };
})(window);
