// Run before styles and body: a saved dark choice must also colour the loader.
// This key contains only one public appearance word, never account/session data.
(() => {
  const modes = ["light", "dark", "system"];
  let mode = "light";
  try {
    const saved = window.localStorage?.getItem("re-program.cabinet.theme.v1");
    if (modes.includes(saved)) mode = saved;
  } catch {}
  let colour = mode;
  if (mode === "system") {
    try { colour = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light"; }
    catch { colour = "light"; }
  }
  document.documentElement.setAttribute("data-theme-mode", mode);
  document.documentElement.setAttribute("data-color-theme", colour);
})();
