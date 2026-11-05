// copy buttons only. no trackers, no fonts, no analytics.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const value = btn.getAttribute("data-copy");
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    const old = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => { btn.textContent = old; }, 1400);
  } catch { btn.textContent = "select"; }
});
