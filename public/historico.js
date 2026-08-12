async function loadHistory() {
  const res = await fetch('/api/history');
  const history = await res.json();
  const body = document.getElementById('historyBody');
  const empty = document.getElementById('emptyState');
  body.innerHTML = '';

  if (!history.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const entry of history) {
    const tr = document.createElement('tr');
    const signedDate = new Date(entry.signedAt).toLocaleString('pt-BR');
    tr.innerHTML = `
      <td>${entry.originalFilename}</td>
      <td>${signedDate}</td>
      <td>${entry.signer.name || '—'}</td>
      <td>${entry.signer.doc || '—'}</td>
      <td>${entry.signer.issuer || '—'}</td>
      <td><a href="/api/download/${entry.signedId}" target="_blank">Baixar</a></td>
    `;
    body.appendChild(tr);
  }
}

loadHistory();
