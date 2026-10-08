import { readProject, documentStatus } from "../project-workflow/project.js";
import { discoverRepository } from "./repository.js";
export const LIVE_BLOCK_REASON =
  "Subscription-only spending cannot currently be enforced for ChatGPT login";
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
      nativeProvider: "macOS 0.161.0 local-transport conformance verified; live billing blocked",
      checks: "macOS single-process checks only",
    },
  };
}
