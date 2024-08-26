import * as core from "@actions/core";
import { File as DiffFile } from "parse-diff";
import minimatch from "minimatch";
import { callModel, createReviewPrompt, parseAIResponse } from "./ai";
import { ReviewComment } from "./types";
import {
  getFileContent,
  getPRContext,
  getRepoContext,
  submitReviewComments,
} from "./git";

async function prepareReviewContext(
  prContext: Awaited<ReturnType<typeof getPRContext>>
) {
  const { pr, files, parsedDiff, owner, repo } = prContext;

  const repoContext = await getRepoContext(owner, repo);
  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());
  const filesWithContent = await Promise.all(
    parsedDiff.map(async (file: DiffFile) => {
      const filePath = file.to;
      if (
        !filePath ||
        file.to === "/dev/null" ||
        excludePatterns.some((pattern) => minimatch(filePath, pattern))
      ) {
        return null;
      }

      const content = await getFileContent(owner, repo, filePath, pr.head.sha);
      return content ? { file, content } : null;
    })
  ).then((results) =>
    results.filter(
      (result): result is NonNullable<typeof result> => result !== null
    )
  );

  return {
    prContext: {
      title: pr.title,
      description: pr.body || "",
      changedFiles: files.map((f) => f.filename),
    },
    repoContext,
    filesContext: filesWithContent,
  };
}

async function performAIReview(
  reviewContext: Awaited<ReturnType<typeof prepareReviewContext>>
) {
  const { prContext, repoContext, filesContext } = reviewContext;
  const aiReviewComments: ReviewComment[] = [];

  // Synchronous loop to not hit LLM API rate limits
  for (let index = 0; index < filesContext.length; index++) {
    const fileContext = filesContext[index];
    console.log(
      `Reviewing file ${index + 1}/${filesContext.length}:`,
      fileContext.file.to
    );
    const { file, content } = fileContext;
    const prompt = createReviewPrompt(prContext, repoContext, file, content);
    // console.debug(prompt);
    const aiResponse = await callModel(prompt);
    const comments = parseAIResponse(aiResponse, file.to);
    console.log(`Left ${comments.length} comments`);
    console.debug(comments);
    aiReviewComments.push(...comments);
  }

  return aiReviewComments;
}

async function run() {
  try {
    const prContext = await getPRContext();
    const reviewContext = await prepareReviewContext(prContext);

    // Perform AI review
    const aiReviewComments = await performAIReview(reviewContext);

    // Submit review comments to GitHub
    if (aiReviewComments.length > 0) {
      await submitReviewComments(prContext, aiReviewComments);
      console.log(`Submitted ${aiReviewComments.length} review comments`);
    } else {
      console.log("No review comments to submit");
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
