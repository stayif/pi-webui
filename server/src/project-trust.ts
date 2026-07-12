import {
  ProjectTrustStore,
  SettingsManager,
  hasTrustRequiringProjectResources,
  type LoadExtensionsResult,
  type ProjectTrustContext,
  type ProjectTrustHandler,
} from "@earendil-works/pi-coding-agent";

export interface ProjectTrustStatus {
  trusted: boolean;
  /**
   * Project resources exist, so Pi must first load user/global extensions and
   * give their project_trust handlers a chance to decide.
   */
  needsResolution: boolean;
  /** A browser decision is needed only after extension/saved/default fallbacks. */
  needsPrompt: boolean;
}

export interface ExtensionProjectTrustResult {
  trusted: boolean;
  remember: boolean;
}

/**
 * Resolve the non-interactive part of Pi's project-trust policy. Callers only
 * prompt when an otherwise unknown project has opted into project-local Pi
 * resources and the user's global setting is "ask".
 */
export function getProjectTrustStatus(
  cwd: string,
  agentDir: string,
  trustStore: ProjectTrustStore,
): ProjectTrustStatus {
  if (!hasTrustRequiringProjectResources(cwd)) {
    return { trusted: true, needsResolution: false, needsPrompt: false };
  }

  const saved = trustStore.get(cwd);
  if (saved !== null) {
    // Pi evaluates trusted user/global extensions before this fallback. Runtime
    // creation therefore still performs a pre-trust extension pass.
    return { trusted: saved, needsResolution: true, needsPrompt: false };
  }

  // Project settings must not influence the decision to trust the project.
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  switch (settings.getDefaultProjectTrust()) {
    case "always":
      return { trusted: true, needsResolution: true, needsPrompt: false };
    case "never":
      return { trusted: false, needsResolution: true, needsPrompt: false };
    case "ask":
      return { trusted: false, needsResolution: true, needsPrompt: true };
  }

  return { trusted: false, needsResolution: true, needsPrompt: true };
}

/**
 * Mirrors Pi's public project_trust handler contract without importing its
 * private runner helper. These extensions were loaded in the safe pre-trust
 * pass, so project-local code is still excluded here.
 */
export async function resolveExtensionProjectTrust(
  cwd: string,
  extensionsResult: LoadExtensionsResult,
  onError: (message: string) => void,
): Promise<ExtensionProjectTrustResult | undefined> {
  const event = { type: "project_trust" as const, cwd };
  const context: ProjectTrustContext = {
    cwd,
    // WebUI can show its own trust confirmation, but it does not implement
    // extension-owned selectors/dialogs during bootstrap.
    mode: "json",
    hasUI: false,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
    },
  };

  for (const extension of extensionsResult.extensions) {
    const handlers = extension.handlers.get("project_trust");
    if (!handlers) continue;

    for (const handler of handlers) {
      try {
        const result = await (handler as ProjectTrustHandler)(event, context);
        if (result?.trusted === "undecided" || result == null) continue;
        if (result.trusted === "yes" || result.trusted === "no") {
          return { trusted: result.trusted === "yes", remember: result.remember === true };
        }
        onError(`Extension \"${extension.path}\" returned an invalid project_trust decision.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(`Extension \"${extension.path}\" project_trust error: ${message}`);
      }
    }
  }

  return undefined;
}
