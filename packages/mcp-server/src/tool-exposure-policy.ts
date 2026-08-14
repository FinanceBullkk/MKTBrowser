export const MCP_TOOL_EXPOSURE = {
  get_runtime_info: "runtime-read",
  list_profiles: "profile-read",
  create_profile: "profile-write",
  update_profile: "profile-write",
  list_fingerprint_options: "fingerprint-read",
  launch_managed_profile: "profile-lifecycle",
  launch_profile: "profile-lifecycle",
  close_profile: "profile-lifecycle",
  navigate: "page-control",
  click: "page-control",
  type: "page-control",
  extract: "page-read",
  screenshot: "page-read",
  evaluate_js: "page-control",
  wait_for_selector: "page-read",
  list_tabs: "page-read",
  activate_tab: "page-control",
  close_tab: "page-control",
  wait_for_navigation: "page-read",
  wait_for_load: "page-read",
  cdp_send: "raw-cdp",
  get_cookies: "cookie-read",
  set_cookies: "cookie-write",
  new_tab: "page-control",
} as const;

export type McpToolName = keyof typeof MCP_TOOL_EXPOSURE;
export type McpToolCapability = (typeof MCP_TOOL_EXPOSURE)[McpToolName];

export interface McpToolAccessPolicy {
  readonly name: string;
  readonly capabilities: readonly McpToolCapability[];
}

/** The token discovered by MKTTool Relay can manage profiles but cannot inspect or drive pages. */
export const PROFILE_MANAGEMENT_ACCESS_POLICY: McpToolAccessPolicy = {
  name: "profile-management",
  capabilities: [
    "runtime-read",
    "profile-read",
    "profile-write",
    "fingerprint-read",
    "profile-lifecycle",
  ],
};

/** Explicit local clients may opt into the complete surface; HTTP tokens never receive this by default. */
export const FULL_LOCAL_ACCESS_POLICY: McpToolAccessPolicy = {
  name: "full-local",
  capabilities: [...new Set(Object.values(MCP_TOOL_EXPOSURE))],
};

export function isClassifiedMcpTool(name: string): name is McpToolName {
  return Object.hasOwn(MCP_TOOL_EXPOSURE, name);
}

export function isMcpToolAllowed(name: string, policy: McpToolAccessPolicy): boolean {
  return isClassifiedMcpTool(name) && policy.capabilities.includes(MCP_TOOL_EXPOSURE[name]);
}

export function assertMcpToolInventory(definitionNames: readonly string[]): void {
  const definitions = new Set(definitionNames);
  if (definitions.size !== definitionNames.length) {
    throw new Error("MCP tool definitions contain duplicate names.");
  }

  const classified = Object.keys(MCP_TOOL_EXPOSURE);
  const missing = definitionNames.filter((name) => !isClassifiedMcpTool(name));
  const stale = classified.filter((name) => !definitions.has(name));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `MCP exposure inventory mismatch (missing: ${missing.join(", ") || "none"}; stale: ${stale.join(", ") || "none"}).`,
    );
  }
}
