# Client modules take injected dependencies, not a shared store

`client/app.js` had grown to 1846 lines and 19 module-level `let`s, and every feature landed there. We split theme, print export, server connection, info panel, navigation history, and sidebar tree into factory modules wired by app.js, which keeps only the route/Space composition root and the editor session (7 `let`s). We chose injected dependencies over a global store because the existing `save-flow.js`, `view-state.js`, and `home-view.js` already used them, and each module stays testable without booting the App.

## Rules

- Shape: `export function createX({ ...deps })` returning a plain object. No module-level mutable state and no DOM or global reads at import time: the jsdom test harness re-imports only app.js per test, so module-level state would leak between tests.
- A factory never calls an injected getter or callback during construction. Collaborators are built in sequence, so a dependency may not exist yet (the document view is created before the info panel and reaches it through lambdas).
- Pass a value when app.js starts the call and the module uses it at once (`navHistory.push(url)`).
- Inject a getter when the module starts the action itself, on popstate, a server event, keydown, or a timer (`currentUrl`, `getEditor`).
- Pass a stable collaborator (`save`, `viewState`) as the object, not as a wrapper callback.
- Keep the caller's sync/async shape exactly. Wrapping a synchronous dependency in `async` adds a microtask and changed popstate behaviour during this refactor.
- Never pass `currentRoute` or app state as a mutable object.

## Stop rule

Count B, the injected getters and callbacks that close over app.js state (DOM refs, constants, and stable collaborators do not count). Do not extract a candidate when B > 5, when its own test would need to boot app.js, or when it removes no `let` and fewer than 40 lines. For calibration, save-flow has 3 and home-view 10. Server-event routing stayed in app.js under this rule (7 or more wires). The editor session stayed for a different reason: its edit-to-read path has no unit seam yet.

## Considered options

A global store was rejected: it would turn every module into a reader of all state, which is the coupling this split removes, and no existing client code uses one.
