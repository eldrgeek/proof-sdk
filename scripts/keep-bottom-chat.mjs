// Chat-main layout (Mike, 2026-10-21; CHAT_MAIN_POLICY) is on by default on wide desktop windows.
// The browser checks written before it test the chat at the centre's foot, which narrower windows
// and View › "Chat as the main space" (off) still use, so they pin that layout here.
// scripts/chat-main-check.mjs tests chat-main. ACCORD_CHAT_MAIN=1 runs every check in chat-main.
export function keepBottomChat(browser) {
  if (process.env.ACCORD_CHAT_MAIN === '1') return browser;
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript(() => { try { localStorage.setItem('proof:chat-main', '0'); } catch { /* optional */ } });
    return context;
  };
  return browser;
}
