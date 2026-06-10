/* =======================================================================
   pdf-render.js — pdf.js 래퍼 + PDF 영속화(IndexedDB)
   - PDF를 로드하고(File/ArrayBuffer/URL), 페이지를 이미지(dataURL)로 렌더.
   - 마지막에 연 PDF를 IndexedDB에 저장해 새로고침 후에도 유지.
   - 프롬프터(썸네일)와 host→deck 이미지 전송이 모두 이 모듈을 쓴다.
   ======================================================================= */
(function (global) {
  const PDFJS_VERSION = '4.7.76';
  const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;

  let pdfDoc = null;
  let numPages = 0;
  let currentName = '';
  const cache = new Map(); // `${idx}@${w}@${type}` → dataURL

  let _libPromise = null;
  function loadLib() {
    if (_libPromise) return _libPromise;
    _libPromise = import(`${CDN}/pdf.min.mjs`).then((mod) => {
      const lib = mod.default || mod;
      lib.GlobalWorkerOptions.workerSrc = `${CDN}/pdf.worker.min.mjs`;
      return lib;
    });
    return _libPromise;
  }

  async function _open(arrayBuffer) {
    const lib = await loadLib();
    cache.clear();
    // pdf.js 가 버퍼를 detach 하므로 저장용 복사본을 따로 유지하려면 호출부에서 관리
    pdfDoc = await lib.getDocument({ data: arrayBuffer }).promise;
    numPages = pdfDoc.numPages;
    return numPages;
  }

  /**
   * PDF 로드. File/Blob/ArrayBuffer/URL(string) 지원. 로드 후 IndexedDB에 저장.
   * @returns {Promise<number>} 페이지 수
   */
  async function loadPdf(src, name) {
    let buffer;
    if (typeof src === 'string') {
      const res = await fetch(src);
      buffer = await res.arrayBuffer();
      name = name || src;
    } else if (src instanceof Blob) {
      buffer = await src.arrayBuffer();
      name = name || src.name || 'document.pdf';
    } else if (src instanceof ArrayBuffer) {
      buffer = src;
      name = name || 'document.pdf';
    } else {
      throw new Error('loadPdf: 지원하지 않는 src');
    }
    currentName = name;
    // 저장용 복사본 먼저 확보(렌더 시 원본이 detach 될 수 있음)
    const stash = buffer.slice(0);
    await _open(buffer);
    idbSave(name, stash).catch(() => {});
    return numPages;
  }

  function pageCount() { return numPages; }
  function isLoaded() { return !!pdfDoc; }
  function name() { return currentName; }

  async function renderPageDataURL(idx, width, opts) {
    if (!pdfDoc) throw new Error('renderPage: PDF 미로드');
    opts = opts || {};
    const type = opts.type || 'image/png';
    const quality = opts.quality;
    const clamped = Math.max(0, Math.min(numPages - 1, idx));
    const key = `${clamped}@${width}@${type}`;
    if (cache.has(key)) return cache.get(key);

    const page = await pdfDoc.getPage(clamped + 1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    await page.render({ canvasContext: ctx, viewport }).promise;

    const url = canvas.toDataURL(type, quality);
    cache.set(key, url);
    return url;
  }

  async function aspectRatio() {
    if (!pdfDoc) return 16 / 9;
    const page = await pdfDoc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    return vp.width / vp.height;
  }

  /* ---------- IndexedDB 영속화 ---------- */
  const DB = 'prompter-pdf', STORE = 'pdf', MEDIA = 'media';
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSave(name, buffer) {
    try {
      const db = await idbOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ name, buffer }, 'current');
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) {}
  }
  /** 저장된 PDF가 있으면 로드. 없으면 false. */
  async function loadStored() {
    try {
      const db = await idbOpen();
      const rec = await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get('current');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      if (rec && rec.buffer) {
        currentName = rec.name || 'document.pdf';
        await _open(rec.buffer.slice(0));
        return true;
      }
    } catch (e) {}
    return false;
  }
  async function clearStored() {
    try {
      const db = await idbOpen();
      await new Promise((res) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete('current');
        tx.oncomplete = res; tx.onerror = res;
      });
    } catch (e) {}
  }

  /* ---------- 영상(로컬 mp4) blob 저장/로드 ---------- */
  async function saveMedia(key, blob) {
    try {
      const db = await idbOpen();
      await new Promise((res, rej) => {
        const tx = db.transaction(MEDIA, 'readwrite');
        tx.objectStore(MEDIA).put(blob, key);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return true;
    } catch (e) { return false; }
  }
  /** key 의 mp4 blob → objectURL (없으면 null). 같은 origin(같은 PC deck)에서 공유됨. */
  async function loadMediaURL(key) {
    try {
      const db = await idbOpen();
      const blob = await new Promise((res, rej) => {
        const tx = db.transaction(MEDIA, 'readonly');
        const r = tx.objectStore(MEDIA).get(key);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      return blob ? URL.createObjectURL(blob) : null;
    } catch (e) { return null; }
  }
  async function deleteMedia(key) {
    try {
      const db = await idbOpen();
      await new Promise((res) => {
        const tx = db.transaction(MEDIA, 'readwrite');
        tx.objectStore(MEDIA).delete(key);
        tx.oncomplete = res; tx.onerror = res;
      });
    } catch (e) {}
  }

  global.PdfRender = {
    loadPdf, renderPageDataURL, pageCount, isLoaded, aspectRatio, name,
    loadStored, clearStored, saveMedia, loadMediaURL, deleteMedia
  };
})(window);
