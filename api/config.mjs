/* =======================================================================
   GET /api/config — Vercel 에 배포했을 때만 존재하는 서버 설정 안내
   - 어떤 제공사의 서버 키가 준비돼 있는지 알려 준다(키 값 자체는 절대 보내지 않음).
   - 서버 키는 APP_PASSCODE(팀 암호)가 설정돼 있을 때만 켠다 — 주소만 알면 누구나
     내 키로 AI 를 쓰는 일이 없도록.
   - GitHub Pages 같은 정적 호스팅에서는 이 주소가 404 → 화면은 '내 키로 직접 호출'만 보여 준다.
   ======================================================================= */
import { PROVIDERS } from '../js/llm-core.mjs';

export default {
  fetch() {
    const enabled = !!process.env.APP_PASSCODE;
    const providers = {};
    let anyKey = false;
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const has = !!process.env[p.envKey];
      anyKey = anyKey || has;
      providers[id] = enabled && has;
    }
    return Response.json(
      { server: true, enabled, providers, needsPasscode: anyKey && !enabled },
      { headers: { 'cache-control': 'no-store' } }
    );
  }
};
