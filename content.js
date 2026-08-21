const emit = (element, type) => element.dispatchEvent(new Event(type, { bubbles: true }));

const findUsername = () => document.querySelector('input[autocomplete="username"], input[type="email"], input[type="text"]');
const findPassword = () => document.querySelector('input[type="password"]');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "fill") return false;
  const currentOrigin = window.location.origin;
  if (currentOrigin !== message.origin) {
    sendResponse({ ok: false, error: "当前网站与条目 origin 不匹配" });
    return false;
  }
  const password = findPassword();
  const username = findUsername();
  if (!password) {
    sendResponse({ ok: false, error: "没有找到密码输入框" });
    return false;
  }
  if (username && message.username) { username.value = message.username; emit(username, "input"); emit(username, "change"); }
  password.value = message.password;
  emit(password, "input"); emit(password, "change");
  sendResponse({ ok: true });
  return false;
});
