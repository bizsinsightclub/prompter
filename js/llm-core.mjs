/* =======================================================================
   llm-core.mjs — AI 제공사(Claude · ChatGPT · Gemini) 공통 모듈
   - 브라우저(사용자 키로 직접 호출, js/ai-script.js)와
     Vercel 서버 함수(서버에 둔 키로 호출, api/generate.mjs)가 함께 쓴다.
   - 모델 목록 · 생각 깊이(effort) 선택지 · 요청 크기 한도 · 제공사별 호출 방식.
   - SDK 클래스는 바깥에서 넣어 준다(브라우저는 CDN, 서버는 npm 패키지).
   ======================================================================= */

export const SYSTEM_PROMPT = '당신은 프레젠테이션 발표 코치이자 대본 작가입니다. ' +
  '슬라이드를 꼼꼼히 보고, 발표자가 그대로 소리 내어 읽을 자연스러운 발표 대본을 씁니다. ' +
  '요청된 출력 형식(페이지 구분 기호)을 정확히 지키고, 형식 밖의 설명은 덧붙이지 않습니다.';

/** 생각 깊이(추론 강도) 표시 이름 — 높을수록 꼼꼼하지만 느리고 비싸다 */
export const EFFORT_LABELS = {
  none: '없음 (가장 빠름)', minimal: '최소', low: '낮음 (빠름)', medium: '보통',
  high: '높음', xhigh: '매우 높음', max: '최대 (가장 꼼꼼 · 느림)'
};

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 제공사 · 모델 목록 (2026-10 기준 각 사 공식 문서) */
export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)',
    keyName: 'Anthropic API 키', keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    envKey: 'ANTHROPIC_API_KEY',
    maxBytes: 24e6,          // 요청 한도 32MB 에 여유
    defaultModel: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — 기본 · 꼼꼼함', efforts: CLAUDE_EFFORTS, effort: 'medium', fallback: true },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 — 최고 성능 · 비쌈', efforts: CLAUDE_EFFORTS, effort: 'medium', fallback: true },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — 빠르고 저렴', efforts: CLAUDE_EFFORTS, effort: 'medium', fallback: true },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — 가장 저렴', efforts: CLAUDE_EFFORTS, effort: 'medium', fallback: false }
    ]
  },
  openai: {
    label: 'ChatGPT (OpenAI)',
    keyName: 'OpenAI API 키', keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    envKey: 'OPENAI_API_KEY',
    maxBytes: 100e6,
    defaultModel: 'gpt-6.1-sol',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol — 기본 · 균형', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effort: 'medium' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra — 최고 성능 · 비쌈', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effort: 'medium' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna — 가장 저렴 · 빠름', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], effort: 'medium' }
    ]
  },
  gemini: {
    label: 'Gemini (Google)',
    keyName: 'Gemini API 키', keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    envKey: 'GEMINI_API_KEY',
    maxBytes: 16e6,          // 인라인 이미지 포함 요청 한도 20MB 에 여유
    defaultModel: 'gemini-3.8-flash',
    models: [
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon — 최고 성능', efforts: ['low', 'medium', 'high'], effort: 'medium' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash — 기본 · 빠름', efforts: ['low', 'medium', 'high'], effort: 'medium' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite — 가장 저렴', efforts: ['minimal', 'low', 'medium', 'high'], effort: 'minimal' }
    ]
  }
};

/** Vercel 서버 함수의 요청 본문 한도(4.5MB)에 맞춘 슬라이드 묶음 크기 */
export const SERVER_MAX_BYTES = 3.8e6;

export function findModel(provider, model) {
  const p = PROVIDERS[provider];
  return p ? p.models.find((m) => m.id === model) || null : null;
}

function slideHeader(i, text) {
  return `[슬라이드 ${i + 1}]\n` + (text ? `추출 텍스트:\n${text}` : '(추출된 텍스트 없음 — 이미지로 판단)');
}

/**
 * 대본 생성(스트리밍). sdk = { Anthropic, OpenAI, GoogleGenAI } 중 필요한 것.
 * o = { provider, apiKey, model, effort, system, prompt, slides:[{text, data(JPEG base64)}], onText(delta), signal }
 * 반환: { status: 'ok' | 'max_tokens' | 'refusal', model }
 */
export async function generate(sdk, o) {
  const m = findModel(o.provider, o.model);
  if (!m) throw Object.assign(new Error('지원하지 않는 모델입니다: ' + o.model), { status: 400 });
  const effort = m.efforts.includes(o.effort) ? o.effort : m.effort;
  if (o.provider === 'anthropic') return runAnthropic(sdk.Anthropic, o, m, effort);
  if (o.provider === 'openai') return runOpenAI(sdk.OpenAI, o, m, effort);
  return runGemini(sdk.GoogleGenAI, o, m, effort);
}

/* ---------- Claude: Messages API (공식 SDK, 스트리밍) ---------- */
async function runAnthropic(Anthropic, o, m, effort) {
  const content = [];
  o.slides.forEach((s, i) => {
    content.push({ type: 'text', text: slideHeader(i, s.text) });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.data } });
  });
  content.push({ type: 'text', text: o.prompt });
  const client = new Anthropic({ apiKey: o.apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model: m.id,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    system: o.system,
    messages: [{ role: 'user', content }]
  };
  if (m.fallback) {
    // 안전 분류기가 드물게 요청을 거절하면 서버가 권장 모델로 자동 재시도
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const stream = client.beta.messages.stream(params, { signal: o.signal });
  stream.on('text', (d) => o.onText(d));
  const msg = await stream.finalMessage();
  return {
    status: msg.stop_reason === 'refusal' ? 'refusal' : msg.stop_reason === 'max_tokens' ? 'max_tokens' : 'ok',
    model: msg.model
  };
}

/* ---------- ChatGPT: Responses API (공식 SDK, 스트리밍) ---------- */
async function runOpenAI(OpenAI, o, m, effort) {
  const content = [];
  o.slides.forEach((s, i) => {
    content.push({ type: 'input_text', text: slideHeader(i, s.text) });
    content.push({ type: 'input_image', image_url: 'data:image/jpeg;base64,' + s.data, detail: 'auto' });
  });
  content.push({ type: 'input_text', text: o.prompt });
  const client = new OpenAI({ apiKey: o.apiKey, dangerouslyAllowBrowser: true });
  const stream = client.responses.stream({
    model: m.id,
    instructions: o.system,
    input: [{ role: 'user', content }],
    reasoning: { effort },
    max_output_tokens: 100000      // 추론 토큰도 여기에 포함되므로 넉넉히
  }, { signal: o.signal });
  stream.on('response.output_text.delta', (e) => o.onText(e.delta));
  const r = await stream.finalResponse();
  const refused = (r.output || []).some((it) => (it.content || []).some((c) => c.type === 'refusal'));
  let status = 'ok';
  if (refused || (r.incomplete_details && r.incomplete_details.reason === 'content_filter')) status = 'refusal';
  else if (r.status === 'incomplete') status = 'max_tokens';
  else if (r.status === 'failed') throw Object.assign(new Error((r.error && r.error.message) || '응답 생성 실패'), { status: 500 });
  return { status, model: r.model };
}

/* ---------- Gemini: generateContent (공식 SDK, 스트리밍) ---------- */
const GEMINI_BLOCKED = ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'BLOCKED'];
async function runGemini(GoogleGenAI, o, m, effort) {
  const parts = [];
  o.slides.forEach((s, i) => {
    parts.push({ text: slideHeader(i, s.text) });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: s.data } });
  });
  parts.push({ text: o.prompt });
  const ai = new GoogleGenAI({ apiKey: o.apiKey });
  const stream = await ai.models.generateContentStream({
    model: m.id,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: o.system,
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingLevel: effort.toUpperCase() },
      abortSignal: o.signal
    }
  });
  let finish = null, model = m.id;
  for await (const chunk of stream) {
    const t = chunk.text;
    if (t) o.onText(t);
    const c = chunk.candidates && chunk.candidates[0];
    if (c && c.finishReason) finish = c.finishReason;
    if (chunk.promptFeedback && chunk.promptFeedback.blockReason) finish = 'BLOCKED';
    if (chunk.modelVersion) model = chunk.modelVersion;
  }
  return { status: finish === 'MAX_TOKENS' ? 'max_tokens' : GEMINI_BLOCKED.includes(finish) ? 'refusal' : 'ok', model };
}

/**
 * 오류 → 사용자용 한국어 안내. 세 SDK 모두 HTTP 상태를 err.status 로 준다.
 * ctx = { aborted, server(서버 키 사용 중) }
 */
export function explainError(err, ctx) {
  ctx = ctx || {};
  if (ctx.aborted) return '생성을 중지했습니다.';
  if (err && err.friendly) return err.message;   // 이미 사용자용 안내 문구인 오류(서버 함수가 바꿔 보낸 것 등)
  const status = err && (err.status || err.code);
  const msg = String((err && err.message) || err || '');
  const who = ctx.server ? '서버에 설정된' : '';
  if (status === 401 || /api key not valid|api_key_invalid|invalid x-api-key|incorrect api key|invalid api key/i.test(msg)) {
    return `${who} API 키가 올바르지 않습니다. 키를 다시 확인하세요.`.trim();
  }
  if (status === 403) return '이 키로는 선택한 모델을 쓸 수 없습니다. 다른 모델을 고르거나 콘솔의 권한·결제 설정을 확인하세요.';
  if (status === 404) return '모델을 찾을 수 없습니다. 다른 모델을 골라 보세요.';
  if (status === 413) return '보낼 슬라이드가 너무 큽니다. 장수를 줄여 다시 시도하세요.';
  if (status === 429) return '요청 한도(또는 사용량 한도)를 넘었습니다. 잠시 후 다시 시도하거나 결제·한도 설정을 확인하세요.';
  if (status === 400) return '요청이 거부되었습니다: ' + msg.slice(0, 200) + ' (크레딧 잔액·PDF 크기를 확인하세요)';
  if (typeof status === 'number' && status >= 500) return `AI 서비스에 일시적인 문제가 있습니다(${status}). 잠시 후 다시 시도하세요.`;
  if (/connection|failed to fetch|fetch failed|network/i.test(msg)) return 'AI 서비스에 연결하지 못했습니다. 인터넷 연결을 확인하세요.';
  return '오류: ' + msg.slice(0, 300);
}
