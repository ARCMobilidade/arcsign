const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const ROOT = __dirname;
const ORIGINALS_DIR = path.join(ROOT, 'storage', 'originals');
const SIGNED_DIR = path.join(ROOT, 'storage', 'signed');
const HISTORY_FILE = path.join(ROOT, 'data', 'history.json');
const CERTS_DIR = path.join(ROOT, 'certs');

for (const dir of [ORIGINALS_DIR, SIGNED_DIR, path.dirname(HISTORY_FILE)]) {
  fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]');

function readHistory() {
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}
function writeHistory(list) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2));
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build')));
// Sem cache nos arquivos do app (protótipo em evolução constante) — evita que o navegador
// continue usando uma versão antiga do app.js/style.css depois de uma atualização.
app.use(express.static(path.join(ROOT, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: ORIGINALS_DIR,
    filename: (req, file, cb) => {
      const id = crypto.randomUUID();
      req.generatedId = id;
      cb(null, `${id}.pdf`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Apenas arquivos PDF são aceitos.'));
    cb(null, true);
  },
});

// --- Solicita o certificado do cliente sob demanda, via renegociação TLS -----
// A conexão é aberta normalmente (sem pedir certificado). Só quando uma rota que
// precisa do certificado A1 é chamada, o servidor renegocia a conexão TLS pedindo
// o certificado — é nesse momento que o navegador exibe o seletor de certificados,
// nunca ao simplesmente abrir o site.
function requestClientCertificate(req) {
  return new Promise((resolve, reject) => {
    const socket = req.socket;
    const existing = socket.getPeerCertificate(true);
    if (existing && existing.subject) return resolve(existing);

    if (typeof socket.renegotiate !== 'function') {
      return reject(new Error('Renegociação TLS não suportada nesta conexão.'));
    }
    socket.renegotiate({ requestCert: true, rejectUnauthorized: false }, (err) => {
      if (err) return reject(err);
      resolve(socket.getPeerCertificate(true));
    });
  });
}

function parseCertInfo(cert) {
  if (!cert || !cert.subject) return null;

  const cn = cert.subject.CN || '';
  // Certificados e-CPF/e-CNPJ ICP-Brasil geralmente codificam o CPF/CNPJ no CN
  // no formato "NOME COMPLETO:CPFCNPJ".
  let name = cn;
  let doc = null;
  const parts = cn.split(':');
  if (parts.length === 2 && /^\d{11}(\d{3})?$/.test(parts[1].trim())) {
    name = parts[0].trim();
    doc = parts[1].trim();
  }

  return {
    name,
    doc,
    commonName: cn,
    organization: cert.subject.O || null,
    issuer: (cert.issuer && cert.issuer.CN) || null,
    serialNumber: cert.serialNumber || null,
    validFrom: cert.valid_from || null,
    validTo: cert.valid_to || null,
    fingerprint: cert.fingerprint256 || cert.fingerprint || null,
  };
}

app.get('/api/cert-info', async (req, res) => {
  try {
    const cert = await requestClientCertificate(req);
    const info = parseCertInfo(cert);
    if (!info) {
      return res.status(400).json({
        error: 'Nenhum certificado foi selecionado. Verifique se o certificado A1 está instalado no navegador/sistema e tente novamente.',
      });
    }
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: 'Não foi possível obter o certificado: ' + err.message });
  }
});

app.post('/api/documents', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const id = req.generatedId;
    const bytes = fs.readFileSync(req.file.path);
    const pdf = await PDFDocument.load(bytes);
    const pages = pdf.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { width, height };
    });
    res.json({ id, originalFilename: req.file.originalname, pages });
  } catch (err) {
    res.status(400).json({ error: 'Não foi possível processar o PDF: ' + err.message });
  }
});

app.get('/api/documents/:id/file', (req, res) => {
  const filePath = path.join(ORIGINALS_DIR, `${req.params.id}.pdf`);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile ? res.sendFile(filePath) : res.send(fs.readFileSync(filePath));
});

app.post('/api/documents/:id/sign', async (req, res) => {
  try {
    const { id } = req.params;
    const { page, xRatio, yRatio, widthRatio, heightRatio, allPages, originalFilename } = req.body;

    let cert;
    try {
      cert = await requestClientCertificate(req);
    } catch (err) {
      return res.status(400).json({ error: 'Não foi possível obter o certificado: ' + err.message });
    }
    const certInfo = parseCertInfo(cert);
    if (!certInfo) {
      return res.status(400).json({ error: 'Certificado A1 não identificado. Selecione o certificado quando o navegador solicitar.' });
    }

    const originalPath = path.join(ORIGINALS_DIR, `${id}.pdf`);
    if (!fs.existsSync(originalPath)) return res.status(404).json({ error: 'Documento não encontrado.' });

    const pdfDoc = await PDFDocument.load(fs.readFileSync(originalPath));
    const allPageObjs = pdfDoc.getPages();
    const pageIndex = Math.min(Math.max(0, Number(page) || 0), allPageObjs.length - 1);
    const targetPages = allPages ? allPageObjs : [allPageObjs[pageIndex]];

    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const signedAt = new Date();

    // Paleta oficial Arc Mobilidade: cinza escuro #1A1A1A, vermelho #B61000, amarelo #F3B500, verde #038940
    const arcDark = rgb(0x1a / 255, 0x1a / 255, 0x1a / 255);
    const arcRed = rgb(0xb6 / 255, 0x10 / 255, 0x00 / 255);
    const arcYellow = rgb(0xf3 / 255, 0xb5 / 255, 0x00 / 255);
    const arcGreen = rgb(0x03 / 255, 0x89 / 255, 0x40 / 255);

    const lines = [
      { text: 'JURÍDICO — VALIDADO', font, baseSize: 10.5, lineHeight: 16, color: arcGreen },
      { text: `Nome: ${certInfo.name || '—'}`, font: fontRegular, baseSize: 8.5, lineHeight: 12.5, color: arcDark },
      { text: `CPF/CNPJ: ${certInfo.doc || '—'}`, font: fontRegular, baseSize: 8.5, lineHeight: 12.5, color: arcDark },
      { text: `Data/Hora: ${signedAt.toLocaleString('pt-BR')}`, font: fontRegular, baseSize: 8.5, lineHeight: 12.5, color: arcDark },
      { text: `Certificado: ${certInfo.issuer || '—'}`, font: fontRegular, baseSize: 8.5, lineHeight: 12.5, color: arcDark },
    ];
    const basePaddingX = 10;
    const baseTopOffset = 20;
    const baseBarHeight = 4;
    // Altura total (a partir do topo da caixa) ocupada pelo texto nos tamanhos-base (escala 1),
    // usada para descobrir quanto é possível escalar tudo (fonte, respiros, barra) e ainda caber na caixa.
    const baseTextHeight = baseTopOffset + lines.reduce((sum, l) => sum + l.lineHeight, 0) - lines[lines.length - 1].lineHeight + lines[lines.length - 1].baseSize;
    // Maior largura de texto nos tamanhos-base, para descobrir o quanto é possível escalar sem vazar a largura.
    const baseTextWidth = Math.max(...lines.map((l) => l.font.widthOfTextAtSize(l.text, l.baseSize))) + basePaddingX * 2;

    for (const targetPage of targetPages) {
      const { width, height } = targetPage.getSize();

      // widthRatio/heightRatio vêm do tamanho do carimbo redimensionado na prévia (relativo à página).
      // Sem piso mínimo artificial — o carimbo final acompanha exatamente o tamanho ajustado na prévia.
      const stampWidth = (Number(widthRatio) || 0.28) * width;
      const stampHeight = (Number(heightRatio) || 0.12) * height;
      // A fonte é escalada para preencher a caixa real (medindo o texto), não uma proporção fixa —
      // usa a menor entre a escala que preenche a largura e a que preenche a altura disponíveis.
      const scale = Math.min(stampWidth / baseTextWidth, stampHeight / baseTextHeight);
      // xRatio/yRatio vêm do clique do usuário na prévia (origem no topo-esquerdo, 0..1).
      // PDF usa origem no canto inferior-esquerdo, por isso inverte o eixo Y.
      let x = Number(xRatio) * width;
      let y = height - Number(yRatio) * height;
      x = Math.min(Math.max(0, x), width - stampWidth);
      y = Math.min(Math.max(0, y - stampHeight), height - stampHeight);

      targetPage.drawRectangle({
        x, y, width: stampWidth, height: stampHeight,
        color: rgb(1, 1, 1),
        opacity: 0.92,
        borderColor: arcDark,
        borderWidth: 1.5,
      });
      // Barra tricolor no topo do carimbo, reforçando a identidade visual da marca
      const barHeight = baseBarHeight * scale;
      const barY = y + stampHeight - barHeight;
      const barSegment = stampWidth / 3;
      targetPage.drawRectangle({ x, y: barY, width: barSegment, height: barHeight, color: arcRed });
      targetPage.drawRectangle({ x: x + barSegment, y: barY, width: barSegment, height: barHeight, color: arcYellow });
      targetPage.drawRectangle({ x: x + 2 * barSegment, y: barY, width: barSegment, height: barHeight, color: arcGreen });

      let cursorY = y + stampHeight - baseTopOffset * scale;
      lines.forEach((line) => {
        targetPage.drawText(line.text, {
          x: x + basePaddingX * scale,
          y: cursorY,
          size: line.baseSize * scale,
          font: line.font,
          color: line.color,
        });
        cursorY -= line.lineHeight * scale;
      });
    }

    const signedBytes = await pdfDoc.save();
    const signedId = crypto.randomUUID();
    const signedFileName = `${signedId}.pdf`;
    fs.writeFileSync(path.join(SIGNED_DIR, signedFileName), signedBytes);

    const historyEntry = {
      signedId,
      documentId: id,
      originalFilename: originalFilename || `${id}.pdf`,
      signedFileName,
      signedAt: signedAt.toISOString(),
      page: pageIndex,
      allPages: !!allPages,
      position: { xRatio: Number(xRatio), yRatio: Number(yRatio) },
      signer: {
        name: certInfo.name,
        doc: certInfo.doc,
        commonName: certInfo.commonName,
        issuer: certInfo.issuer,
        serialNumber: certInfo.serialNumber,
        validFrom: certInfo.validFrom,
        validTo: certInfo.validTo,
        fingerprint: certInfo.fingerprint,
      },
    };
    const history = readHistory();
    history.unshift(historyEntry);
    writeHistory(history);

    res.json(historyEntry);
  } catch (err) {
    res.status(500).json({ error: 'Falha ao gerar carimbo: ' + err.message });
  }
});

app.get('/api/history', (req, res) => {
  res.json(readHistory());
});

app.get('/api/download/:signedId', (req, res) => {
  const entry = readHistory().find((h) => h.signedId === req.params.signedId);
  if (!entry) return res.status(404).json({ error: 'Documento não encontrado no histórico.' });
  const filePath = path.join(SIGNED_DIR, entry.signedFileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo assinado não encontrado.' });
  res.download(filePath, `validado-${entry.originalFilename}`);
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Erro inesperado.' });
});

const PORT = process.env.PORT || 8443;
const keyPath = path.join(CERTS_DIR, 'server-key.pem');
const certPath = path.join(CERTS_DIR, 'server-cert.pem');

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error('Certificado do servidor não encontrado. Rode "npm run gen-certs" primeiro.');
  process.exit(1);
}

const httpsOptions = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
  requestCert: false, // não pede certificado na conexão inicial — só sob demanda via renegociação
  // A renegociação TLS (usada para pedir o certificado sob demanda) não existe em TLS 1.3,
  // por isso a conexão é fixada em TLS 1.2, que ainda a suporta.
  maxVersion: 'TLSv1.2',
};

https.createServer(httpsOptions, app).listen(PORT, () => {
  console.log(`Servidor rodando em https://localhost:${PORT}`);
  console.log('Certificado autoassinado — aceite o aviso do navegador na primeira visita.');
});
