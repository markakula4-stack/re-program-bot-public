let app;
let launchClosed = false;
window.addEventListener("pagehide", () => { launchClosed = true; }, { once: true });
try {
  let timer;
  const modules = await Promise.race([
    Promise.all([import("./admin-client.mjs"), import("./admin-view.mjs"), import("./cabinet-client.mjs")]),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("module_load_timeout")), 15_000); }),
  ]).finally(() => clearTimeout(timer));
  if (launchClosed) throw new Error("launch_closed");
  const [{ AdminClient }, { mountAdminCabinet }, { mountThemeSelector, CabinetClientError }] = modules;
  const telegram = window.Telegram?.WebApp;
  const client = new AdminClient({ onExpired: () => app?.expire() });
  app = mountAdminCabinet({ document, client, telegram });
  const theme = mountThemeSelector({ document, telegram });
  telegram?.ready?.(); telegram?.expand?.();
  window.addEventListener("pagehide", () => { theme.destroy(); app.destroy(); }, { once: true });
  window.addEventListener("pageshow", event => { if (event.persisted) app.expire(); });
  if (!telegram?.initData) throw new CabinetClientError("telegram_required");
  await client.authenticate(telegram.initData);
  await app.start();
} catch (error) {
  if (app) app.showError(error);
  else {
    document.documentElement.setAttribute("data-launch-state", "error");
    document.getElementById("launch-screen")?.setAttribute("aria-hidden", "true");
    const screen = document.getElementById("admin-screen"); screen.setAttribute("aria-busy", "false");
    const card = document.createElement("section"); card.className = "card";
    const title = document.createElement("h2"); title.textContent = "Кабинет не открылся";
    const detail = document.createElement("p"); detail.className = "muted";
    detail.textContent = "Закройте кабинет и откройте его новой кнопкой в админском меню Telegram-бота.";
    card.append(title, detail); screen.replaceChildren(card); screen.focus({ preventScroll: true });
  }
}
