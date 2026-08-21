export const queryActiveTab = (tabsApi) => new Promise((resolve) => {
  tabsApi.query({ active: true, lastFocusedWindow: true }, ([tab] = []) => resolve(tab || null));
});

export const originFromTab = (tab) => {
  try {
    const url = new URL(tab?.url || "");
    return url.protocol === "https:" ? url.origin : null;
  } catch { return null; }
};
