/* =======================================================================
   voice.js — 음성 인식으로 대본 위치 추적 (가라오케 하이라이트)
   - 브라우저 내장 음성 인식(Chrome·Edge·Safari 의 Web Speech API)을 쓴다.
   - 대본을 단어 단위 <span class="w"> 로 감싸고, 방금 들린 말의 꼬리를
     대본 전체와 '근사 문자열 매칭'해 어디까지 읽었는지 찾는다.
       · 앞으로 읽기            → 하이라이트 전진
       · 틀려서 앞부분 다시 읽기 → 다시 읽은 위치로 되돌아감
       · 몇 문장 건너뛰고 읽기   → 건너뛴 위치로 점프
   - 한/영 자동 전환: 지금 읽을 차례인 대본 구간의 언어를 보고 인식 언어
     (ko-KR / en-US)를 바꾼다. 들리는 말이 계속 안 맞으면 반대 언어도 시도.
   ======================================================================= */
(function (global) {
  const SR = global.SpeechRecognition || global.webkitSpeechRecognition || null;
  const MODE_KEY = 'voiceLangMode';

  /* ---------- 비교 단위(글자) 정규화 ----------
     한글 음절·영문자·숫자만 남긴다(공백·문장부호 무시).
     가중치는 말하는 데 걸리는 시간에 대략 비례: 한글 음절 1 · 숫자 0.6 · 영문자 0.4 */
  const W_KO = 1, W_DIGIT = 0.6, W_EN = 0.4;
  function isHangul(c) { return c >= 0xAC00 && c <= 0xD7A3; }
  function toUnits(text) {
    const out = [];
    for (const ch of String(text || '').normalize('NFC').toLowerCase()) {
      const c = ch.charCodeAt(0);
      if (isHangul(c) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) out.push(ch);
      else if (c >= 0xC0 && c <= 0x24F) {           // é → e 등 악센트 제거
        const b = ch.normalize('NFD')[0];
        if (b >= 'a' && b <= 'z') out.push(b);
      }
    }
    return out;
  }
  function unitWeight(ch) { const c = ch.charCodeAt(0); return isHangul(c) ? W_KO : (c <= 57 ? W_DIGIT : W_EN); }
  function sumWeight(units) { let w = 0; for (const u of units) w += unitWeight(u); return w; }
  function weightOfText(text) { return sumWeight(toUnits(text)); }
  function tailByWeight(units, target) {
    let w = 0, i = units.length;
    while (i > 0 && w < target) w += unitWeight(units[--i]);
    return { q: units.slice(i), w };
  }

  /* ---------- 근사 매칭 ----------
     대체 비용: 같은 글자 0, 한글끼리는 초성·중성·종성이 다른 만큼만 부분 비용
     (예: '의'↔'에' 는 중성만 달라 0.4) — 음성 인식의 비슷한 소리 오류를 너그럽게 본다. */
  function subCost(a, b) {
    if (a === b) return 0;
    const x = a.charCodeAt(0) - 0xAC00, y = b.charCodeAt(0) - 0xAC00;
    if (x >= 0 && x < 11172 && y >= 0 && y < 11172) {
      let c = 0;
      if (((x / 588) | 0) !== ((y / 588) | 0)) c += 0.4;
      if ((((x % 588) / 28) | 0) !== (((y % 588) / 28) | 0)) c += 0.4;
      if (x % 28 !== y % 28) c += 0.25;
      return c > 1 ? 1 : c;
    }
    return 1;
  }
  const COST_EXTRA = 1;    // 대본에 없는 말(인식 오류·애드리브)
  const COST_SKIP = 0.8;   // 대본 글자를 빠뜨림(조사 생략 등)

  /** Sellers 알고리즘: 대본 S 의 각 끝 위치 j 에서 질의 Q 가 끝나는 최소 편집 비용 D[j] */
  function matchCosts(S, Q) {
    const n = S.length, m = Q.length;
    let prev = new Float32Array(n + 1), cur = new Float32Array(n + 1);
    for (let i = 1; i <= m; i++) {
      const q = Q[i - 1];
      cur[0] = i * COST_EXTRA;
      for (let j = 1; j <= n; j++) {
        let v = prev[j - 1] + subCost(q, S[j - 1]);
        const a = prev[j] + COST_EXTRA; if (a < v) v = a;
        const b = cur[j - 1] + COST_SKIP; if (b < v) v = b;
        cur[j] = v;
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev;
  }

  /* ---------- 대본 DOM → 단어 span ---------- */
  const BLOCK = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|TR|TABLE|SECTION)$/;
  const SENT_END = /[.!?。…][\"'”’)\]]*$/;
  /** 텍스트 노드를 단어 span 으로 감싼다(굵게·색 등 서식 태그는 그대로 유지). */
  function wrapWords(root) {
    const items = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) { if (node.nodeValue.trim()) items.push(node); }
      else if (node.tagName === 'BR' || BLOCK.test(node.tagName)) items.push(null);   // 줄바꿈 = 문장 경계
    }
    const words = [];
    for (const it of items) {
      if (it === null) { if (words.length) words[words.length - 1].sentEnd = true; continue; }
      const frag = document.createDocumentFragment();
      for (const p of it.nodeValue.split(/(\s+)/)) {
        if (!p) continue;
        if (!p.trim()) { frag.appendChild(document.createTextNode(p)); continue; }
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = p;
        span.dataset.wi = String(words.length);
        frag.appendChild(span);
        words.push({ el: span, text: p, sentEnd: SENT_END.test(p) });
      }
      it.parentNode.replaceChild(frag, it);
    }
    return words;
  }

  /* ======================================================================
     추적기
     ====================================================================== */
  const LOCAL_W = 20;      // 현재 위치에서 이만큼(≈한글 20음절) 앞까지는 '정상 진행'
  const LOCAL_MAX_W = 60;  // 인식 결과가 몰려 올 때 넓혀 주는 '정상 진행' 범위의 상한
  const SMALL_BACK = 2.5;  // 이보다 작은 후퇴는 인식 흔들림으로 보고 무시

  function createTracker(opts) {
    opts = opts || {};
    const area = opts.scrollEl || null;

    let words = [], S = [], wordOf = [], cum = [0], total = 0;
    let cursor = 0, curWord = -1, bilingual = false;
    let active = false, paused = false, rec = null, restartTimer = null, restarts = [];
    let mode = 'auto';
    try { mode = localStorage.getItem(MODE_KEY) || 'auto'; } catch (e) {}
    let lang = mode === 'en-US' ? 'en-US' : 'ko-KR';
    let base = { ri: 0, ui: 0 };   // 이 대본에 반영할 인식 결과의 시작점(결과 번호, 그 안의 글자 수)
    let snap = null;               // 마지막 인식 결과 요약 {len, lastFinal, lastUnits}
    let heardW = 0, matchedAtW = 0, matchedAtLen = 0, lastSwitchTs = 0;
    let pending = null;            // 확인 대기 중인 점프 {j: 위치, w: 그때까지 들린 양, n: 확인 횟수}
    let rateW = 0, rateT = 0, lastMoveTs = 0;

    function status(s, detail) { if (opts.onStatus) opts.onStatus(s, detail); }
    function emit(how) { if (opts.onProgress) opts.onProgress(progress(), how); }

    /* ---------- 대본 연결 ---------- */
    function attach(root, keepCursor) {
      words = wrapWords(root);
      S = []; wordOf = []; cum = [0];
      words.forEach((w, k) => {
        w.s = S.length;
        let ko = 0, en = 0;
        for (const ch of toUnits(w.text)) {
          S.push(ch); wordOf.push(k); cum.push(cum[cum.length - 1] + unitWeight(ch));
          if (isHangul(ch.charCodeAt(0))) ko++; else if (ch >= 'a') en++;
        }
        w.e = S.length;
        w.lang = ko ? 'ko' : (en >= 2 ? 'en' : '');
      });
      total = cum[cum.length - 1];
      bilingual = words.some((w) => w.lang === 'en') && words.some((w) => w.lang === 'ko');
      cursor = keepCursor ? Math.min(keepCursor, S.length) : 0;
      curWord = -1;
      paused = false;
      rebase();
      paint(true);
      decideLang();
      emit('attach');
    }
    /** 편집 중에는 인식 결과를 반영하지 않는다(대본 DOM 이 바뀌므로) */
    function pause() { paused = true; }

    /** 지금까지 들린 말은 이 대본과 무관 — 이후에 들리는 말만 반영 */
    function rebase() {
      if (!snap || !snap.len) base = { ri: 0, ui: 0 };
      else if (snap.lastFinal) base = { ri: snap.len, ui: 0 };
      else base = { ri: snap.len - 1, ui: snap.lastUnits };
      heardW = 0; matchedAtW = 0; matchedAtLen = 0; pending = null;
    }

    /* ---------- 하이라이트 ---------- */
    function wordAtCursor(c) { return c >= S.length ? words.length : wordOf[c]; }
    function paint(force) {
      const nw = wordAtCursor(cursor);
      if (!force && nw === curWord) return;
      if (force || curWord < 0) {
        words.forEach((w, k) => { w.el.classList.toggle('read', k < nw); w.el.classList.remove('cur'); });
      } else {
        const a = Math.min(curWord, nw), b = Math.max(curWord, nw);
        for (let k = a; k < b && k < words.length; k++) words[k].el.classList.toggle('read', k < nw);
        if (curWord < words.length) words[curWord].el.classList.remove('cur');
      }
      if (nw < words.length) words[nw].el.classList.add('cur');
      curWord = nw;
      if (!force) scrollToCur();
    }
    function scrollToCur() {
      if (!area || !words.length) return;
      const el = words[Math.min(curWord, words.length - 1)].el;
      const ar = area.getBoundingClientRect(), r = el.getBoundingClientRect();
      const y = r.top - ar.top;
      if (y < ar.height * 0.18 || y > ar.height * 0.6) {
        area.scrollTo({ top: Math.max(0, area.scrollTop + y - ar.height * 0.3), behavior: 'smooth' });
      }
    }

    function moveTo(c, how) {
      c = Math.max(0, Math.min(S.length, c));
      if (c === cursor) return;
      const now = performance.now();
      const dw = cum[c] - cum[cursor];
      // 말하기 속도(비교 단위/초): 연속으로 정상 진행한 구간만 반영
      if (how === 'voice' && dw > 0 && dw <= LOCAL_W && lastMoveTs && now - lastMoveTs < 4000) {
        rateW += dw; rateT += (now - lastMoveTs) / 1000;
        if (rateT > 40) { rateW *= 0.75; rateT *= 0.75; }
      }
      lastMoveTs = how === 'voice' ? now : 0;
      cursor = c;
      paint();
      decideLang();
      emit(how);
    }

    /* ---------- 수동 이동 ---------- */
    function setCursorWord(k) {
      if (!words.length) return;
      k = Math.max(0, Math.min(words.length, k));
      while (k < words.length && words[k].s === words[k].e) k++;
      rebase();   // 이미 들린 말이 커서를 다시 끌고 가지 않게
      moveTo(k < words.length ? words[k].s : S.length, 'manual');
    }
    /** 문장 단위 이동: dir<0 → 이 문장 처음(이미 처음이면 앞 문장), dir>0 → 다음 문장 */
    function jumpSentence(dir) {
      if (!words.length) return;
      const starts = [0];
      words.forEach((w, k) => { if (w.sentEnd && k + 1 < words.length) starts.push(k + 1); });
      const cw = Math.max(0, Math.min(curWord, words.length));
      let target;
      if (dir < 0) { const p = starts.filter((s) => s < cw); target = p.length ? p[p.length - 1] : 0; }
      else { const n = starts.find((s) => s > cw); target = n == null ? words.length : n; }
      setCursorWord(target);
    }

    /* ---------- 언어 결정 ---------- */
    function decideLang() {
      if (mode !== 'auto') { switchLang(mode, 'manual'); return; }
      // 지금 읽을 차례인 단어 3개(언어가 있는 단어만)로 판단
      const next = [];
      for (let k = Math.max(0, curWord); k < words.length && next.length < 3; k++) {
        if (words[k].lang) next.push(words[k].lang);
      }
      if (!next.length) return;
      const en = next.filter((l) => l === 'en').length;
      // 영어 인식은 한국어를 전혀 못 알아듣고, 한국어 인식은 섞인 영어 단어 정도는 알아듣는다.
      // → 다음 단어들이 모두 영어일 때만 영어로 전환, 영어 중에는 영어가 과반이면 유지
      const want = (en === next.length || (lang === 'en-US' && en * 2 > next.length)) ? 'en-US' : 'ko-KR';
      if (want !== lang) switchLang(want, 'script');
    }
    function switchLang(l, why) {
      if (l === lang) return;
      lang = l; lastSwitchTs = performance.now();
      if (opts.onLang) opts.onLang(lang, mode, why);
      if (rec) { try { rec.stop(); } catch (e) {} }   // onend 에서 새 언어로 다시 시작
    }
    function setMode(m) {
      mode = (m === 'ko-KR' || m === 'en-US') ? m : 'auto';
      try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
      if (opts.onLang) opts.onLang(lang, mode, 'mode');
      decideLang();
    }
    /** 대본 위치와 무관하게 들리는 말이 계속 안 맞으면(자동 모드·한영 혼합 대본) 반대 언어 시도 */
    function checkMismatch() {
      if (mode !== 'auto' || !bilingual) return;
      if (heardW - matchedAtW < 9) return;
      if (performance.now() - lastSwitchTs < 5000) return;
      matchedAtW = heardW;   // 다음 판단까지 다시 9 만큼 들어 본다
      switchLang(lang === 'ko-KR' ? 'en-US' : 'ko-KR', 'fallback');
    }

    /* ---------- 인식 결과 처리 ---------- */
    function onResult(ev) {
      const res = ev.results;
      const li = res.length - 1;
      // 결과 목록이 줄었다면(일부 브라우저는 세션 중에도 목록을 새로 시작) 전부 새로 들린 말
      if (snap && res.length < snap.len) { base = { ri: 0, ui: 0 }; matchedAtW = 0; matchedAtLen = 0; }
      snap = { len: res.length, lastFinal: li >= 0 && res[li].isFinal, lastUnits: li >= 0 ? toUnits(res[li][0].transcript).length : 0 };
      if (paused || !S.length) return;

      const all = [];
      let seg = [], raw = '';
      for (let i = base.ri; i < res.length; i++) {
        const t = res[i][0].transcript;
        let u = toUnits(t);
        if (i === base.ri && base.ui) u = u.slice(base.ui);
        for (const x of u) all.push(x);
        if (i === li) seg = u;
        raw += ' ' + t;
      }
      if (opts.onHeard) opts.onHeard(raw.replace(/\s+/g, ' ').trim().slice(-48).trim());
      if (!all.length) return;
      heardW = sumWeight(all);

      // 질의 후보: 최근 말 꼬리(길게/짧게) + 지금 발화 구간만 — 다시 읽기는 보통 새 발화로 시작
      const tail = all.slice(-60);
      const cands = [tailByWeight(tail, 8), tailByWeight(tail, 4)];
      if (seg.length && seg.length < tail.length) cands.push(tailByWeight(seg, 8));

      // 마지막으로 맞춘 뒤 새로 들린 말만큼은 앞으로 나가도 '정상 진행'
      // (인식 결과가 한 문장씩 몰려 와도 건너뛰기로 오해하지 않게. 애드리브가 길어도 너무 넓어지지 않게 상한)
      const newW = heardW - matchedAtW;   // 마지막으로 맞춘 뒤 새로 들린 말의 양
      const best = locate(cands, Math.max(LOCAL_W, Math.min(newW + 12, LOCAL_MAX_W)), newW, all.slice(Math.max(0, matchedAtLen - 4)));
      if (!best) { checkMismatch(); return; }   // 확인 대기(pending)는 유지 — 잡음 섞인 결과 하나로 증거를 버리지 않음
      if (best.far) {
        // 건너뛰기·되돌아가기는 연달아 같은 곳(또는 그 뒤로 이어 읽은 곳)을 가리킬 때만 이동 — 반복 문구·애드리브에
        // 속아 화면이 엉뚱하게 튀지 않게. 앞으로 건너뛰기는 3번, 되돌아가기는 2번 연속 확인
        const consistent = pending && best.j >= pending.j - 3 && cum[best.j] - cum[pending.j] <= heardW - pending.w + 10;
        if (!consistent) { pending = { j: best.j, w: heardW, n: 0 }; return; }
        if (heardW <= pending.w) return;   // 새로 들린 말 없이 같은 결과가 다시 온 것(확정 알림 등)은 확인으로 안 침
        pending.n++; pending.j = best.j; pending.w = heardW;
        if (pending.n >= (best.dw > 0 ? 2 : 1)) { pending = null; matched(all.length); moveTo(best.j, 'voice'); }
        return;
      }
      pending = null;
      matched(all.length);
      if (best.dw > 0) moveTo(best.j, 'voice');
    }
    function matched(len) { matchedAtW = heardW; matchedAtLen = len; }

    /** 들린 말 H 의 끝부분이 대본 S[a..b) 를 실제로 읽은 것인지(편집 비용 비율로) 확인 */
    function covers(H, a, b) {
      const T = S.slice(a, b);
      if (!T.length || !H.length) return false;
      const h = H.slice(-80);
      return matchCosts(h, T)[h.length] / T.length <= 0.4;
    }

    /** 후보 질의마다 대본 전체에서 가장 그럴듯한 끝 위치를 찾고, 이동 종류별 기준으로 채택 */
    function locate(cands, localW, newW, H) {
      const curW = cum[cursor];
      const cov = new Map();   // j → 들린 말이 대본 [cursor, j) 를 덮는지(캐시)
      const covered = (j) => { if (!cov.has(j)) cov.set(j, covers(H, cursor, j)); return cov.get(j); };
      const list = [];
      let reach = 0;           // 들린 말이 실제로 덮는 가장 먼 '정상 진행' 거리
      for (const cd of cands) {
        if (cd.w < 2 || !cd.q.length) continue;
        const D = matchCosts(S, cd.q), m = cd.q.length;
        for (let j = 1; j <= S.length; j++) {
          const err = D[j] / m;
          if (err > 0.34) continue;
          const dw = cum[j] - curW;
          // 위치를 옮길 때는 방금 말한 마지막 두 글자가 그 위치 대본과 맞아야 함
          // (조금씩 밀려 나가거나, 끝 글자를 잘못 들어 엉뚱한 곳으로 되돌아가는 것 방지)
          if ((dw > 0 || dw < -SMALL_BACK) && m >= 2 && j >= 2 && subCost(cd.q[m - 1], S[j - 1]) + subCost(cd.q[m - 2], S[j - 2]) > 0.5) continue;
          let pen, ok, far = false, local = false;
          // 정상 진행: 가까우면 그대로, 꽤 멀면 그동안 들린 말이 그 사이 대본을 실제로 읽은 것일 때만
          // (아니면 애드리브 속 흔한 문구가 우연히 맞은 것 → 건너뛰기로 보고 연속 확인)
          if (dw > 0 && dw <= localW && (dw <= 8 || covered(j))) { pen = 0; ok = local = true; if (dw > 8) reach = Math.max(reach, dw); }
          else if (dw > 0) { pen = 0.0025 * Math.max(0, dw - LOCAL_W); ok = cd.w >= 5 && err <= 0.2; far = true; }   // 건너뛰기
          else if (dw >= -SMALL_BACK) { pen = 0.02; ok = newW <= cd.w + 4; }  // 제자리(흔들림) — 새로 들린 말이 많으면 반복 문구 우연 일치
          else { pen = 0.04 + 0.002 * -dw; ok = cd.w >= 3.5 && err <= 0.2; far = true; }                        // 다시 읽기
          if (!ok) continue;
          list.push({ j, err, dw, far, local, base: err + pen - cd.w * 0.002 });   // 같은 조건이면 긴 질의를 조금 우대
        }
      }
      let best = null;
      for (const c of list) {
        // 같은 문구가 가까이·멀리 다 있고 들린 말이 먼 쪽까지 실제로 덮으면, 덜 나아가는 후보는 감점
        const score = c.base + (c.local ? 0.004 * Math.max(0, Math.min(newW, reach) - c.dw - 10) : 0);
        if (!best || score < best.score) best = Object.assign(c, { score });
      }
      return best;
    }

    /* ---------- 마이크 시작/중지 ---------- */
    function start() {
      if (!SR) { status('unsupported'); return false; }
      if (active) return true;
      active = true; restarts = [];
      decideLang();
      startRec();
      return true;
    }
    function stop() {
      active = false;
      clearTimeout(restartTimer);
      const r = rec; rec = null;
      if (r) { try { r.abort(); } catch (e) {} }
      status('off');
    }
    function startRec() {
      clearTimeout(restartTimer);
      if (!active) return;
      const r = new SR();
      r.lang = lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
      r.onstart = () => { if (rec !== r) return; snap = null; rebase(); status('listening'); };
      r.onresult = (ev) => { if (rec === r) onResult(ev); };
      r.onerror = (ev) => {
        if (rec !== r) return;
        const e = ev.error;
        if (e === 'not-allowed' || e === 'service-not-allowed') { active = false; status('denied'); }
        else if (e === 'audio-capture') { active = false; status('nomic'); }
        else if (e === 'network') status('network');
        else if (e === 'language-not-supported') status('lang');
      };
      r.onend = () => {
        if (rec !== r) return;
        rec = null;
        if (active) scheduleRestart(); else status('off');
      };
      rec = r;
      status('starting');
      try { r.start(); } catch (e) { rec = null; scheduleRestart(); }
    }
    /** 브라우저가 침묵·네트워크 등으로 인식을 끝내면 자동 재시작(연속 실패 시 간격을 늘림) */
    function scheduleRestart() {
      const now = performance.now();
      restarts = restarts.filter((t) => now - t < 10000);
      restarts.push(now);
      restartTimer = setTimeout(startRec, restarts.length > 6 ? 2000 : 80);
    }

    /* ---------- 조회 ---------- */
    function progress() {
      return { readW: cum[cursor] || 0, totalW: total, frac: total ? (cum[cursor] || 0) / total : 0, done: cursor >= S.length && S.length > 0 };
    }
    function rate() { return rateT >= 4 ? rateW / rateT : null; }

    return {
      attach, pause, start, stop, setMode, setCursorWord, jumpSentence,
      toggle: () => (active ? (stop(), false) : start()),
      isActive: () => active,
      getMode: () => mode, getLang: () => lang,
      progress, rate
    };
  }

  global.Voice = { supported: !!SR, createTracker, weightOfText, toUnits };
})(window);
