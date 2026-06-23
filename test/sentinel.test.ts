import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAction, reviewAction } from "../src/security/sentinel.js";

// --- critical: must block (money / irreversible / prod / destructive git) ---

test("money movement is critical", () => {
  assert.equal(classifyAction("stripe_create_refund", { amount: 5000 }).level, "critical");
  assert.equal(classifyAction("wallet_transfer", { to: "0xabc", usdc: 100 }).level, "critical");
  assert.equal(classifyAction("send_payment", { amount: 20 }).level, "critical");
  assert.equal(classifyAction("card_withdraw", {}).level, "critical");
});

test("irreversible destruction is critical", () => {
  assert.equal(classifyAction("filesystem_delete", { path: "/x" }).level, "critical");
  assert.equal(
    classifyAction("postgres_query", { sql: "DELETE FROM users WHERE 1=1" }).level,
    "critical",
  );
  assert.equal(
    classifyAction("postgres_query", { sql: "DROP TABLE accounts" }).level,
    "critical",
  );
});

test("destructive git + prod deploy is critical", () => {
  assert.equal(classifyAction("git_push", { args: "--force origin main" }).level, "critical");
  assert.equal(classifyAction("deploy", { target: "production" }).level, "critical");
});

// --- high: flagged (mutations / comms / secrets) ---

test("state mutations and comms are high", () => {
  assert.equal(classifyAction("github_createIssue", { title: "bug" }).level, "high");
  assert.equal(classifyAction("linear_updateIssue", { id: "1" }).level, "high");
  assert.equal(classifyAction("gmail_send", { to: "a@b.com" }).level, "high");
});

test("secret handling is at least high", () => {
  const a = classifyAction("read_env", { path: ".env" });
  assert.ok(a.level === "high" || a.level === "critical");
});

// --- medium / low: reads ---

test("plain reads are low", () => {
  assert.equal(classifyAction("github_get_file_contents", { path: "README.md" }).level, "low");
  assert.equal(classifyAction("linear_getIssues", {}).level, "low");
});

test("reads over sensitive data are medium", () => {
  assert.equal(
    classifyAction("db_query", { sql: "select balance, card number from x" }).level,
    "medium",
  );
});

// --- verdict mapping (block critical, flag the rest) ---

test("verdict blocks critical, flags high/medium, allows low", async () => {
  assert.equal((await reviewAction("wallet_transfer", { usdc: 1 })).verdict, "block");
  assert.equal((await reviewAction("github_createIssue", { title: "x" })).verdict, "flag");
  assert.equal((await reviewAction("github_get_file_contents", { path: "a" })).verdict, "allow");
});

test("camelCase and snake_case verbs are both detected", () => {
  assert.equal(classifyAction("createRefund", { amount: 1 }).level, "critical");
  assert.equal(classifyAction("create_refund", { amount: 1 }).level, "critical");
});
