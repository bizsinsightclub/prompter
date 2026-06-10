/* =======================================================================
   sync.js — 동기화 계층 (BroadcastChannel + PeerJS)
   기존 prompter/viewer/remote.html 에 흩어져 있던 P2P 로직을 한 곳으로 모았다.

   메시지 종류
   - {type:'state', ...}  : 가벼운 상태(인덱스/타이머/노트). 매초 갱신.
   - {type:'slide', idx, total, image} : 무거운 슬라이드 이미지. 페이지 전환 시에만.
   연단(deck)은 PDF를 직접 안 들고, host 가 보내준 image 만 표시한다.
   ======================================================================= */
(function (global) {
  const cfg = global.PROMPTER_CONFIG || {};
  const BC_NAME = 'prompter_sync';
  const PREFIX = cfg.peerPrefix || 'prompter';

  function rand3() { return String(Math.floor(Math.random() * 1000)).padStart(3, '0'); }

  /* ---------------------- HOST (프롬프터) ---------------------- */
  function createHost(opts) {
    opts = opts || {};
    const bc = new BroadcastChannel(BC_NAME);
    let peer = null, code = null, peerId = null;
    let conns = [];
    let lastState = null, lastSlide = null, attempt = 0;

    bc.onmessage = (e) => {
      if (e.data && e.data.type === 'deck-hello') {
        if (lastSlide) bc.postMessage(lastSlide);
        if (lastState) bc.postMessage(lastState);
      }
    };

    function startPeer() {
      code = rand3();
      peerId = `${PREFIX}-${code}`;
      if (opts.onStatus) opts.onStatus('연결 준비 중…');
      peer = new Peer(peerId);
      peer.on('open', (id) => {
        if (opts.onReady) opts.onReady({ code, peerId: id });
        if (opts.onStatus) opts.onStatus('기기 연결 대기 중');
      });
      peer.on('connection', (conn) => {
        conn.on('open', () => {
          conns.push(conn);
          if (lastSlide && conn._role !== 'remote') conn.send(lastSlide);
          if (lastState) conn.send(lastState);
          notifyDevices();
        });
        conn.on('data', (d) => handleData(d, conn));
        conn.on('close', () => { conns = conns.filter((c) => c !== conn); notifyDevices(); });
        conn.on('error', () => { conns = conns.filter((c) => c !== conn); notifyDevices(); });
      });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && attempt < 8) {
          attempt++; try { peer.destroy(); } catch (e) {} startPeer();
        } else if (opts.onStatus) opts.onStatus('연결 실패: ' + err.type);
      });
    }

    function handleData(d, conn) {
      if (!d || !d.cmd) return;
      if (d.cmd === 'hello') { conn._role = d.role; if (lastSlide && d.role !== 'remote') conn.send(lastSlide); notifyDevices(); return; }
      if (opts.onCommand) opts.onCommand(d.cmd);
    }
    function notifyDevices() {
      const phones = conns.filter((c) => c._role === 'remote' && c.open).length;
      const decks = conns.filter((c) => c._role === 'deck' && c.open).length;
      if (opts.onDevices) opts.onDevices({ phones, decks });
    }

    /** 가벼운 상태(매초) */
    function broadcast(state) {
      lastState = state;
      try { bc.postMessage(state); } catch (e) {}
      conns.forEach((c) => { if (c.open) { try { c.send(state); } catch (e) {} } });
    }
    /** 무거운 슬라이드 이미지(전환 시) — 폰 리모컨에는 보내지 않음 */
    function sendSlide(payload) {
      lastSlide = payload;
      try { bc.postMessage(payload); } catch (e) {}
      conns.forEach((c) => { if (c.open && c._role !== 'remote') { try { c.send(payload); } catch (e) {} } });
    }
    /** 영상 제어(play/close) — deck 에만 전송 */
    function sendMedia(payload) {
      try { bc.postMessage(payload); } catch (e) {}
      conns.forEach((c) => { if (c.open && c._role !== 'remote') { try { c.send(payload); } catch (e) {} } });
    }
    function deckFollowerCount() { return conns.filter((c) => c._role === 'deck' && c.open).length; }

    return { startPeer, broadcast, sendSlide, sendMedia, deckFollowerCount, getCode: () => code, getPeerId: () => peerId };
  }

  /* ---------------------- LISTEN BROADCAST (같은 PC deck) ---------------------- */
  function listenBroadcast(onMessage) {
    const bc = new BroadcastChannel(BC_NAME);
    bc.onmessage = (e) => { if (e.data && e.data.type) onMessage(e.data); };
    bc.postMessage({ type: 'deck-hello' });
    return { close: () => bc.close(), channel: bc };
  }

  /* ---------------------- CONNECT PEER (deck/remote) ---------------------- */
  function connectPeer(sessionId, role, handlers) {
    handlers = handlers || {};
    const peer = new Peer();
    let conn = null;
    peer.on('open', () => {
      conn = peer.connect(sessionId, { reliable: true });
      conn.on('open', () => {
        conn.send({ cmd: 'hello', role });
        if (handlers.onOpen) handlers.onOpen();
        if (handlers.onStatus) handlers.onStatus('ok', '연결됨');
      });
      conn.on('data', (d) => { if (d && d.type && handlers.onMessage) handlers.onMessage(d); });
      conn.on('close', () => { if (handlers.onClose) handlers.onClose(); if (handlers.onStatus) handlers.onStatus('bad', '연결 끊김'); });
      conn.on('error', () => { if (handlers.onStatus) handlers.onStatus('bad', '연결 오류'); });
    });
    peer.on('error', (e) => { if (handlers.onStatus) handlers.onStatus('bad', '연결 실패: ' + e.type); });
    return { peer, getConn: () => conn, send: (cmd) => { if (conn && conn.open) conn.send({ cmd }); } };
  }

  function sessionFromCode(code) { return `${PREFIX}-${String(code).trim()}`; }

  global.Sync = { createHost, listenBroadcast, connectPeer, sessionFromCode, rand3 };
})(window);
