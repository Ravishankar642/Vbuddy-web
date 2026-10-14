import { applyUpdate, dismissInstallHint, promptInstall, usePwa } from "../lib/pwa";

/** Top-of-page strip when a new version is ready. */
export function UpdateBanner() {
  const { updateReady } = usePwa();
  if (!updateReady) return null;
  return (
    <div className="banner banner--action" role="status">
      <span>A new version of VBuddy is ready.</span>
      <button type="button" className="btn btn--primary" onClick={applyUpdate}>
        Reload
      </button>
    </div>
  );
}

/** Install help and offline status, matched to what this browser can actually do. */
export function AppCard() {
  const p = usePwa();
  if (p.standalone) return null;

  let body: React.ReactNode = null;
  let action: React.ReactNode = null;

  if (p.canInstall) {
    body = "Install VBuddy to open it from your home screen, full screen, like an app.";
    action = (
      <button type="button" className="btn btn--primary" onClick={() => void promptInstall()}>
        Install
      </button>
    );
  } else if (p.ios) {
    body = (
      <>
        To install on iPhone or iPad: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>.
        {p.swReason === "insecure" && " Offline mode needs an https address."}
      </>
    );
  } else if (p.swReason === "insecure") {
    body = (
      <>
        This address is plain <b>http</b>, so the browser won't allow offline mode or one-tap install. VBuddy still works. The cloud relay (a later part) will give you
        an https address. Until then, your browser menu's <b>Add to Home screen</b> makes a shortcut.
      </>
    );
  } else if (p.offlineReady) {
    body = "Saved on this device: VBuddy opens even when the bridge or your network is off. Use your browser menu to add it to your home screen.";
  } else {
    return null;
  }

  if (p.hintDismissed && !p.canInstall) return null;

  return (
    <section className="card appcard" aria-label="App">
      <p className="appcard__text">{body}</p>
      <div className="appcard__actions">
        {action}
        {!p.canInstall && (
          <button type="button" className="btn btn--ghost" onClick={dismissInstallHint}>
            Hide
          </button>
        )}
      </div>
    </section>
  );
}
