export function createPrintExport({ win, doc, theme, prepareReadView, refreshDiagrams, getFile }) {
  let pendingPrintRestore = null;

  function finishExportPdf() {
    if (!pendingPrintRestore) return;
    const { prevTitle, prevMode } = pendingPrintRestore;
    pendingPrintRestore = null;
    win.document.title = prevTitle;
    if (prevMode) theme.set(prevMode, { persist: false });
  }
  win.addEventListener('afterprint', finishExportPdf);

  win.addEventListener('beforeprint', () => {
    for (const a of doc.querySelectorAll('a.wikilink[href]')) {
      a.dataset.printHref = a.getAttribute('href');
      if (a.dataset.file === getFile()) a.setAttribute('href', '#doc');
      else a.removeAttribute('href');
    }
  });
  win.addEventListener('afterprint', () => {
    for (const a of doc.querySelectorAll('a.wikilink[data-print-href]')) {
      a.setAttribute('href', a.dataset.printHref);
      delete a.dataset.printHref;
    }
  });

  async function exportPdf() {
    await prepareReadView();
    const wasDark = theme.isDark();
    const prevMode = wasDark ? theme.mode() : null;
    if (wasDark) {
      theme.set('light', { persist: false });
      await refreshDiagrams();
    }
    const prevTitle = win.document.title;
    const file = getFile();
    if (file) win.document.title = file.split('/').pop().replace(/\.(md|markdown)$/i, '');
    pendingPrintRestore = { prevTitle, prevMode };
    win.print();
    finishExportPdf();
  }

  return { exportPdf };
}
