let app;
let launchClosed = false;
window.addEventListener("pagehide", () => { launchClosed = true; }, { once: true });
try {
  // Static dependency failures happen before a module's own catch can run.
  // Load the local modules here so an unavailable asset has a visible exit.
  let loadTimer;
  const modules = await Promise.race([
    Promise.all([import("./cabinet-client.mjs"), import("./cabinet-view.mjs"), import("./telegram-native.mjs")]),
    new Promise((_, reject) => {
      loadTimer = setTimeout(() => reject(new Error("module_load_timeout")), 15_000);
    }),
  ]).finally(() => clearTimeout(loadTimer));
  if (launchClosed) throw new Error("launch_closed");
  const [{ MiniAppClient, CabinetClientError, mountThemeSelector }, { mountCabinet }, { createTelegramNativeAdapter }] = modules;
  const telegram = window.Telegram?.WebApp;
  const client = new MiniAppClient({ mutationsEnabled: false, offerActionsEnabled: false,
    onExpired: () => app?.expire() });
  const native = createTelegramNativeAdapter({ telegram, document, clipboard: window.navigator?.clipboard });
  app = mountCabinet({ document, client, telegram, native });
  const theme = mountThemeSelector({ document, telegram });
  telegram?.ready?.();
  telegram?.expand?.();
  const close = () => { theme.destroy(); app.destroy(); };
  window.addEventListener("pagehide", close, { once: true });
  window.addEventListener("pageshow", event => {
    if (event.persisted) app.showError(new CabinetClientError("session_expired"));
  });
  if (!telegram?.initData) throw new CabinetClientError("telegram_required");
  // Only raw signed initData is sent. initDataUnsafe is never an identity source.
  await client.authenticate(telegram.initData);
  await app.start();
} catch (error) {
  if (app) app.showError(error);
  else {
    document.documentElement.setAttribute("data-launch-state", "error");
    document.getElementById("launch-screen")?.setAttribute("aria-hidden", "true");
    const screen = document.getElementById("screen");
    screen.setAttribute("aria-busy", "false");
    const card = document.createElement("section"); card.className = "card";
    const title = document.createElement("h2"); title.textContent = "Кабинет не открылся";
    const detail = document.createElement("p"); detail.className = "muted";
    detail.textContent = "Не удалось загрузить кабинет. Вернитесь в бот и откройте его снова.";
    card.append(title, detail);
    for (const [text, href] of [["Вернуться в бот", "https://t.me/RE_Program_Bot"],
      ["Открыть поддержку", "https://t.me/RE_Program_Support_Bot"]]) {
      const link = document.createElement("a"); link.className = "button";
      link.textContent = text; link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer";
      card.append(link);
    }
    screen.replaceChildren(card); screen.focus({ preventScroll: true });
  }
}
