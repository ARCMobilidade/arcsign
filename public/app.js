pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

const TOTAL_STEPS = 4;
const DEFAULT_STAMP_WIDTH_RATIO = 0.32;
const DEFAULT_STAMP_HEIGHT_RATIO = 0.11;
const DEFAULT_DROPZONE_TEXT = 'Clique para escolher um PDF ou arraste o arquivo aqui';

const state = {
  step: 1,
  documentId: null,
  originalFilename: null,
  pdfDoc: null,
  numPages: 0,
  currentPage: 0,
  certInfo: null,
  stamp: null, // { page, xRatio, yRatio, widthRatio, heightRatio, allPages }
};

const els = {
  stepper: document.getElementById('stepper'),
  fileInput: document.getElementById('fileInput'),
  dropzone: document.getElementById('dropzone'),
  dropzoneText: document.getElementById('dropzoneText'),
  uploadError: document.getElementById('uploadError'),
  btnCertInfo: document.getElementById('btnCertInfo'),
  certResult: document.getElementById('certResult'),
  certError: document.getElementById('certError'),
  pageIndicator: document.getElementById('pageIndicator'),
  prevPage: document.getElementById('prevPage'),
  nextPage: document.getElementById('nextPage'),
  canvas: document.getElementById('pdfCanvas'),
  stampPreview: document.getElementById('stampPreview'),
  stampLabel: document.querySelector('#stampPreview .stamp-preview-label'),
  pdfViewport: document.getElementById('pdfViewport'),
  allPagesCheckbox: document.getElementById('allPagesCheckbox'),
  summaryBox: document.getElementById('summaryBox'),
  btnConfirm: document.getElementById('btnConfirm'),
  confirmError: document.getElementById('confirmError'),
  confirmSuccess: document.getElementById('confirmSuccess'),
  btnBack: document.getElementById('btnBack'),
  btnNext: document.getElementById('btnNext'),
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// --- Reset completo (voltar ao passo 1 recomeça o processo) ----------------

function resetWizardState() {
  state.documentId = null;
  state.originalFilename = null;
  state.pdfDoc = null;
  state.numPages = 0;
  state.currentPage = 0;
  state.certInfo = null;
  state.stamp = null;

  els.fileInput.value = '';
  els.dropzoneText.textContent = DEFAULT_DROPZONE_TEXT;
  els.uploadError.textContent = '';

  hide(els.certResult);
  els.certResult.innerHTML = '';
  els.certError.textContent = '';

  hide(els.stampPreview);
  els.allPagesCheckbox.checked = false;

  els.summaryBox.innerHTML = '';
  els.confirmError.textContent = '';
  hide(els.confirmSuccess);
}

// --- Navegação do wizard -------------------------------------------------

function canLeaveStep(step) {
  if (step === 1) return !!state.documentId;
  if (step === 2) return !!state.certInfo;
  if (step === 3) return !!state.stamp;
  return true;
}

function goToStep(step) {
  step = Math.min(Math.max(1, step), TOTAL_STEPS);
  const enteringStep1 = step === 1 && state.step !== 1;
  state.step = step;

  if (enteringStep1) resetWizardState();

  document.querySelectorAll('.wizard-step').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.step) === step);
  });
  document.querySelectorAll('#stepper li').forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle('active', s === step);
    li.classList.toggle('done', s < step);
  });

  els.btnBack.style.visibility = step === 1 ? 'hidden' : 'visible';
  const isLast = step === TOTAL_STEPS;
  els.btnNext.style.display = isLast ? 'none' : 'inline-block';

  if (step === 4) renderSummary();
  if (step === 3 && state.pdfDoc) renderPage();
}

els.btnBack.addEventListener('click', () => goToStep(state.step - 1));
els.btnNext.addEventListener('click', () => {
  if (!canLeaveStep(state.step)) {
    const msgs = {
      1: 'Envie um PDF antes de continuar.',
      2: 'Identifique o certificado A1 antes de continuar.',
      3: 'Posicione o carimbo no documento antes de continuar.',
    };
    if (state.step === 1) els.uploadError.textContent = msgs[1];
    if (state.step === 2) els.certError.textContent = msgs[2];
    return;
  }
  goToStep(state.step + 1);
});

document.querySelectorAll('#stepper li').forEach((li) => {
  li.addEventListener('click', () => {
    const target = Number(li.dataset.step);
    if (target <= state.step || (target === state.step + 1 && canLeaveStep(state.step))) {
      goToStep(target);
    }
  });
});

// --- Passo 1: upload ------------------------------------------------------

['dragover', 'dragleave', 'drop'].forEach((evtName) => {
  els.dropzone.addEventListener(evtName, (e) => {
    e.preventDefault();
    els.dropzone.classList.toggle('dragover', evtName === 'dragover');
  });
});
els.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) {
    els.fileInput.files = e.dataTransfer.files;
    handleFile(file);
  }
});
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  els.uploadError.textContent = '';
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/documents', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha no upload.');

    state.documentId = data.id;
    state.originalFilename = data.originalFilename;
    els.dropzoneText.textContent = `Arquivo selecionado: ${data.originalFilename}`;

    const arrayBuffer = await file.arrayBuffer();
    state.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    state.numPages = state.pdfDoc.numPages;
    state.currentPage = 0;
    state.stamp = null;
    hide(els.stampPreview);

    goToStep(2);
  } catch (err) {
    els.uploadError.textContent = err.message;
  }
}

// --- Passo 2: certificado --------------------------------------------------

els.btnCertInfo.addEventListener('click', async () => {
  els.certError.textContent = '';
  hide(els.certResult);
  try {
    const res = await fetch('/api/cert-info');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Não foi possível identificar o certificado.');

    state.certInfo = data;
    els.certResult.innerHTML = `
      <strong>${data.name || data.commonName}</strong><br/>
      CPF/CNPJ: ${data.doc || 'não identificado no certificado'}<br/>
      Emitido por: ${data.issuer || '—'}<br/>
      Válido de ${formatDate(data.validFrom)} até ${formatDate(data.validTo)}
    `;
    show(els.certResult);
  } catch (err) {
    els.certError.textContent = err.message;
  }
});

function formatDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? v : d.toLocaleDateString('pt-BR');
}

// --- Passo 3: posicionar / redimensionar carimbo ---------------------------

async function renderPage() {
  const page = await state.pdfDoc.getPage(state.currentPage + 1);
  const viewport = page.getViewport({ scale: 1.3 });
  els.canvas.width = viewport.width;
  els.canvas.height = viewport.height;
  const ctx = els.canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  els.pageIndicator.textContent = `Página ${state.currentPage + 1} de ${state.numPages}`;
  els.prevPage.disabled = state.currentPage === 0;
  els.nextPage.disabled = state.currentPage === state.numPages - 1;

  if (state.stamp && (state.stamp.allPages || state.stamp.page === state.currentPage)) {
    applyStampGeometry();
    show(els.stampPreview);
  } else {
    hide(els.stampPreview);
  }
}

els.prevPage.addEventListener('click', () => {
  if (state.currentPage > 0) { state.currentPage--; renderPage(); }
});
els.nextPage.addEventListener('click', () => {
  if (state.currentPage < state.numPages - 1) { state.currentPage++; renderPage(); }
});

function getCanvasDisplaySize() {
  const rect = els.canvas.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function applyStampGeometry() {
  const { xRatio, yRatio, widthRatio, heightRatio } = state.stamp;
  const { width, height } = getCanvasDisplaySize();
  els.stampPreview.style.left = `${xRatio * width}px`;
  els.stampPreview.style.top = `${yRatio * height}px`;
  els.stampPreview.style.width = `${widthRatio * width}px`;
  els.stampPreview.style.height = `${heightRatio * height}px`;
  updateStampFontSize();
}

// Caixa de referência (mesmas proporções usadas como padrão do carimbo no PDF final).
// A fonte escala pela menor das duas razões (largura/altura), garantindo que o texto
// nunca vaze da caixa, mesmo em formatos bem estreitos ou bem baixos.
const STAMP_REF_WIDTH = 260;
const STAMP_REF_HEIGHT = 78;

function updateStampFontSize() {
  const widthScale = els.stampPreview.offsetWidth / STAMP_REF_WIDTH;
  const heightScale = els.stampPreview.offsetHeight / STAMP_REF_HEIGHT;
  const scale = Math.min(widthScale, heightScale);
  const fontSize = Math.max(6, Math.min(15, 11 * scale));
  els.stampLabel.style.fontSize = `${fontSize}px`;
}

els.canvas.addEventListener('click', (evt) => {
  const rect = els.canvas.getBoundingClientRect();
  const xRatio = (evt.clientX - rect.left) / rect.width; // usa o tamanho exibido (getCanvasDisplaySize), igual em applyStampGeometry
  const yRatio = (evt.clientY - rect.top) / rect.height;

  const widthRatio = state.stamp ? state.stamp.widthRatio : DEFAULT_STAMP_WIDTH_RATIO;
  const heightRatio = state.stamp ? state.stamp.heightRatio : DEFAULT_STAMP_HEIGHT_RATIO;
  const allPages = state.stamp ? state.stamp.allPages : els.allPagesCheckbox.checked;

  state.stamp = { page: state.currentPage, xRatio, yRatio, widthRatio, heightRatio, allPages };
  applyStampGeometry();
  show(els.stampPreview);
  els.confirmSuccess.classList.add('hidden');
  els.confirmError.textContent = '';
});

els.allPagesCheckbox.addEventListener('change', () => {
  if (state.stamp) state.stamp.allPages = els.allPagesCheckbox.checked;
});

// Redimensionamento via alça nativa do navegador (resize: both no CSS) — atualiza os ratios e a fonte ao vivo.
// Importante: trocar de página/etapa esconde este elemento (display:none), o que zera
// offsetWidth/offsetHeight e dispara o observer — por isso ignoramos leituras com tamanho zero,
// que não representam um redimensionamento real feito pelo usuário.
const stampResizeObserver = new ResizeObserver(() => {
  if (!state.stamp) return;
  const w = els.stampPreview.offsetWidth;
  const h = els.stampPreview.offsetHeight;
  if (!w || !h) return;
  const canvasSize = getCanvasDisplaySize();
  state.stamp.widthRatio = w / canvasSize.width;
  state.stamp.heightRatio = h / canvasSize.height;
  updateStampFontSize();
});
stampResizeObserver.observe(els.stampPreview);

// --- Passo 4: confirmar ------------------------------------------------------

function renderSummary() {
  if (!state.certInfo || !state.stamp) {
    els.summaryBox.innerHTML = '';
    return;
  }
  els.summaryBox.innerHTML = `
    <div class="summary-row"><span>Documento</span><strong>${state.originalFilename}</strong></div>
    <div class="summary-row"><span>Responsável</span><strong>${state.certInfo.name || '—'}</strong></div>
    <div class="summary-row"><span>CPF/CNPJ</span><strong>${state.certInfo.doc || '—'}</strong></div>
    <div class="summary-row"><span>Aplicação</span><strong>${state.stamp.allPages ? 'Todas as páginas' : `Somente a página ${state.stamp.page + 1}`}</strong></div>
  `;
}

els.btnConfirm.addEventListener('click', async () => {
  els.confirmError.textContent = '';
  hide(els.confirmSuccess);

  if (!state.certInfo) {
    els.confirmError.textContent = 'Identifique o certificado A1 antes de confirmar (etapa 2).';
    return;
  }
  if (!state.stamp) {
    els.confirmError.textContent = 'Posicione o carimbo no documento antes de confirmar (etapa 3).';
    return;
  }

  try {
    const res = await fetch(`/api/documents/${state.documentId}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: state.stamp.page,
        xRatio: state.stamp.xRatio,
        yRatio: state.stamp.yRatio,
        widthRatio: state.stamp.widthRatio,
        heightRatio: state.stamp.heightRatio,
        allPages: state.stamp.allPages,
        originalFilename: state.originalFilename,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao aplicar carimbo.');

    els.confirmSuccess.innerHTML = `Documento validado com sucesso. <a href="/api/download/${data.signedId}" target="_blank">Baixar PDF carimbado</a> · <a href="/historico.html">Ver histórico</a>`;
    show(els.confirmSuccess);
  } catch (err) {
    els.confirmError.textContent = err.message;
  }
});

goToStep(1);
