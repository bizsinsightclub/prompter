/* =======================================================================
   POST /api/generate — 서버에 둔 API 키로 대본 생성(Vercel 서버 함수)
   - 팀원은 키 없이 팀 암호(x-app-passcode)만으로 사용. 키는 서버 환경 변수에만 있다.
   - 요청: { provider, model, effort, prompt, slides:[{text, data}] }
   - 응답: 줄 단위 JSON(NDJSON) 스트림
       {"type":"text","text":"…"}  …  {"type":"done","status":"ok|max_tokens|refusal","model":"…"}
       오류 시 {"type":"error","status":…,"message":"…"}
   - 제공사 호출은 브라우저와 같은 js/llm-core.mjs 를 쓴다.
   ======================================================================= */
import { timingSafeEqual } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { PROVIDERS, SYSTEM_PROMPT, findModel, generate, explainError } from '../js/llm-core.mjs';

const SDK = { Anthropic, OpenAI, GoogleGenAI };
const MAX_SLIDES = 300;

function reply(status, message) {
  return Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } });
}

function passcodeOk(given) {
  const want = Buffer.from(process.env.APP_PASSCODE || '');
  const got = Buffer.from(String(given || ''));
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return reply(405, 'POST 요청만 받습니다.');
    if (!process.env.APP_PASSCODE) return reply(503, '서버에 팀 암호(APP_PASSCODE)가 설정되지 않아 서버 키를 쓸 수 없습니다.');
    if (!passcodeOk(request.headers.get('x-app-passcode'))) return reply(401, '팀 암호가 올바르지 않습니다.');

    let body;
    try { body = await request.json(); } catch (e) { return reply(400, '요청 형식이 올바르지 않습니다.'); }
    const { provider, model, effort, prompt, slides } = body || {};
    const p = PROVIDERS[provider];
    if (!p || !findModel(provider, model)) return reply(400, '지원하지 않는 AI 제공사 또는 모델입니다.');
    const apiKey = process.env[p.envKey];
    if (!apiKey) return reply(503, `서버에 ${p.label} 키(${p.envKey})가 설정되지 않았습니다.`);
    const slidesOk = Array.isArray(slides) && slides.length > 0 && slides.length <= MAX_SLIDES &&
      slides.every((s) => s && typeof s.data === 'string' && typeof (s.text || '') === 'string');
    if (typeof prompt !== 'string' || !slidesOk) return reply(400, '요청 내용이 올바르지 않습니다.');

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (o) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch (e) {} };
        try {
          const r = await generate(SDK, {
            provider, apiKey, model, effort, system: SYSTEM_PROMPT, prompt,
            slides: slides.map((s) => ({ text: s.text || '', data: s.data })),
            onText: (t) => send({ type: 'text', text: t }),
            signal: request.signal
          });
          send({ type: 'done', status: r.status, model: r.model });
        } catch (err) {
          send({ type: 'error', status: (err && err.status) || 500, message: explainError(err, { aborted: request.signal && request.signal.aborted, server: true }) });
        }
        try { controller.close(); } catch (e) {}
      }
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
  }
};
