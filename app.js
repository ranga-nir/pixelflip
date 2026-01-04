/*
  Img Converter — client-side image conversion using Canvas.
  - Convert: PNG/JPEG/WebP (output)
  - Crop (optional, drag-to-select)
  - Effects: grayscale, sepia, reflect, box blur, edges (Sobel)
*/

const els = {
  fileInput: document.getElementById('fileInput'),
  outFormat: document.getElementById('outFormat'),
  quality: document.getElementById('quality'),
  qualityLabel: document.getElementById('qualityLabel'),

  enableCrop: document.getElementById('enableCrop'),
  btnResetCrop: document.getElementById('btnResetCrop'),

  fxGrayscale: document.getElementById('fxGrayscale'),
  fxSepia: document.getElementById('fxSepia'),
  fxReflect: document.getElementById('fxReflect'),
  fxBlur: document.getElementById('fxBlur'),
  blurLabel: document.getElementById('blurLabel'),
  fxEdges: document.getElementById('fxEdges'),

  btnPreview: document.getElementById('btnPreview'),
  btnConvert: document.getElementById('btnConvert'),
  status: document.getElementById('status'),

  previewWrap: document.getElementById('previewWrap'),
  previewCanvas: document.getElementById('previewCanvas'),
  previewMeta: document.getElementById('previewMeta'),

  queueBody: document.getElementById('queueBody'),
};

/** @type {File[]} */
let selectedFiles = [];
let activePreviewIndex = 0;

/** @type {Map<File, {w:number, h:number}>} */
const fileDimCache = new Map();

const state = {
  cropEnabled: false,
  /** @type {{sx:number, sy:number, sw:number, sh:number} | null} */
  cropRect: null, // source-pixel crop
  /** @type {{sx:number, sy:number} | null} */
  dragStart: null, // source-pixel point
  /** @type {{sx:number, sy:number, sw:number, sh:number} | null} */
  dragRect: null, // source-pixel rect while dragging
  /** @type {{srcW:number, srcH:number, canvasW:number, canvasH:number} | null} */
  previewInfo: null,
};

function setStatus(html, kind = 'muted') {
  const cls = {
    muted: 'text-muted',
    ok: 'text-success',
    warn: 'text-warning',
    err: 'text-danger',
  }[kind] || 'text-muted';
  els.status.className = `mt-3 small ${cls}`;
  els.status.innerHTML = html;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function clampRectToBounds(rect, boundsW, boundsH) {
  const sx = clamp(Math.trunc(rect.sx), 0, Math.max(0, boundsW - 1));
  const sy = clamp(Math.trunc(rect.sy), 0, Math.max(0, boundsH - 1));
  const maxW = Math.max(1, boundsW - sx);
  const maxH = Math.max(1, boundsH - sy);
  const sw = clamp(Math.trunc(rect.sw), 1, maxW);
  const sh = clamp(Math.trunc(rect.sh), 1, maxH);
  return { sx, sy, sw, sh };
}

function updateLabels() {
  els.qualityLabel.textContent = Number(els.quality.value).toFixed(2);
  els.blurLabel.textContent = `${els.fxBlur.value}px`;
}

function updateCropUi() {
  els.btnResetCrop.disabled = !state.cropEnabled || !state.cropRect;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n.toFixed(u === 0 ? 0 : 2)} ${units[u]}`;
}

function extForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'img';
}

function effectConfig() {
  return {
    grayscale: !!els.fxGrayscale.checked,
    sepia: !!els.fxSepia.checked,
    reflect: !!els.fxReflect.checked,
    blurRadius: Math.max(0, Math.trunc(Number(els.fxBlur.value) || 0)),
    edges: !!els.fxEdges.checked,
  };
}

async function decodeImageFromFile(file) {
  // Prefer ImageBitmap (fast, off-main-thread-ish), fallback to HTMLImageElement.
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file);
      fileDimCache.set(file, { w: bmp.width, h: bmp.height });
      return { kind: 'bitmap', img: bmp, width: bmp.width, height: bmp.height };
    } catch {
      // Continue to fallback.
    }
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('Failed to read file'));
    fr.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Image decode failed'));
    el.src = dataUrl;
  });

  fileDimCache.set(file, { w: img.naturalWidth, h: img.naturalHeight });

  return { kind: 'img', img, width: img.naturalWidth, height: img.naturalHeight };
}

function activeCropRectOrFull(srcW, srcH) {
  if (!state.cropEnabled) return { sx: 0, sy: 0, sw: srcW, sh: srcH };
  if (state.dragRect) return clampRectToBounds(state.dragRect, srcW, srcH);
  if (state.cropRect) return clampRectToBounds(state.cropRect, srcW, srcH);
  return { sx: 0, sy: 0, sw: srcW, sh: srcH };
}

function normalizeRectFromPoints(a, b) {
  const x1 = Math.min(a.sx, b.sx);
  const y1 = Math.min(a.sy, b.sy);
  const x2 = Math.max(a.sx, b.sx);
  const y2 = Math.max(a.sy, b.sy);
  return { sx: x1, sy: y1, sw: Math.max(1, x2 - x1), sh: Math.max(1, y2 - y1) };
}

function applyGrayscale(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
  }
}

function applySepia(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const nr = Math.round(0.393 * r + 0.769 * g + 0.189 * b);
    const ng = Math.round(0.349 * r + 0.686 * g + 0.168 * b);
    const nb = Math.round(0.272 * r + 0.534 * g + 0.131 * b);
    data[i] = nr > 255 ? 255 : nr;
    data[i + 1] = ng > 255 ? 255 : ng;
    data[i + 2] = nb > 255 ? 255 : nb;
  }
}

function boxBlurRGBA(data, width, height, radius) {
  if (radius <= 0) return;
  const r = Math.min(radius, 50);
  const tmp = new Uint8ClampedArray(data.length);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    let count = 0;

    for (let x = -r; x <= r; x++) {
      const cx = clamp(x, 0, width - 1);
      const idx = (y * width + cx) * 4;
      sumR += data[idx];
      sumG += data[idx + 1];
      sumB += data[idx + 2];
      sumA += data[idx + 3];
      count += 1;
    }

    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * 4;
      tmp[outIdx] = Math.round(sumR / count);
      tmp[outIdx + 1] = Math.round(sumG / count);
      tmp[outIdx + 2] = Math.round(sumB / count);
      tmp[outIdx + 3] = Math.round(sumA / count);

      const xRemove = x - r;
      const xAdd = x + r + 1;
      const rx = clamp(xRemove, 0, width - 1);
      const ax = clamp(xAdd, 0, width - 1);
      const ridx = (y * width + rx) * 4;
      const aidx = (y * width + ax) * 4;
      sumR += data[aidx] - data[ridx];
      sumG += data[aidx + 1] - data[ridx + 1];
      sumB += data[aidx + 2] - data[ridx + 2];
      sumA += data[aidx + 3] - data[ridx + 3];
    }
  }

  // Vertical pass back into data
  for (let x = 0; x < width; x++) {
    let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    let count = 0;

    for (let y = -r; y <= r; y++) {
      const cy = clamp(y, 0, height - 1);
      const idx = (cy * width + x) * 4;
      sumR += tmp[idx];
      sumG += tmp[idx + 1];
      sumB += tmp[idx + 2];
      sumA += tmp[idx + 3];
      count += 1;
    }

    for (let y = 0; y < height; y++) {
      const outIdx = (y * width + x) * 4;
      data[outIdx] = Math.round(sumR / count);
      data[outIdx + 1] = Math.round(sumG / count);
      data[outIdx + 2] = Math.round(sumB / count);
      data[outIdx + 3] = Math.round(sumA / count);

      const yRemove = y - r;
      const yAdd = y + r + 1;
      const ry = clamp(yRemove, 0, height - 1);
      const ay = clamp(yAdd, 0, height - 1);
      const ridx = (ry * width + x) * 4;
      const aidx = (ay * width + x) * 4;
      sumR += tmp[aidx] - tmp[ridx];
      sumG += tmp[aidx + 1] - tmp[ridx + 1];
      sumB += tmp[aidx + 2] - tmp[ridx + 2];
      sumA += tmp[aidx + 3] - tmp[ridx + 3];
    }
  }
}

function sobelEdgesRGBA(data, width, height) {
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    lum[p] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }

  const out = new Uint8ClampedArray(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;

      const a00 = lum[i - width - 1];
      const a01 = lum[i - width];
      const a02 = lum[i - width + 1];
      const a10 = lum[i - 1];
      const a12 = lum[i + 1];
      const a20 = lum[i + width - 1];
      const a21 = lum[i + width];
      const a22 = lum[i + width + 1];

      const gx = (-1 * a00) + (1 * a02) + (-2 * a10) + (2 * a12) + (-1 * a20) + (1 * a22);
      const gy = (1 * a00) + (2 * a01) + (1 * a02) + (-1 * a20) + (-2 * a21) + (-1 * a22);

      const mag = clamp(Math.abs(gx) + Math.abs(gy), 0, 255);
      out[i] = mag;
    }
  }

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const v = out[p];
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
}

function applyEffectsToImageData(imageData) {
  const { grayscale, sepia, blurRadius, edges } = effectConfig();
  const { data, width, height } = imageData;

  if (sepia) applySepia(data);
  if (grayscale) applyGrayscale(data);
  if (blurRadius > 0) boxBlurRGBA(data, width, height, blurRadius);
  if (edges) sobelEdgesRGBA(data, width, height);
}

async function renderTransformedCanvas(file) {
  const decoded = await decodeImageFromFile(file);
  const { width: srcW, height: srcH } = decoded;

  const crop = activeCropRectOrFull(srcW, srcH);
  const outW = crop.sw;
  const outH = crop.sh;

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas not supported');

  ctx.clearRect(0, 0, outW, outH);

  const { reflect } = effectConfig();
  if (reflect) {
    ctx.save();
    ctx.translate(outW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(decoded.img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH);
    ctx.restore();
  } else {
    ctx.drawImage(decoded.img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH);
  }

  const imageData = ctx.getImageData(0, 0, outW, outH);
  applyEffectsToImageData(imageData);
  ctx.putImageData(imageData, 0, 0);

  // Cleanup ImageBitmap if used.
  if (decoded.kind === 'bitmap' && decoded.img && typeof decoded.img.close === 'function') {
    decoded.img.close();
  }

  return { canvas, srcW, srcH, crop, out: { outW, outH } };
}

async function canvasToBlob(canvas, mime, quality) {
  const q = (mime === 'image/jpeg' || mime === 'image/webp') ? quality : undefined;
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('Failed to encode output (browser codec missing?)'));
      else resolve(blob);
    }, mime, q);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function safeBaseName(name) {
  const base = name.replace(/\.[^./\\]+$/, '');
  return base.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120) || 'image';
}

function setButtonsEnabled(enabled) {
  els.btnPreview.disabled = !enabled;
  els.btnConvert.disabled = !enabled;
}

function renderQueue() {
  if (selectedFiles.length === 0) {
    els.queueBody.innerHTML = '<tr><td colspan="4" class="text-muted">Add images to begin.</td></tr>';
    return;
  }

  const rows = selectedFiles.map((f, idx) => {
    const isActive = idx === activePreviewIndex;
    return `
      <tr data-index="${idx}" class="${isActive ? 'table-active' : ''}">
        <td class="text-truncate" style="max-width: 260px" title="${f.name}">${f.name}</td>
        <td class="text-end text-muted">${formatBytes(f.size)}</td>
        <td class="text-end"><span class="badge text-bg-secondary">pending</span></td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-secondary" data-action="preview" data-index="${idx}">Preview</button>
        </td>
      </tr>
    `;
  }).join('');

  els.queueBody.innerHTML = rows;
}

async function doPreview() {
  if (selectedFiles.length === 0) return;

  const file = selectedFiles[activePreviewIndex];
  setStatus('Rendering preview…', 'muted');

  try {
    const decoded = await decodeImageFromFile(file);
    const { width: srcW, height: srcH } = decoded;
    const crop = activeCropRectOrFull(srcW, srcH);

    // Fit preview canvas into wrapper while preserving aspect ratio.
    const wrapRect = els.previewWrap.getBoundingClientRect();
    const maxCssW = Math.max(1, Math.floor(wrapRect.width));
    const maxCssH = Math.max(1, Math.floor(wrapRect.height));
    const ratio = srcW / srcH;

    let cssW = maxCssW;
    let cssH = Math.round(cssW / ratio);
    if (cssH > maxCssH) {
      cssH = maxCssH;
      cssW = Math.round(cssH * ratio);
    }

    const dpr = window.devicePixelRatio || 1;
    const canvasW = Math.max(1, Math.round(cssW * dpr));
    const canvasH = Math.max(1, Math.round(cssH * dpr));

    els.previewCanvas.width = canvasW;
    els.previewCanvas.height = canvasH;
    els.previewCanvas.style.width = `${cssW}px`;
    els.previewCanvas.style.height = `${cssH}px`;

    state.previewInfo = { srcW, srcH, canvasW, canvasH };

    const ctx = els.previewCanvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, canvasW, canvasH);

    const { reflect } = effectConfig();
    if (reflect) {
      ctx.save();
      ctx.translate(canvasW, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(decoded.img, 0, 0, srcW, srcH, 0, 0, canvasW, canvasH);
      ctx.restore();
    } else {
      ctx.drawImage(decoded.img, 0, 0, srcW, srcH, 0, 0, canvasW, canvasH);
    }

    const imageData = ctx.getImageData(0, 0, canvasW, canvasH);
    applyEffectsToImageData(imageData);
    ctx.putImageData(imageData, 0, 0);

    // Draw crop overlay (preview).
    if (state.cropEnabled) {
      const show = state.dragRect || state.cropRect;
      if (show) {
        const r = clampRectToBounds(show, srcW, srcH);
        const px = (r.sx / srcW) * canvasW;
        const py = (r.sy / srcH) * canvasH;
        const pw = (r.sw / srcW) * canvasW;
        const ph = (r.sh / srcH) * canvasH;

        ctx.save();
        ctx.lineWidth = Math.max(2, Math.round(2 * dpr));
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.strokeRect(px, py, pw, ph);
        ctx.restore();
      }
    }

    els.previewMeta.textContent = `src ${srcW}×${srcH} • crop ${crop.sw}×${crop.sh} @ (${crop.sx},${crop.sy}) • out ${crop.sw}×${crop.sh}`;
    setStatus('Preview ready.', 'ok');

    // Cleanup ImageBitmap if used.
    if (decoded.kind === 'bitmap' && decoded.img && typeof decoded.img.close === 'function') {
      decoded.img.close();
    }
  } catch (e) {
    els.previewMeta.textContent = 'Preview failed';
    setStatus(`Preview error: ${String(e && e.message ? e.message : e)}`, 'err');
  }
}

function canvasEventToSourcePoint(ev) {
  const info = state.previewInfo;
  if (!info) return null;

  const rect = els.previewCanvas.getBoundingClientRect();
  const xCss = ev.clientX - rect.left;
  const yCss = ev.clientY - rect.top;

  const xCanvas = (xCss / rect.width) * info.canvasW;
  const yCanvas = (yCss / rect.height) * info.canvasH;

  const sx = clamp(Math.round((xCanvas / info.canvasW) * info.srcW), 0, info.srcW - 1);
  const sy = clamp(Math.round((yCanvas / info.canvasH) * info.srcH), 0, info.srcH - 1);
  return { sx, sy };
}

async function doConvertAll() {
  if (selectedFiles.length === 0) return;

  const mime = els.outFormat.value;
  const quality = Number(els.quality.value);

  if (mime === 'image/jpeg') {
    setStatus('Note: JPEG does not support transparency; transparent pixels will become black.', 'warn');
  }

  setButtonsEnabled(false);
  setStatus('Converting…', 'muted');

  // Mark rows as working.
  for (const tr of els.queueBody.querySelectorAll('tr[data-index]')) {
    tr.dataset.state = 'working';
    const badge = tr.querySelector('.badge');
    if (badge) {
      badge.className = 'badge text-bg-warning';
      badge.textContent = 'working';
    }
  }

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < selectedFiles.length; i++) {
    const file = selectedFiles[i];
    const tr = els.queueBody.querySelector(`tr[data-index="${i}"]`);

    try {
      const { canvas } = await renderTransformedCanvas(file);
      const blob = await canvasToBlob(canvas, mime, quality);

      const base = safeBaseName(file.name);
      const outName = `${base}.${extForMime(mime)}`;

      // Auto-download.
      downloadBlob(blob, outName);

      ok += 1;
      if (tr) {
        const badge = tr.querySelector('.badge');
        if (badge) {
          badge.className = 'badge text-bg-success';
          badge.textContent = 'done';
        }
        const btnCell = tr.querySelector('td:last-child');
        if (btnCell) {
          btnCell.innerHTML = '<span class="text-muted small">downloaded</span>';
        }
      }
    } catch (e) {
      fail += 1;
      if (tr) {
        const badge = tr.querySelector('.badge');
        if (badge) {
          badge.className = 'badge text-bg-danger';
          badge.textContent = 'failed';
        }
      }
      console.error(e);
    } finally {
      if (tr) tr.dataset.state = '';
    }
  }

  setStatus(`Done. Success: ${ok}. Failed: ${fail}.`, fail ? 'warn' : 'ok');
  setButtonsEnabled(true);
}

function handleFiles(files) {
  selectedFiles = Array.from(files || []).filter((f) => f && f.type && f.type.startsWith('image/'));
  activePreviewIndex = 0;

  fileDimCache.clear();
  state.cropRect = null;
  state.dragRect = null;
  state.dragStart = null;
  updateCropUi();

  renderQueue();
  setButtonsEnabled(selectedFiles.length > 0);

  if (selectedFiles.length > 0) {
    setStatus(`Loaded ${selectedFiles.length} image(s). Choose settings, then Preview or Convert.`, 'ok');
    els.previewMeta.textContent = `Ready • ${selectedFiles[0].name}`;
    // Render an initial preview immediately.
    doPreview();
  } else {
    setStatus('No images selected.', 'muted');
    els.previewMeta.textContent = 'No image loaded';
  }
}

function wireQueueClicks() {
  els.queueBody.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
    if (!btn) return;

    const action = btn.getAttribute('data-action');
    const idx = Number(btn.getAttribute('data-index'));
    if (!Number.isFinite(idx)) return;

    if (action === 'preview') {
      activePreviewIndex = idx;
      renderQueue();
      doPreview();
    }
  });
}

function wireCropDragOnPreview() {
  function onDown(ev) {
    if (!state.cropEnabled || selectedFiles.length === 0) return;
    const p = canvasEventToSourcePoint(ev);
    if (!p) return;
    state.dragStart = p;
    state.dragRect = { sx: p.sx, sy: p.sy, sw: 1, sh: 1 };
    updateCropUi();
    doPreview();
  }

  function onMove(ev) {
    if (!state.cropEnabled || !state.dragStart) return;
    const p = canvasEventToSourcePoint(ev);
    if (!p) return;
    state.dragRect = normalizeRectFromPoints(state.dragStart, p);
    doPreview();
  }

  function onUp(ev) {
    if (!state.cropEnabled || !state.dragStart) return;
    const p = canvasEventToSourcePoint(ev);
    if (!p) {
      state.dragStart = null;
      state.dragRect = null;
      doPreview();
      return;
    }

    const rect = normalizeRectFromPoints(state.dragStart, p);
    const info = state.previewInfo;
    state.dragStart = null;
    state.dragRect = null;

    if (!info) return;

    // If user just clicks without dragging, treat as "clear crop".
    if (rect.sw < 5 && rect.sh < 5) {
      state.cropRect = null;
      updateCropUi();
      doPreview();
      return;
    }

    state.cropRect = clampRectToBounds(rect, info.srcW, info.srcH);
    updateCropUi();
    doPreview();
  }

  els.previewCanvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function init() {
  updateLabels();
  updateCropUi();
  setButtonsEnabled(false);
  setStatus('Select images to start.', 'muted');

  els.quality.addEventListener('input', updateLabels);
  els.fxBlur.addEventListener('input', updateLabels);

  els.btnResetCrop.addEventListener('click', () => {
    state.cropRect = null;
    state.dragRect = null;
    state.dragStart = null;
    updateCropUi();
    if (selectedFiles.length) doPreview();
  });

  els.enableCrop.addEventListener('change', () => {
    state.cropEnabled = !!els.enableCrop.checked;
    if (!state.cropEnabled) {
      state.cropRect = null;
      state.dragRect = null;
      state.dragStart = null;
    }
    updateCropUi();
    if (selectedFiles.length) doPreview();
  });

  els.fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
  });

  els.btnPreview.addEventListener('click', doPreview);
  els.btnConvert.addEventListener('click', doConvertAll);

  // Auto-refresh preview when settings change (lightweight).
  for (const el of [
    els.outFormat,
    els.fxGrayscale,
    els.fxSepia,
    els.fxReflect,
    els.fxBlur,
    els.fxEdges,
  ]) {
    el.addEventListener('change', () => {
      if (!selectedFiles.length) return;
      doPreview();
    });
  }

  wireQueueClicks();
  wireCropDragOnPreview();
}

init();
