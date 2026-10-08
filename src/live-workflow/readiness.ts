import { readProject, documentStatus } from "../project-workflow/project.js";
import { discoverRepository } from "./repository.js";
export const LIVE_BLOCK_REASON =
  "Connect a ChatGPT plan account and review its credits-off setting in an owner terminal before supervised coding";
/** Read-only discovery: does not inspect credentials, run a model, or mutate Git state. */
export function inspectProject(workspace: string) {
  const repository = discoverRepository(workspace);
  const project = readProject(repository.root);
  return {
    project: {
      id: project.projectId,
      name: project.name,
      preferences: project.preferences,
    },
    repository,
    documents: documentStatus(repository.root, project),
    liveCodingEnabled: false as const,
    supervisedCodingAvailable: process.platform === 'darwin',
    accountSettingsVerified: false,
    blockers: [
      LIVE_BLOCK_REASON,
      ...(repository.dirtyPaths.length
        ? [
            "Source checkout has uncommitted files; reconcile before isolated task execution",
          ]
        : []),
    ],
    implementation: {
      repositoryAdapter: "fixture-verified",
      generatedPlanAndCoding: "fixture-verified",
      review: "fixture-verified",
      recording: "fixture-verified; reviewed evidence-branch adapter; actual delivery unverified",
      draftPullRequest: "fixture-verified; GitHub publication unverified",
      nativeProvider: "macOS 0.161.0; supervised ChatGPT-plan route requires sign-in and owner account settings review; fixture conformance verified",
      checks: "macOS single-process checks only",
    },
  };
}
