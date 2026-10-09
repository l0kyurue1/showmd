import { parseRouteContext } from './route.js';

function setAriaDisabled(btn, disabled) {
  if (disabled) btn.setAttribute('aria-disabled', 'true');
  else btn.removeAttribute('aria-disabled');
}

export function createNavHistory({ history, location, backBtn, fwdBtn, win, save, applyRoute, currentUrl, report }) {
  let navIdx = 0;
  let navMax = 0;
  let restoringPopstate = false;
  let popstateTransition = Promise.resolve();

  function canGoBack() { return navIdx > 0; }

  function updateNavButtons() {
    backBtn.classList.toggle('disabled', navIdx <= 0);
    fwdBtn.classList.toggle('disabled', navIdx >= navMax);
    setAriaDisabled(backBtn, navIdx <= 0);
    setAriaDisabled(fwdBtn, navIdx >= navMax);
  }

  // `disabled` here is a CSS class, not the attribute — the click still fires at
  // the ends of the stack, so the guard has to be explicit
  function goBack() { if (canGoBack()) history.back(); }
  function goForward() { if (navIdx < navMax) history.forward(); }
  backBtn.addEventListener('click', goBack);
  fwdBtn.addEventListener('click', goForward);

  return {
    push(url) {
      navIdx += 1;
      navMax = navIdx;
      history.pushState({ idx: navIdx }, '', url);
      updateNavButtons();
    },
    replace(url, idx = navIdx) {
      history.replaceState({ idx }, '', url);
    },
    back: goBack,
    forward: goForward,
    listen() {
      updateNavButtons();
      win.addEventListener('popstate', (e) => {
        const targetIdx = (e.state && typeof e.state.idx === 'number') ? e.state.idx : 0;
        if (restoringPopstate) {
          restoringPopstate = false;
          navIdx = targetIdx;
          navMax = Math.max(navMax, navIdx);
          updateNavButtons();
          return;
        }
        const sourceIdx = navIdx;
        const sourceUrl = currentUrl();
        const targetRoute = parseRouteContext(location.href);
        popstateTransition = popstateTransition.then(async () => {
          if (save.isDirty()) {
            await save.flush();
            if (save.isDirty()) {
              const delta = sourceIdx - targetIdx;
              if (delta) {
                restoringPopstate = true;
                history.go(delta);
              } else {
                history.replaceState({ idx: sourceIdx }, '', sourceUrl);
              }
              return;
            }
          }
          navIdx = targetIdx;
          navMax = Math.max(navMax, navIdx);
          updateNavButtons();
          await applyRoute(targetRoute);
        }).catch((err) => {
          console.error('showmd: could not apply route', err);
          report('error', 'Navigation failed', 'could not open that page');
        });
      });
    },
  };
}
