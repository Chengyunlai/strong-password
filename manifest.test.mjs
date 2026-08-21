import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { originFromTab, queryActiveTab } from "./tab-context.js";

test("persistent side panel can read the active tab URL", async () => {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.side_panel, "the regression applies to the persistent side panel");
  assert.ok(
    manifest.permissions.includes("tabs"),
    "a persistent side panel needs tabs permission to receive the active tab URL after activeTab expires",
  );
});

test("queries only the active tab in the last focused window", async () => {
  let receivedQuery;
  const tabsApi = {
    query(query, callback) {
      receivedQuery = query;
      callback([{ id: 42, url: "https://example.com/login" }]);
    },
  };

  const tab = await queryActiveTab(tabsApi);
  assert.deepEqual(receivedQuery, { active: true, lastFocusedWindow: true });
  assert.equal(tab.id, 42);
  assert.equal(originFromTab(tab), "https://example.com");
});

test("does not identify missing or non-HTTPS tab URLs", () => {
  assert.equal(originFromTab({ id: 1 }), null);
  assert.equal(originFromTab({ url: "http://example.com/login" }), null);
  assert.equal(originFromTab({ url: "edge://extensions" }), null);
});
