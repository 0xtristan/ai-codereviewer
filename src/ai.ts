import * as core from "@actions/core";
import { File as DiffFile } from "parse-diff";
import { ReviewComment } from "./types";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const INFERENCE_API_KEY = core.getInput("INFERENCE_API_KEY");
const MODEL = core.getInput("MODEL");
// TODO: Conditional import for openai and anthropic
const openai = new OpenAI({ apiKey: INFERENCE_API_KEY });
const customInstructions = core.getInput("custom_instructions");

export function createReviewPrompt(
  prContext: { title: string; description: string; changedFiles: string[] },
  repoContext: { readmeContent: string; packageJsonContent: string },
  file: DiffFile,
  content: string
): string {
  const diffReviews = file.chunks
    .map(
      (chunk, index) => `Diff ${index + 1}:
${chunk.content}
${chunk.changes
  .map((change) => {
    // @ts-expect-error - ln and ln2 exist where needed
    const lineNumber = change.ln || change.ln2;
    return `${lineNumber} ${change.content}`;
  })
  .join("\n")}
`
    )
    .join("\n");

  console.debug(diffReviews);
  return `Review the following code diffs in the file "${file.to}":

PR Title: ${prContext.title}
PR Description: ${prContext.description}

Git diffs to review:
---
${diffReviews}
---

Full file content:
---
${content}
---

Provide a code review in JSON format:
{
  "comments": [
    {
      "diffIndex": <diff_index>,
      "lineNumber": <line_number>,
      "comment": "<review comment>"
    }
  ]
}

Specifically your instructions are:
- Focus on code quality, best practices, and potential issues.
- Only provide comments on code that has changed.
- Do not suggest adding comments to the code.
- Do not comment on style or formatting.
- Do not give positive comments or compliments, only provide feedback when there is something to improve.
- Use Github markdown format for the comments.
${customInstructions
  .split(",")
  .map((instruction) => `- ${instruction.trim()}`)
  .join("\n")}`;
}

export async function callModel(prompt: string): Promise<string> {
  if (MODEL.startsWith("claude-3")) {
    const anthropicClient = new Anthropic({
      apiKey: INFERENCE_API_KEY,
    });
    const response = await anthropicClient.messages.create({
      model: MODEL,
      max_tokens: 700,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].type === "text"
      ? response.content[0].text.trim()
      : "";
  } else {
    const queryConfig = {
      model: MODEL,
      temperature: 0.2,
      max_tokens: 700,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [{ role: "user", content: prompt }],
      ...(MODEL.startsWith("gpt-4") || MODEL.startsWith("gpt-3.5-turbo")
        ? { response_format: { type: "json_object" } }
        : {}),
    });

    return response.choices[0].message.content?.trim() || "";
  }
}

export function parseAIResponse(
  aiResponse: string,
  filePath: string | undefined
): ReviewComment[] {
  try {
    const parsedResponse = JSON.parse(aiResponse);
    return parsedResponse.comments.map(
      (comment: { lineNumber: number; comment: string }) => ({
        body: comment.comment,
        path: filePath || "",
        line: comment.lineNumber,
      })
    );
  } catch (error) {
    console.error("Failed to parse AI response:", error);
    return [];
  }
}
