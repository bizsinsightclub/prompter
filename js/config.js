/* =======================================================================
   PROMPTER APP — 전역 설정 (단일 진실 공급원)
   기본 버전은 비어 있다. 발표 콘텐츠는 실행 시 PDF로 직접 불러온다.
   ======================================================================= */
window.PROMPTER_CONFIG = {
  // 앱 제목 (가림막/시작화면 표시). 발표별로 자유롭게 바꿔도 된다.
  appTitle: 'PDF 텔레프롬프터',
  team: '',
  eyebrow: 'STANDBY',

  // 발표 목표 시간(초). 카운트다운·LLM 프롬프트 기준.
  targetSec: 18 * 60,

  // PeerJS 세션 id 접두어. 세션 id = `${peerPrefix}-${3자리코드}`
  peerPrefix: 'prompter',

  // 폰 QR용 절대주소 베이스(HTTPS 호스팅 시). 비우면 현재 location 기준.
  hostedBase: '',

  // 연단(deck)으로 전송할 슬라이드 이미지 폭(px)과 포맷.
  // 2560 / JPEG 0.92 ≈ 300~600KB. 프로젝터(1080p~1440p)에서 또렷하게 보이는 화질.
  // 더 또렷하게: deckImageType:'image/png' (용량 1~2MB, 같은 PC면 부담 없음).
  // 더 가볍게: deckImageWidth 1920 / quality 0.85.
  deckImageWidth: 2560,
  deckImageType: 'image/jpeg',
  deckImageQuality: 0.92,

  // 영상 오버레이 설정
  youtubeParams: 'autoplay=1&rel=0&modestbranding=1'
};
