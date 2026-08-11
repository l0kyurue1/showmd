// With no dialog padding, a click on the dialog itself is a backdrop click.
function confirmDialogEl(id) {
  let dialog = document.getElementById(id);
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = id;
  dialog.className = 'confirm-dialog';
  dialog.innerHTML = `<form method="dialog" class="confirm-dialog-card">
    <div class="confirm-dialog-title"></div>
    <p class="confirm-dialog-body"></p>
    <div class="confirm-dialog-actions">
      <button type="submit" value="cancel" autofocus>Cancel</button>
      <button type="submit" value="confirm" class="confirm-dialog-danger"></button>
    </div>
  </form>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('cancel'); });
  return dialog;
}

// content is set via textContent, not baked into the cached element's innerHTML:
// callers pass live strings (a folder name, a path) that must never be parsed as markup.
export async function confirmDialog(id, { title, body, confirmLabel }) {
  const dialog = confirmDialogEl(id);
  dialog.querySelector('.confirm-dialog-title').textContent = title;
  dialog.querySelector('.confirm-dialog-body').textContent = body;
  dialog.querySelector('.confirm-dialog-danger').textContent = confirmLabel;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
  });
}
