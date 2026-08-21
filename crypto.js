const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

export const randomBytes = (size) => crypto.getRandomValues(new Uint8Array(size));
export const encode = (value) => toBase64(encoder.encode(value));
export const decode = (value) => decoder.decode(fromBase64(value));
export const randomToken = (size = 32) => {
  const bytes = randomBytes(size);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const deriveKey = async (secret, salt) => crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" },
  await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]),
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"],
);

export const seal = async (value, key) => {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
};

export const open = async (sealed, key) => {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv) },
    key,
    fromBase64(sealed.ciphertext),
  );
  return decoder.decode(plaintext);
};

export const createVault = async (masterPassword) => {
  const salt = randomBytes(16);
  const recoveryKey = randomToken(32);
  const vaultKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawVaultKey = new Uint8Array(await crypto.subtle.exportKey("raw", vaultKey));
  const masterKey = await deriveKey(masterPassword, salt);
  const recoveryDerivedKey = await deriveKey(recoveryKey, salt);
  return {
    recoveryKey,
    record: {
      version: 1,
      salt: toBase64(salt),
      masterWrap: await seal(toBase64(rawVaultKey), masterKey),
      recoveryWrap: await seal(toBase64(rawVaultKey), recoveryDerivedKey),
      data: await seal(JSON.stringify({ entries: [] }), vaultKey),
    },
  };
};

// The vault key is kept extractable only in the unlocked extension context so a
// recovery flow can re-wrap it under a new master password. During an unlocked
// browser session the raw key is also held in chrome.storage.session so the
// side panel can reopen without asking for the master password again.
export const importVaultKey = async (raw) => crypto.subtle.importKey("raw", fromBase64(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);

export const unlockVault = async (record, secret, mode = "master") => {
  const salt = fromBase64(record.salt);
  const key = await deriveKey(secret, salt);
  const wrapped = mode === "recovery" ? record.recoveryWrap : record.masterWrap;
  const raw = await open(wrapped, key);
  const vaultKey = await importVaultKey(raw);
  return { vaultKey, vault: JSON.parse(await open(record.data, vaultKey)) };
};

export const changeMasterPassword = async (record, oldSecret, newSecret, mode = "master") => {
  const unlocked = await unlockVault(record, oldSecret, mode);
  const salt = fromBase64(record.salt);
  const nextKey = await deriveKey(newSecret, salt);
  const recoveryKey = randomToken(32);
  const recoveryDerivedKey = await deriveKey(recoveryKey, salt);
  return {
    recoveryKey,
    record: {
      ...record,
      masterWrap: await seal(await exportVaultKey(unlocked.vaultKey), nextKey),
      recoveryWrap: await seal(await exportVaultKey(unlocked.vaultKey), recoveryDerivedKey),
    },
  };
};

export const exportVaultKey = async (key) => toBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));

export const saveVault = async (record, vaultKey, vault) => ({ ...record, data: await seal(JSON.stringify(vault), vaultKey) });

export const generatePassword = ({ length = 24, symbols = true } = {}) => {
  const groups = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789"];
  if (symbols) groups.push("!@#$%^&*()-_=+[]{};:,.?/" );
  const chars = groups.join("");
  const pick = (alphabet) => {
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    let value;
    do { value = randomBytes(1)[0]; } while (value >= limit);
    return alphabet[value % alphabet.length];
  };
  const safeLength = Math.max(1, Math.floor(length));
  const output = groups.slice(0, safeLength).map(pick);
  while (output.length < safeLength) output.push(pick(chars));
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = randomBytes(1)[0] % (i + 1);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output.join("");
};
