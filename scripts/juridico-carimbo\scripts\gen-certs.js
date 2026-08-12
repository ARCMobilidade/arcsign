// Gera um certificado autoassinado para o servidor HTTPS local do protótipo.
// Necessário porque mTLS (solicitar certificado do cliente) exige HTTPS.
const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const certsDir = path.join(__dirname, '..', 'certs');
if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

const attrs = [
  { name: 'commonName', value: 'localhost' },
  { name: 'organizationName', value: 'Juridico Carimbo App - Dev' },
];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
  { name: 'basicConstraints', cA: false },
  { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
  { name: 'extKeyUsage', serverAuth: true },
  {
    name: 'subjectAltName',
    altNames: [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
    ],
  },
]);

cert.sign(keys.privateKey, forge.md.sha256.create());

fs.writeFileSync(path.join(certsDir, 'server-key.pem'), forge.pki.privateKeyToPem(keys.privateKey));
fs.writeFileSync(path.join(certsDir, 'server-cert.pem'), forge.pki.certificateToPem(cert));

console.log('Certificado autoassinado do servidor gerado em /certs.');
console.log('O browser vai avisar que a conexao nao e confiavel na primeira vez (esperado em dev) — aceite para continuar.');
