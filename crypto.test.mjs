import test from "node:test";
import assert from "node:assert/strict";
import { changeMasterPassword, createVault, generatePassword, open, saveVault, unlockVault } from "./crypto.js";

test("generates a strong password with all required character classes", () => {
  const password = generatePassword({ length: 24, symbols: true });
  assert.equal(password.length, 24);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[a-z]/);
  assert.match(password, /[0-9]/);
  assert.match(password, /[^A-Za-z0-9]/);
});

test("vault can be unlocked with master and recovery secrets", async () => {
  const created = await createVault("a sufficiently long master password");
  const master = await unlockVault(created.record, "a sufficiently long master password");
  assert.deepEqual(master.vault, { entries: [] });
  const recovery = await unlockVault(created.record, created.recoveryKey, "recovery");
  assert.deepEqual(recovery.vault, { entries: [] });
});

test("wrong secret cannot open the vault and recovery can rotate master", async () => {
  const created = await createVault("a sufficiently long master password");
  await assert.rejects(() => unlockVault(created.record, "wrong password"));
  const rotated = await changeMasterPassword(created.record, created.recoveryKey, "a new sufficiently long password", "recovery");
  await assert.rejects(() => unlockVault(rotated.record, created.recoveryKey, "recovery"));
  await unlockVault(rotated.record, rotated.recoveryKey, "recovery");
  const unlocked = await unlockVault(rotated.record, "a new sufficiently long password");
  const saved = await saveVault(rotated.record, unlocked.vaultKey, { entries: [{ origin: "https://example.com", password: "secret" }] });
  const reopened = await unlockVault(saved, "a new sufficiently long password");
  assert.equal(reopened.vault.entries[0].origin, "https://example.com");
});

test("tampering with ciphertext is rejected", async () => {
  const created = await createVault("a sufficiently long master password");
  const tampered = structuredClone(created.record);
  tampered.data.ciphertext = `${tampered.data.ciphertext.slice(0, -1)}A`;
  await assert.rejects(() => unlockVault(tampered, "a sufficiently long master password"));
});
