import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import parseDiff, { File as DiffFile } from "parse-diff";
import { ReviewComment } from "./types";

const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
const octokit = new Octokit({ auth: GITHUB_TOKEN });

export async function getDiff(
  owner: string,
  repo: string,
  pull_number: number,
  action: string
) {
  // Do a full diff on new PRs, but do an incremental diff on updates
  if (action === "opened") {
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
      mediaType: { format: "diff" },
    });
    return response.data;
  } else if (action === "synchronize") {
    const { data: eventData } = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
    });
    const newBaseSha = eventData.base.sha;
    const newHeadSha = eventData.head.sha;

    const response = await octokit.repos.compareCommits({
      owner,
      repo,
      base: newBaseSha,
      head: newHeadSha,
      mediaType: { format: "diff" },
    });
    return response.data;
  } else {
    console.log("Unsupported event:", action);
    return null;
  }
}

export async function getPRContext() {
  const context = github.context;
  const { owner, repo } = context.repo;
  const pull_number = context.payload.pull_request?.number;
  const action = context.payload.action;

  if (!pull_number) {
    throw new Error("This action can only be run on pull requests");
  }

  if (!action) {
    throw new Error("Unable to determine pull request action");
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number,
  });
  const diff = await getDiff(owner, repo, pull_number, action);
  const parsedDiff = parseDiff(String(diff));
  // Only include files that have a diff
  const files = parsedDiff
    .filter((file): file is DiffFile & { to: string } => file.to !== undefined)
    .map((file) => ({
      filename: file.to,
      status: file.deleted ? "removed" : file.new ? "added" : "modified",
    }));

  return { pr, files, parsedDiff, owner, repo, pull_number };
}

export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string
) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    if ("content" in data) {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
  } catch (error) {
    console.error(`Error fetching file content for ${path}:`, error);
  }
  return null;
}

export async function getRepoContext(owner: string, repo: string) {
  const readmeContent =
    (await getFileContent(owner, repo, "README.md", "main")) || "";
  const packageJsonContent =
    (await getFileContent(owner, repo, "package.json", "main")) || "";

  return { readmeContent, packageJsonContent };
}

export async function submitReviewComments(
  prContext: Awaited<ReturnType<typeof getPRContext>>,
  aiReviewComments: ReviewComment[]
) {
  await octokit.rest.pulls.createReview({
    owner: prContext.owner,
    repo: prContext.repo,
    pull_number: prContext.pull_number,
    event: "COMMENT",
    comments: aiReviewComments,
  });
}
