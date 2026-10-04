"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const api = require(path.join(projectRoot, "api", "analyze.js"));
const { validateInput, sanitizeAnalysis, sanitizeChallenge, extractJson, isSafe } = api._test;

function validData() {
  return {
    decision: "Should I accept this internship?",
    options: ["Accept", "Decline"],
    known: "It pays well and gives industry experience.",
    leaning: "I am leaning toward accepting because I want experience."
  };
}

function mockResponse() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    body: null,
    setHeader(name, value) { headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; }
  };
}

test("rejects missing or malformed input", () => {
  assert.equal(validateInput(null), null);
  assert.equal(validateInput({}), null);
  assert.equal(validateInput({ mode: "analyze", data: {} }), null);
  assert.equal(validateInput({ mode: "analyze", data: { ...validData(), options: ["Only one"] } }), null);
});

test("accepts valid analysis input and normalizes mode", () => {
  const result = validateInput({ mode: "anything", data: validData() });
  assert.equal(result.mode, "analyze");
  assert.equal(result.data.options.length, 2);
  assert.equal(result.data.decision, "Should I accept this internship?");
});

test("limits options and priorities", () => {
  const data = validData();
  data.options = Array.from({ length: 12 }, (_, i) => `Option ${i}`);
  data.priorities = Array.from({ length: 20 }, (_, i) => `Priority ${i}`);
  const result = validateInput({ mode: "analyze", data });
  assert.equal(result.data.options.length, 8);
  assert.equal(result.data.priorities.length, 12);
});

test("strips control characters from user input", () => {
  const data = validData();
  data.decision = "Hello\u0000\u0001 world";
  const result = validateInput({ mode: "analyze", data });
  assert.equal(result.data.decision, "Hello world");
});

test("blocks recommendation/verdict language", () => {
  assert.equal(isSafe("You should accept this option."), false);
  assert.equal(isSafe("I recommend you choose option A."), false);
  assert.equal(isSafe("The best option is A."), false);
  assert.equal(isSafe("One factor worth examining is schedule flexibility."), true);
});

test("rejects unusable analysis output", () => {
  assert.equal(sanitizeAnalysis(null), null);
  assert.equal(sanitizeAnalysis({ summary: "Too little", blindSpots: [], assumptions: [], questions: [] }), null);
});

test("accepts a structurally useful analysis result", () => {
  const result = sanitizeAnalysis({
    summary: "Your reasoning emphasizes experience and compensation while leaving schedule details less examined.",
    facts: ["The internship pays ₹25,000."],
    unknowns: ["Exact academic workload"],
    blindSpots: [
      { category: "Academics", title: "College schedule", explanation: "Your notes mention college but do not establish the actual overlap.", whyItMatters: "A conflict could affect feasibility.", question: "What is the expected weekly overlap?" },
      { category: "Mentorship", title: "Mentorship quality", explanation: "The role is described, but mentorship is not specified.", whyItMatters: "Learning outcomes may depend on support.", question: "Who would review your work?" }
    ],
    assumptions: [{ title: "Experience will be valuable", explanation: "You connect the role with career growth.", question: "What evidence supports that learning outcome?" }],
    conflicts: [],
    missingInformation: [{ item: "Mentor availability", whyItMatters: "It affects learning support." }],
    questions: ["What are the exact hours?", "How will exams be handled?", "What does success look like?"]
  });
  assert.ok(result);
  assert.equal(result.blindSpots.length, 2);
  assert.equal(result.assumptions.length, 1);
  assert.equal(result.questions.length, 3);
});

test("challenge output requires at least three useful items", () => {
  assert.equal(sanitizeChallenge({ weakAssumptions: [], missingEvidence: [], alternativePerspectives: [] }), null);
  const result = sanitizeChallenge({
    weakAssumptions: [{ title: "Assumption", body: "Test it", quote: "experience" }],
    missingEvidence: [{ title: "Evidence", body: "Find evidence", quote: "" }],
    alternativePerspectives: [{ title: "Perspective", body: "Consider another interpretation", quote: "" }],
    tradeoffs: [], scenarios: []
  });
  assert.ok(result);
});

test("extracts JSON from plain and fenced model responses", () => {
  assert.deepEqual(extractJson('{"ok":true}'), { ok: true });
  assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(extractJson('prefix {"ok":true} suffix'), { ok: true });
  assert.equal(extractJson("not json"), null);
});

test("API rejects non-POST requests", async () => {
  const oldAnthropic = process.env.ANTHROPIC_API_KEY;
  const oldOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const res = mockResponse();
  await api({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, "method_not_allowed");
  if (oldAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = oldAnthropic;
  if (oldOpenAI !== undefined) process.env.OPENAI_API_KEY = oldOpenAI;
});

test("API reports missing provider configuration without leaking secrets", async () => {
  const oldAnthropic = process.env.ANTHROPIC_API_KEY;
  const oldOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const res = mockResponse();
  await api({ method: "POST", headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: "not_configured" });
  if (oldAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = oldAnthropic;
  if (oldOpenAI !== undefined) process.env.OPENAI_API_KEY = oldOpenAI;
});

test("frontend does not contain provider secret assignments", () => {
  const js = fs.readFileSync(path.join(projectRoot, "script.js"), "utf8");
  assert.doesNotMatch(js, /(?:sk-[A-Za-z0-9_-]{20,}|ANTHROPIC_API_KEY\s*=|OPENAI_API_KEY\s*=)/);
});

test("deployment includes required security and runtime files", () => {
  for (const file of ["index.html", "script.js", "style.css", "intro.mp4", "vercel.json", "api/analyze.js"]) {
    assert.equal(fs.existsSync(path.join(projectRoot, file)), true, `${file} should exist`);
  }
  const html = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(projectRoot, "script.js"), "utf8");
  assert.match(js, /\/api\/analyze/);
  assert.match(html, /intro\.mp4/);
  const vercel = fs.readFileSync(path.join(projectRoot, "vercel.json"), "utf8");
  assert.match(vercel, /Content-Security-Policy/);
});
