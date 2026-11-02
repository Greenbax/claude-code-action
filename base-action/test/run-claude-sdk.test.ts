import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const directory = await mkdtemp(join(tmpdir(), "claude-sdk-results-"));
const originalTemp = process.env.RUNNER_TEMP;
process.env.RUNNER_TEMP = directory;
let messages: Record<string, unknown>[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: async function* () {
    for (const message of messages) yield message;
  },
}));

const { runClaudeWithSdk } = await import("../src/run-claude-sdk");
const prompt = join(directory, "prompt.txt");
await writeFile(prompt, "Review the pull request.");
const verdict = { summary: "No issues found.", page_performance_findings: [] };
const success = { type: "result", subtype: "success", session_id: "review" };

beforeEach(() => {
  messages = [];
  process.exitCode = 0;
});

afterAll(async () => {
  mock.restore();
  process.exitCode = 0;
  if (originalTemp === undefined) delete process.env.RUNNER_TEMP;
  else process.env.RUNNER_TEMP = originalTemp;
  await rm(directory, { recursive: true, force: true });
});

test.each([true, false])(
  "preserves structured output before a trailing result (schema=%s)",
  async (hasJsonSchema) => {
    messages = [
      { ...success, structured_output: verdict },
      { ...success, result: "Follow-up complete." },
    ];
    const result = await runClaudeWithSdk(prompt, {
      sdkOptions: {},
      showFullOutput: false,
      hasJsonSchema,
    });
    expect(result.conclusion).toBe("success");
    if (hasJsonSchema)
      expect(result.structuredOutput).toBe(JSON.stringify(verdict));
    else expect(result.structuredOutput).toBeUndefined();
  },
);

test.each([
  [{ ...success }],
  [
    { ...success, structured_output: verdict },
    { ...success, session_id: "different-session" },
  ],
  [
    { ...success, structured_output: verdict },
    { ...success, subtype: "error_max_structured_output_retries" },
  ],
])(
  "does not turn missing output or a failed review into success: %j",
  async (...stream) => {
    messages = stream;
    await expect(
      runClaudeWithSdk(prompt, {
        sdkOptions: {},
        showFullOutput: false,
        hasJsonSchema: true,
      }),
    ).rejects.toThrow();
  },
);

test("uses the latest structured result in the same session", async () => {
  const latest = { ...verdict, summary: "Advisory finding." };
  messages = [
    { ...success, structured_output: verdict },
    { ...success, structured_output: latest },
    { ...success },
  ];
  const result = await runClaudeWithSdk(prompt, {
    sdkOptions: {},
    showFullOutput: false,
    hasJsonSchema: true,
  });
  expect(result.structuredOutput).toBe(JSON.stringify(latest));
});
